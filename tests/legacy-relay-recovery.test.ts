import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareChat } from "../server/chats";
import { BotsHost } from "../server/host";
import { LocalChatStarts } from "../server/local-starts";
import { Relay } from "../server/relay";
import { RunCoordinator } from "../server/run-coordinator";
import { RunStore } from "../server/run-store";
import { BotStore } from "../server/state";
import { askBot } from "../server/tools/bots";
import type { Bot } from "../shared/bot";
import { newUuid } from "../shared/uuid";
import { connectFakeDaemon, type FakeDaemon } from "./fake-daemon";
import { makeBot } from "./helpers";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

let home: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "paseo-legacy-relay-recovery-"));
  process.env.PASEO_HOME = home;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  delete process.env.PASEO_HOME;
  await rm(home, { recursive: true, force: true });
});

interface Harness {
  daemon: FakeDaemon;
  config: BotStore;
  host: BotsHost;
  relay: Relay;
  coordinator: RunCoordinator;
  starts: LocalChatStarts;
}

async function harness(bot: Bot): Promise<Harness> {
  const daemon = await connectFakeDaemon({ creationLifecycle: true, agentRequestReceipts: true });
  const config = new BotStore(join(home, "state.json"));
  await config.update((values) => ({ ...values, bots: [bot] }));
  const host = new BotsHost(config);
  const relay = new Relay(host, [askBot]);
  const store = new RunStore(join(home, "routines.json"));
  const coordinator = new RunCoordinator(host, relay, { reconcileIntervalMs: 60_000, store });
  const starts = new LocalChatStarts(host, relay, coordinator, { creationWaitMs: 2_000 });
  host.bindChatStarts(starts);
  host.attach(daemon.api);
  await coordinator.ready();
  cleanups.push(async () => {
    starts.stop();
    await coordinator.stop();
    await relay.stop();
    await daemon.close();
  });
  return { daemon, config, host, relay, coordinator, starts };
}

/** Posts one JSON-RPC message with the Authorization value the agent's MCP config carries. */
async function rpc(
  url: string,
  authorization: string,
  message: unknown,
): Promise<{ status: number; text: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
  const target = new URL(url);
  const req = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        connection: "close",
      },
    },
    (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    },
  );
  req.on("error", reject);
  req.end(JSON.stringify(message));
  return promise;
}

function toolNames(text: string): string[] {
  const body = JSON.parse(text) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((tool) => tool.name);
}

/** Reads the real mount that production admission produced for one chat. */
async function firstMount(spy: MockInstance<Relay["mountPrepared"]>) {
  const [first] = spy.mock.results;
  if (!first) throw new Error("Expected admission to mount the relay");
  const plugin = (await first.value) as {
    tools?: { type: string; url: string; headers: Record<string, string> };
  };
  if (plugin.tools?.type !== "http") throw new Error("Expected the relay to mount an http server");
  return { url: plugin.tools.url, authorization: plugin.tools.headers.Authorization ?? "" };
}

const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("legacy prepared relay cold restoration", () => {
  it("keeps a legacy chat's admitted contact grant after the bot broadens and the relay restarts cold", async () => {
    const bot = makeBot({ executionMode: "legacy", contactBots: "off", cwd: "/work" });
    const h = await harness(bot);
    const mounted = vi.spyOn(h.relay, "mountPrepared");

    const created = await h.starts.create({ botId: bot.id, requestId: "request-1", prompt: "Do the task" });
    expect(created).toMatchObject({ mode: "legacy" });
    const target = await firstMount(mounted);

    const before = await rpc(target.url, target.authorization, list);
    expect(before.status).toBe(200);
    expect(toolNames(before.text)).toEqual([]);

    await h.config.update((values) => ({
      ...values,
      bots: values.bots.map((current) =>
        current.id === bot.id ? { ...current, contactBots: "allow" } : current,
      ),
    }));
    await h.relay.stop();

    const recovered = new Relay(h.host, [askBot]);
    cleanups.push(() => recovered.stop());
    await recovered.start();

    const cold = await rpc(target.url, target.authorization, list);
    expect(cold.status).toBe(200);
    expect(toolNames(cold.text)).toEqual([]);
  });

  it("keeps originally allowed contact available after a cold restart under unchanged current authorization", async () => {
    const bot = makeBot({ executionMode: "legacy", contactBots: "allow", cwd: "/work" });
    const h = await harness(bot);
    const mounted = vi.spyOn(h.relay, "mountPrepared");

    await h.starts.create({ botId: bot.id, requestId: "request-2", prompt: "Do the task" });
    const target = await firstMount(mounted);

    const before = await rpc(target.url, target.authorization, list);
    expect(before.status).toBe(200);
    expect(toolNames(before.text)).toContain("ask_bot");

    await h.relay.stop();

    const recovered = new Relay(h.host, [askBot]);
    cleanups.push(() => recovered.stop());
    await recovered.start();

    const cold = await rpc(target.url, target.authorization, list);
    expect(cold.status).toBe(200);
    expect(toolNames(cold.text)).toContain("ask_bot");
  });

  it("keeps the default managed mount refused cold after restart", async () => {
    const bot = makeBot({ executionMode: "managed", contactBots: "allow", cwd: "/work" });
    const h = await harness(bot);
    const agentId = newUuid();
    const mounted = vi.spyOn(h.relay, "mountPrepared");

    await prepareChat(h.host, h.relay, bot, {
      agentId,
      idempotencyKey: `paseo-bots:${agentId}`,
      prompt: "Do the task",
      title: "Inbox",
      labels: {},
      purpose: "task",
    } as never);
    const target = await firstMount(mounted);

    const before = await rpc(target.url, target.authorization, list);
    expect(before.status).toBe(200);

    await h.relay.stop();
    const recovered = new Relay(h.host, [askBot]);
    cleanups.push(() => recovered.stop());
    await recovered.start();

    const cold = await rpc(target.url, target.authorization, list);
    expect(cold.status).toBe(401);
  });
});
