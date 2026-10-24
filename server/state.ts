import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { type BotState, BotStateSchema, type StateSnapshot } from "../shared/bot";
import {
  applyOperation,
  assertOperationCapacity,
  checkedReceipt,
  completeOperation,
  type Operation,
  type OperationChange,
  type OperationOutcome,
  type OperationScope,
} from "../shared/changes/operation";
import type { ApplicationReceipt } from "../shared/changes/receipt";
import { pluginDataPath } from "./bot-home";
import { publishDurableExclusive, readParsed, UnsupportedFileVersionError, writeAtomic } from "./files";

// Versions 1 and 2 predate fields that older plugins can't read: policies (v1) and managed execution (v2).
// An older reader that writes back strips the fields it doesn't know, which silently drops managed opt-ins.
// Before the first version 3 write, the source is copied to `<state>.v<N>.bak` (N = 1 or 2) with its SHA-256
// in `<state>.v<N>.bak.sha256`. Backups are no-replace: a mismatched, partial or digest-divergent existing
// backup refuses before the source is touched. Future versions stay in place and throw; malformed files
// keep readParsed's set-aside behavior.
const VERSION = 3;
const EnvelopeSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(VERSION)]),
  values: z.unknown(),
});

export type StateWrite = ({ status: "saved" } & StateSnapshot) | { status: "conflict"; error: string };

export interface OperationResult {
  status: OperationOutcome["status"];
  receipt: OperationOutcome["receipt"];
  snapshot: StateSnapshot;
}

type Listener = (snapshot: StateSnapshot) => void;

/** Receipts, pending pins and policies are host-owned; whole-state writes cannot forge or drop them. */
function withHostOwned(current: BotState, next: BotState): BotState {
  const { receipts: _receipts, pendingOperations: _pending, policies: _policies, ...rest } = next;
  return {
    ...rest,
    ...(current.receipts ? { receipts: current.receipts } : {}),
    ...(current.pendingOperations ? { pendingOperations: current.pendingOperations } : {}),
    ...(current.policies ? { policies: current.policies } : {}),
  };
}

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

/** The resulting receipt revision is derived, so only that field is excluded from content identity. */
function stateRevision(values: BotState): string {
  const normalized = {
    ...values,
    ...(values.receipts
      ? {
          receipts: values.receipts.map(({ newRevision: _derived, ...receipt }) => receipt),
        }
      : {}),
  };
  return sha256(JSON.stringify({ version: VERSION, values: normalized }));
}

type Parsed = { current: StateSnapshot } | { legacy: { raw: string; values: BotState; version: number } };

function parse(raw: string): Parsed {
  const decoded = JSON.parse(raw);
  if (typeof decoded?.version === "number" && decoded.version > VERSION)
    throw new UnsupportedFileVersionError(decoded.version);
  const envelope = EnvelopeSchema.parse(decoded);
  const values = BotStateSchema.parse(envelope.values);
  return envelope.version === VERSION
    ? { current: { revision: stateRevision(values), values } }
    : { legacy: { raw, values, version: envelope.version } };
}

/** Where a config file of an older version is kept before it moves to the current version. */
export function configBackupPath(statePath: string, version: number): string {
  return `${statePath}.v${version}.bak`;
}

