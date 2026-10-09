import { join } from "node:path";
import { pluginDataPath } from "../server/bot-home";
import { CommandAllowlist } from "../server/commands";
import { controlToken } from "../server/control/files";
import { ControlServer } from "../server/control/server";
import type { ControlContext, ControlTool } from "../server/control/tool";
import { BotsHost } from "../server/host";
import { MemoryJournal } from "../server/journal";
import { Relay } from "../server/relay";
import { RoutineScheduler } from "../server/scheduler";
import { BotStore } from "../server/state";
import type { Bot, BotState, ControlSettings } from "../shared/bot";

export interface CallResult {
  text: string;
  data: Record<string, unknown>;
  isError: boolean;
}

let stores = 0;

/** Runs a control server on a free port with a fresh state file; needs useTempPaseoHome. */
export async function startControl(
  tools: readonly ControlTool[],
  seed: Partial<BotState> & { bots?: Bot[] } = {},
  settings: Partial<ControlSettings> = {},
) {
  const store = new BotStore(join(pluginDataPath(), `control-state-${++stores}.json`));
  await store.update((values) => ({ ...values, ...seed }));
  const host = new BotsHost(store);
  const relay = new Relay(host, []);
  const toggles: ControlSettings = { externalControl: true, allowElevated: false, ...settings };
  const context: ControlContext = {
    host,
    relay,
    scheduler: new RoutineScheduler(host, relay),
    journal: new MemoryJournal(),
    commands: new CommandAllowlist(),
    settings: async () => toggles,
  };
  const server = new ControlServer(context, tools, 0);
  const url = await server.start();
  const token = await controlToken();
  let id = 0;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallResult> => {
    const response = await post({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const { result, error } = (await response.json()) as {
      result?: {
        content: { text: string }[];
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };
      error?: { message: string };
    };
    if (error) throw new Error(error.message);
    return {
      text: result?.content.map((block) => block.text).join("\n") ?? "",
      data: result?.structuredContent ?? {},
      isError: !!result?.isError,
    };
  };
  const stop = async () => {
    await Promise.all([server.stop(), context.scheduler.stop(), relay.stop()]);
  };
  return { url, token, post, call, context, store, toggles, server, stop };
}
