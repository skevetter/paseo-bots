import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterAll, test, vi } from "vitest";
import { report } from "./report";

const home = mkdtempSync(join(tmpdir(), "paseo-bots-bench-"));
process.env.PASEO_HOME = home;

function fakeServer() {
  const recorded = { handlers: 0 };
  const settings = { read: async () => ({ status: "loading" as const }) };
  const count = () => {
    recorded.handlers += 1;
  };
  const server = {
    registerSettings: () => settings,
    handle: count,
    on: count,
  } as unknown as PluginServerContext;
  return { server, recorded };
}

const stops: Array<() => Promise<void>> = [];
const probe = fakeServer();
const loadStarted = performance.now();
// Dynamic on purpose: times the first, cold load of the plugin, as the host does it.
const { default: contribute } = await import("../index.server");
const imported = performance.now();
stops.push(contribute(probe.server));
const ready = performance.now();
process.stdout.write(
  `startup: cold import ${(imported - loadStarted).toFixed(1)} ms, first contribute() ${(ready - imported).toFixed(2)} ms, ${probe.recorded.handlers} handlers registered synchronously\n`,
);

afterAll(async () => {
  await Promise.all(stops.map((stop) => stop()));
  rmSync(home, { recursive: true, force: true });
});

test("server startup", async ({ bench }) => {
  await report(
    "server startup",
    [
      bench("import index.server.ts (fresh module graph)", async () => {
        vi.resetModules();
        // Dynamic on purpose: each run evaluates the plugin's module graph again.
        await import("../index.server");
      }),
      bench("contribute() until handlers are registered", () => {
        stops.push(contribute(fakeServer().server));
      }),
    ],
    { iterations: 30, time: 0 },
  );
});