/** Bots, teams and the library. Writes run one at a time; `write` saves only over the revision it names. */
export class BotStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  constructor(readonly path = join(pluginDataPath(), "state.json")) {}

  read(): Promise<StateSnapshot> {
    return this.serial(() => this.load());
  }

  write(revision: string, values: BotState): Promise<StateWrite> {
    return this.serial(async () => {
      const current = await this.load();
      if (current.revision !== revision)
        return { status: "conflict", error: "Bots changed elsewhere. Reload before saving again." };
      return { status: "saved", ...(await this.persist(withHostOwned(current.values, values))) };
    });
  }

  /**
   * Changes host-owned policy definitions over the revision it read. `change` preserves receipts and
   * pending-operation pins; throwing refuses the transaction before any write.
   */
  edit(revision: string, change: (values: BotState) => BotState): Promise<StateWrite> {
    return this.serial(async () => {
      const current = await this.load();
      if (current.revision !== revision)
        return { status: "conflict", error: "Bots changed elsewhere. Reload before saving again." };
      const next = change(current.values);
      const owned = withHostOwned(current.values, next);
      return { status: "saved", ...(await this.persist({ ...owned, policies: next.policies })) };
    });
  }

  /** Reads, changes and saves in one step, so no other write lands in between. */
  update(change: (values: BotState) => BotState): Promise<StateSnapshot> {
    return this.serial(async () => {
      const { values } = await this.load();
      return this.persist(withHostOwned(values, change(values)));
    });
  }

  /**
   * The one way to make a change that must happen once however often it is asked for: the changes and
   * their receipt reach disk in one write, and an operation whose receipt is already there changes nothing.
   * Concurrent calls with one id run in turn, so only the first applies. `run` throws to refuse, and then
   * nothing is saved.
   */
  apply(
    operation: Operation,
    run: (values: BotState, scope: OperationScope) => OperationChange | Promise<OperationChange>,
  ): Promise<OperationResult> {
    return this.serial(async () => {
      const current = await this.load();
      const earlier = checkedReceipt(current.values, operation);
      if (earlier) return { status: "replayed", receipt: earlier, snapshot: current };
      assertOperationCapacity(current.values);
      const change = await run(current.values, {
        now: operation.at,
        operationId: operation.id,
        revision: current.revision,
      });
      const outcome = applyOperation(current.values, operation, () => change);
      if (change.fleet) outcome.receipt.originalRevision = current.revision;
      const snapshot = await this.persist(outcome.values);
      const receipt = snapshot.values.receipts?.find((entry) => entry.operationId === operation.id);
      if (!receipt) throw new Error(`Operation ${operation.id} has no persisted receipt.`);
      return { status: outcome.status, receipt, snapshot };
    });
  }

  /** Keep configuration writes queued until publication has compared the current state and live file. */
  reconcileOperation(
    operation: Operation,
    reconcile: (values: BotState, receipt: ApplicationReceipt) => Promise<void>,
  ): Promise<void> {
    return this.serial(async () => {
      const { values } = await this.load();
      const receipt = checkedReceipt(values, operation);
      if (!receipt) throw new Error(`Operation ${operation.id} has no receipt.`);
      await reconcile(values, receipt);
    });
  }

  /** Release only after the caller's acceptance mark is durable; a crash before this is safe to retry. */
  completeOperation(operation: Operation): Promise<StateSnapshot> {
    return this.serial(async () => {
      const current = await this.load();
      const values = completeOperation(current.values, operation);
      return values === current.values ? current : this.persist(values);
    });
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async load(): Promise<StateSnapshot> {
    const parsed = await readParsed(this.path, parse);
    if (!parsed) return { revision: "missing", values: BotStateSchema.parse({}) };
    return "current" in parsed ? parsed.current : this.migrate(parsed.legacy);
  }

  /** Back up first with a no-replace publish; the version-3 write comes last so a crash leaves the source whole. */
  private async migrate({
    raw,
    values,
    version,
  }: {
    raw: string;
    values: BotState;
    version: number;
  }): Promise<StateSnapshot> {
    const backup = configBackupPath(this.path, version);
    const digest = sha256(raw);
    await publishDurableExclusive(backup, raw, 0o600);
    if (sha256(await readFile(backup, "utf8")) !== digest)
      throw new Error(`paseo-bots: the backup ${backup} doesn't match ${this.path}; not migrating it.`);
    await publishDurableExclusive(`${backup}.sha256`, `${digest}  ${basename(backup)}\n`, 0o600);
    return this.persist(values);
  }

  private async persist(values: BotState): Promise<StateSnapshot> {
    const parsed = BotStateSchema.parse(values);
    const revision = stateRevision(parsed);
    for (const receipt of parsed.receipts ?? [])
      if (receipt.originalRevision && !receipt.newRevision) receipt.newRevision = revision;
    const raw = JSON.stringify({ version: VERSION, values: parsed });
    await writeAtomic(this.path, raw, 0o600);
    const snapshot = { revision, values: parsed };
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
}
