import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { type BotState, BotStateSchema, type StateSnapshot } from "../shared/bot";
import {
  applyOperation,
  checkedReceipt,
  completeOperation,
  type Operation,
  type OperationChange,
  type OperationOutcome,
  type OperationScope,
} from "../shared/changes/operation";
import type { ApplicationReceipt } from "../shared/changes/receipt";
import { pluginDataPath } from "./bot-home";
import { readParsed, writeAtomic } from "./files";

const VERSION = 1;
const EnvelopeSchema = z.object({ version: z.literal(VERSION), values: z.unknown() });

export type StateWrite = ({ status: "saved" } & StateSnapshot) | { status: "conflict"; error: string };

export interface OperationResult {
  status: OperationOutcome["status"];
  receipt: OperationOutcome["receipt"];
  snapshot: StateSnapshot;
}

type Listener = (snapshot: StateSnapshot) => void;

/** Receipts are the host's: a change or a client's whole-state write can neither forge nor drop them. */
function withReceiptsOf(current: BotState, next: BotState): BotState {
  const { receipts: _dropped, pendingOperations: _pending, ...rest } = next;
  return {
    ...rest,
    ...(current.receipts ? { receipts: current.receipts } : {}),
    ...(current.pendingOperations ? { pendingOperations: current.pendingOperations } : {}),
  };
}

function parse(raw: string): StateSnapshot {
  const envelope = EnvelopeSchema.parse(JSON.parse(raw));
  const revision = createHash("sha256").update(raw).digest("hex");
  return { revision, values: BotStateSchema.parse(envelope.values) };
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
      return { status: "saved", ...(await this.persist(withReceiptsOf(current.values, values))) };
    });
  }

  /** Reads, changes and saves in one step, so no other write lands in between. */
  update(change: (values: BotState) => BotState): Promise<StateSnapshot> {
    return this.serial(async () => {
      const { values } = await this.load();
      return this.persist(withReceiptsOf(values, change(values)));
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
    run: (values: BotState, scope: OperationScope) => OperationChange,
  ): Promise<OperationResult> {
    return this.serial(async () => {
      const current = await this.load();
      const outcome = applyOperation(current.values, operation, run);
      const snapshot = outcome.status === "replayed" ? current : await this.persist(outcome.values);
      return { status: outcome.status, receipt: outcome.receipt, snapshot };
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
    return (await readParsed(this.path, parse)) ?? { revision: "missing", values: BotStateSchema.parse({}) };
  }

  private async persist(values: BotState): Promise<StateSnapshot> {
    const raw = JSON.stringify({ version: VERSION, values: BotStateSchema.parse(values) });
    await writeAtomic(this.path, raw, 0o600);
    const snapshot = parse(raw);
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
}
