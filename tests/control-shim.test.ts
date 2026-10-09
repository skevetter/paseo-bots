import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { controlPaths } from "../server/control/files";
import { defineControlTool } from "../server/control/tool";
import { startControl } from "./control-helpers";
import { useTempPaseoHome } from "./helpers";

const echo = defineControlTool({
  name: "echo",
  description: "Echoes.",
  input: z.object({ word: z.string() }),
  async run({ word }) {
    return { text: word, data: { word } };
  },
});

function shim() {
  const child = spawn("sh", [controlPaths().shim], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ask = async (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const { value } = await lines.next();
    return JSON.parse(String(value)) as { id: number; result?: unknown; error?: { message: string } };
  };
  return { ask, close: () => child.kill() };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("the stdio shim", () => {
  useTempPaseoHome("paseo-bots-shim-");

  it("proxies MCP lines to the endpoint control.json names, and says when it's off", async () => {
    const control = await startControl([echo]);
    cleanups.push(control.stop);
    const client = shim();
    cleanups.push(client.close);

    const hello = await client.ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(hello).toMatchObject({ id: 1, result: { serverInfo: { name: "paseo-bots-control" } } });
    expect(
      await client.ask({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { word: "hi" } },
      }),
    ).toMatchObject({ id: 2, result: { structuredContent: { word: "hi" } } });

    await control.server.rotate();
    expect(await client.ask({ jsonrpc: "2.0", id: 3, method: "ping" })).toMatchObject({ id: 3, result: {} });

    await control.server.stop();
    const off = await client.ask({ jsonrpc: "2.0", id: 4, method: "ping" });
    expect(off.error?.message).toContain("External control");
  });
});
