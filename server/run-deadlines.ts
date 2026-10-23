import type { RoutineRun } from "../shared/rpc";

export function deadlineOf(run: RoutineRun): number {
  const managed = run.managed;
  if (!managed) return Infinity;
  const reserved = managed.firstReservedAt;
  const wall =
    reserved !== null && reserved !== undefined && managed.maxRunSeconds
      ? reserved + managed.maxRunSeconds * 1000
      : Infinity;
  return Math.min(managed.deadlineAt ?? Infinity, wall);
}

export function expireBeforeLaunch(run: RoutineRun, now: number): boolean {
  if (now < deadlineOf(run)) return false;
  if (run.executionStatus !== "queued" && run.executionStatus !== "reserved") return false;
  run.executionStatus = "canceled";
  run.taskOutcome = "no_change";
  run.error = "Execution deadline expired before launch; no new agent was started.";
  run.endedAt = new Date(now).toISOString();
  if (run.managed) {
    run.managed.reservation = false;
    run.managed.launchIntent = false;
  }
  return true;
}

export class HostCallUncertainError extends Error {}

/** Abandoning a wait never asserts that the host call or its external effects stopped. */
export class BoundedHostCalls {
  private readonly abandoners = new Set<() => void>();
  private closed = false;
  constructor(private readonly timeoutMs: number) {}

  run<T>(call: (signal: AbortSignal) => Promise<T>, description: string): Promise<T> {
    if (this.closed)
      return Promise.reject(new HostCallUncertainError("Host dispatch is permanently closed."));
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const abandon = () => {
        cleanup();
        const failure = new HostCallUncertainError(
          `${description} was not confirmed within the bounded host wait; reconcile before any retry.`,
        );
        controller.abort();
        reject(failure);
      };
      const timer = setTimeout(abandon, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.abandoners.delete(abandon);
      };
      this.abandoners.add(abandon);
      let pending: Promise<T>;
      try {
        pending = call(controller.signal);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      pending.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  close(): void {
    this.closed = true;
    for (const abandon of [...this.abandoners]) abandon();
  }
}
