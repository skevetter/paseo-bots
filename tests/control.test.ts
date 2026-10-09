import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { controlPaths } from "../server/control/files";
import { followControlSetting } from "../server/control/switch";
import { defineControlTool } from "../server/control/tool";
import { startControl } from "./control-helpers";
import { makeBot, useTempPaseoHome } from "./helpers";

const echo = defineControlTool({
  name: "echo",
  description: "Echoes.",
  input: z.object({ word: z.string() }),
  async run({ word }) {
    return { text: word, data: { word } };
  },
});

const running: { stop(): Promise<void> }[] = [];

async function control(...args: Parameters<typeof startControl>) {
  const started = await startControl(...args);
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.stop()));
});

describe("the control endpoint", () => {
  useTempPaseoHome("paseo-bots-control-");

  it("answers only requests that carry its own token", async () => {
    const { url, post } = await control([echo], { bots: [makeBot({ id: "bot-a" })] });
    const statuses = async (headers: Record<string, string>) =>
      (await fetch(url, { method: "POST", headers, body: "{}" })).status;
    expect(await statuses({})).toBe(401);
    expect(await statuses({ authorization: "Bearer nope" })).toBe(401);

    const listed = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body: { result: { tools: { name: string }[] } } = await listed.json();
    expect(body.result.tools).toEqual([expect.objectContaining({ name: "echo" })]);
    expect(
      (await post({ jsonrpc: "2.0", id: 2, method: "ping" }, { origin: "https://evil.example" })).status,
    ).toBe(403);
  });

  it("rejects a chat's relay token, and the relay doesn't serve control", async () => {
    const { url, token, context } = await control([echo], { bots: [makeBot({ id: "bot-a" })] });
    const chat = await context.relay.mountTools("bot-a", "11111111-1111-4111-8111-111111111111");
    const chatAuth = chat.type === "http" ? (chat.headers.Authorization ?? "") : "";
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(
      (await fetch(url, { method: "POST", headers: { authorization: chatAuth }, body: ping })).status,
    ).toBe(401);

    const relayRoot = chat.type === "http" ? new URL(chat.url).origin : "";
    const controlAuth = { authorization: `Bearer ${token}` };
    expect(
      (await fetch(`${relayRoot}/mcp`, { method: "POST", headers: controlAuth, body: ping })).status,
    ).toBe(404);
    const chatUrl = chat.type === "http" ? chat.url : "";
    expect((await fetch(chatUrl, { method: "POST", headers: controlAuth, body: ping })).status).toBe(401);
  });

  it("returns text and structured data, and stops taking the old token once rotated", async () => {
    const { call, post, server } = await control([echo]);
    expect(await call("echo", { word: "hi" })).toEqual({ text: "hi", data: { word: "hi" }, isError: false });
    await server.rotate();
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });

  it("listens only while External control is on", async () => {
    const { server, url } = await control([echo]);
    await server.stop();
    let on = false;
    const listeners = new Set<() => void>();
    const settings = {
      read: async () => ({ status: "ready" as const, values: { externalControl: on, allowElevated: false } }),
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    const flip = (value: boolean) => {
      on = value;
      for (const listener of listeners) listener();
    };
    const stop = followControlSetting(settings, server);
    await expect(fetch(url)).rejects.toThrow();
    await expect(readFile(controlPaths().infoFile, "utf8")).rejects.toThrow();

    flip(true);
    await vi.waitFor(async () => expect(server.url).not.toBeNull());
    const info = JSON.parse(await readFile(controlPaths().infoFile, "utf8")) as {
      url: string;
      tokenFile: string;
    };
    expect(info).toEqual({ url: server.url, tokenFile: controlPaths().tokenFile });
    const live = info.url;
    expect((await fetch(live, { method: "POST", body: "{}" })).status).toBe(401);

    flip(false);
    await vi.waitFor(async () => expect(server.url).toBeNull());
    await expect(fetch(live, { method: "POST", body: "{}" })).rejects.toThrow();
    await expect(readFile(controlPaths().infoFile, "utf8")).rejects.toThrow();
    await stop();
  });
});
