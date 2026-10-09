import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { type BotState, BotStateSchema, type StateSnapshot } from "../shared/bot";
import { pluginDataPath } from "./bot-home";
import { readParsed, writeAtomic } from "./files";

const VERSION = 1;
const EnvelopeSchema = z.object({ version: z.literal(VERSION), values: z.unknown() });

export type StateWrite = ({ status: "saved" } & StateSnapshot) | { status: "conflict"; error: string };

type Listener = (snapshot: StateSnapshot) => void;

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
      if ((await this.load()).revision !== revision)
        return { status: "conflict", error: "Bots changed elsewhere. Reload before saving again." };
      return { status: "saved", ...(await this.persist(values)) };
    });
  }

  /** Reads, changes and saves in one step, so no other write lands in between. */
  update(change: (values: BotState) => BotState): Promise<StateSnapshot> {
    return this.serial(async () => this.persist(change((await this.load()).values)));
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
