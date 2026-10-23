import type { RoutineRun } from "../shared/rpc";
import { isTerminal } from "../shared/runs";

export type CreationWaitResult =
  | { status: "created"; agentId: string; run: RoutineRun }
  | { status: "pending"; run: RoutineRun }
  | { status: "not_created"; run: RoutineRun };

/** A chosen UUID is an intention; only a host acknowledgement/snapshot establishes creation. */
export class CreationWaits {
  private readonly listeners = new Set<(expired: boolean) => Promise<void>>();
  private closed = false;
  constructor(
    private readonly get: (id: string) => Promise<RoutineRun | null>,
    private readonly timeoutMs: number,
  ) {}

  signal(): void {
    for (const listener of this.listeners) void listener(false);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.listeners].map((listener) => listener(true)));
  }

  wait(id: string, options: { timeoutMs?: number } = {}): Promise<CreationWaitResult> {
    const timeout = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout < 0)
      throw new Error("Creation wait timeout must be a nonnegative safe integer.");
    if (this.closed) throw new Error("Creation wait service is stopped.");
    return new Promise<CreationWaitResult>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      const check = async (expired: boolean) => {
        try {
          const result = await this.decision(id, expired);
          if (!settled && result) {
            cleanup();
            resolve(result);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        void check(true);
      }, timeout);
      this.listeners.add(check);
      void check(timeout === 0);
    });
  }

  private async decision(id: string, expired: boolean): Promise<CreationWaitResult | null> {
    const run = await this.get(id);
    if (!run) throw new Error("Run not found.");
    if (run.managed?.hostCreatedAt !== undefined && run.agentId)
      return { status: "created", agentId: run.agentId, run };
    if (isTerminal(run.executionStatus) && run.taskOutcome === "no_change")
      return { status: "not_created", run };
    return expired || isTerminal(run.executionStatus) ? { status: "pending", run } : null;
  }
}
