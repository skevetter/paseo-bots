import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { pluginDataPath } from "../server/bot-home";
import { defineControlTool } from "../server/control/tool";
import { Relay } from "../server/relay";
import { defineTool } from "../server/tools/mcp";
import { newUuid } from "../shared/uuid";
import { startControl } from "./control-helpers";
import { fakeHost, makeBot, useTempPaseoHome } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("relay unload effect boundary", () => {
  useTempPaseoHome("relay-unload-effects-");

  it("does not begin a tool effect after a suspended authorization completes following close", async () => {
    const entered = deferred<void>();
    const available = deferred<boolean>();
    const effect = join(pluginDataPath(), "late-effect");
    const tool = defineTool({
      name: "ask_bot",
      description: "Inert filesystem effect fixture",
      input: z.object({}),
      available: async () => {
        void entered.resolve();
        return available.promise;
      },
      run: async () => {
        writeFileSync(effect, "effect dispatched");
        return "recorded";
      },
    });
    const bot = makeBot();
    const relay = new Relay(fakeHost([bot]), [tool]);
    try {
      const mount = await relay.mountTools(bot.id, newUuid());
      if (mount.type !== "http") throw new Error("Expected an HTTP relay");
      const request = fetch(mount.url, {
        method: "POST",
        headers: { ...mount.headers, "content-type": "application/json", connection: "close" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ask_bot", arguments: {} },
        }),
      }).catch(() => null);
      await entered.promise;
      await relay.close();
      available.resolve(true);
      await nextTurn();
      await request;
      expect(existsSync(effect)).toBe(false);
    } finally {
      available.resolve(false);
      await relay.close();
    }
  });
});

describe("control restart effect boundary", () => {
  useTempPaseoHome("control-restart-effects-");

  it("refuses an old suspended call after restart while permitting the new server's call", async () => {
    const entered = deferred<void>();
    const available = deferred<boolean>();
    const effect = join(pluginDataPath(), "control-effect");
    const tool = defineControlTool({
      name: "record_effect",
      description: "Inert control filesystem fixture",
      input: z.object({ value: z.string() }),
      available: async () => {
        entered.resolve();
        return available.promise;
      },
      run: async ({ value }) => {
        writeFileSync(effect, value);
        return "recorded";
      },
    });
    const control = await startControl([tool]);
    const message = (value: string) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "record_effect", arguments: { value } },
    });
    try {
      const old = control.post(message("old")).catch(() => null);
      await entered.promise;
      await control.server.stop();
      const currentUrl = await control.server.start();
      available.resolve(true);
      await nextTurn();
      await old;
      expect(existsSync(effect)).toBe(false);
      const current = await fetch(currentUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${control.token}`,
          "content-type": "application/json",
          connection: "close",
        },
        body: JSON.stringify(message("current")),
      });
      await current.json();
      expect(readFileSync(effect, "utf8")).toBe("current");
    } finally {
      available.resolve(false);
      await control.stop();
    }
  });
});
