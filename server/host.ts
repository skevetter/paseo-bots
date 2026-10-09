import { BOT_LABEL, type Bot, type BotState, EMPTY_LIBRARY, type Library } from "../shared/bot";
import { ROUTINE_LABEL } from "../shared/chat";
import type { PaseoApi } from "./paseo";
import type { BotStore } from "./state";

// The SDK only hands out the Paseo API inside RPC handlers and lifecycle hooks, so it's captured
// the first time one runs (the app calls `bots.hello` on start) and features wait for it.

type Listener = (paseo: PaseoApi) => void;

export class BotsHost {
  private api: PaseoApi | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(readonly store: Pick<BotStore, "read" | "update">) {}

  attach(paseo: PaseoApi): void {
    if (this.api === paseo) return;
    this.api = paseo;
    for (const listener of this.listeners) listener(paseo);
  }

  onAttach(listener: Listener): void {
    this.listeners.add(listener);
    if (this.api) listener(this.api);
  }

  get paseo(): PaseoApi | null {
    return this.api;
  }

  requirePaseo(): PaseoApi {
    if (!this.api) throw new Error("Open Paseo once since the daemon started, then try again.");
    return this.api;
  }

  async values(): Promise<BotState> {
    return (await this.store.read()).values;
  }

  async library(): Promise<Library> {
    return (await this.values()).library ?? EMPTY_LIBRARY;
  }

  async bots(): Promise<Bot[]> {
    return (await this.values()).bots;
  }

  async bot(botId: string): Promise<Bot | null> {
    return (await this.bots()).find((bot) => bot.id === botId) ?? null;
  }

  private readonly chatBots = new Map<string, string | null>();

  async chatOf(agentId: string): Promise<{
    botId: string;
    title: string | null;
    routineId: string | null;
    labels: Record<string, string>;
  } | null> {
    if (this.chatBots.get(agentId) === null) return null;
    const snapshot = await this.paseo?.agents
      .ref(agentId)
      .refresh()
      .catch(() => null);
    if (!snapshot) return null;
    const botId = snapshot.agent.labels?.[BOT_LABEL] ?? null;
    if (this.chatBots.size > 500) this.chatBots.clear();
    this.chatBots.set(agentId, botId);
    const labels = snapshot.agent.labels ?? {};
    return botId
      ? { botId, title: snapshot.agent.title ?? null, routineId: labels[ROUTINE_LABEL] ?? null, labels }
      : null;
  }

  async botIdOf(agentId: string): Promise<string | null> {
    const known = this.chatBots.get(agentId);
    return known !== undefined ? known : ((await this.chatOf(agentId))?.botId ?? null);
  }
}
