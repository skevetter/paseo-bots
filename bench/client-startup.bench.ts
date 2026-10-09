import { test, vi } from "vitest";
import { report } from "./report";

// React Native and the host SDK only exist inside Paseo's app; any export of these stubs is a no-op.
vi.mock("react-native", () => namespace());
vi.mock("@getpaseo/plugin/client/react-native", () => namespace());
vi.mock("@getpaseo/plugin/client/ui", () => namespace());

function anything(): unknown {
  const target = function stub() {};
  const proxy: unknown = new Proxy(target, {
    get: (_target, key) => (key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : proxy),
    apply: () => proxy,
    construct: () => proxy as object,
  });
  return proxy;
}

function namespace(): Record<string, unknown> {
  const stub = anything();
  return new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : stub), has: () => true });
}

const loadStarted = performance.now();
// Dynamic on purpose: times the first, cold load of the plugin's client.
await import("../index.client");
process.stdout.write(`client startup: cold import ${(performance.now() - loadStarted).toFixed(1)} ms\n`);

test("client startup", async ({ bench }) => {
  await report(
    "client startup (React Native and the SDK stubbed)",
    [
      bench("import index.client.tsx (fresh module graph)", async () => {
        vi.resetModules();
        // Dynamic on purpose: each run evaluates the plugin's module graph again.
        await import("../index.client");
      }),
    ],
    { iterations: 30, time: 0 },
  );
});
