/// <reference lib="es2024.promise" />
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoundedHostCalls, HostCallUncertainError } from "../server/run-deadlines";

let directory: string;
let calls: BoundedHostCalls;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-bounded-host-abort-"));
  calls = new BoundedHostCalls(25);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
  calls.close();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe("bounded host operation lifetime", () => {
  it.each(["timeout", "shutdown"] as const)(
    "prevents a guarded external effect after %s without poisoning unrelated live work",
    async (reason) => {
      const gate = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const effect = join(directory, "abandoned-effect");
      const pending = calls.run(async (signal) => {
        try {
          await gate.promise;
          if (signal.aborted) throw new Error("Abandoned operation cannot issue an external effect.");
          await writeFile(effect, "external effect happened");
          return "created";
        } finally {
          finished.resolve();
        }
      }, "guarded operation");
      const outcome = pending.then(
        (value) => ({ kind: "created" as const, value }),
        (error: unknown) => ({ kind: "uncertain" as const, error }),
      );
      if (reason === "shutdown") calls.close();
      else await vi.advanceTimersByTimeAsync(25);
      const settled = await outcome;
      expect(settled.kind).toBe("uncertain");
      if (settled.kind === "uncertain") expect(settled.error).toBeInstanceOf(HostCallUncertainError);
      gate.resolve();
      await finished.promise;
      await expect(readFile(effect)).rejects.toMatchObject({ code: "ENOENT" });

      const fresh = join(directory, "fresh-effect");
      const next = () =>
        calls.run(async (signal) => {
          if (signal.aborted) throw new Error("Closed operation cannot issue an external effect.");
          await writeFile(fresh, "fresh operation");
          return "created";
        }, "fresh operation");
      if (reason === "shutdown") {
        await expect(next()).rejects.toBeInstanceOf(HostCallUncertainError);
        await expect(readFile(fresh)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await next()).toBe("created");
        expect(await readFile(fresh, "utf8")).toBe("fresh operation");
      }
    },
  );
});
