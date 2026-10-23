import { describe, expect, it } from "vitest";
import { startChat } from "../server/chats";
import { BotsHost } from "../server/host";
import { Relay } from "../server/relay";
import { type Bot, type BotState, EMPTY_LIBRARY } from "../shared/bot";
import { type ChatApi, startBotChat } from "../shared/chat";
import { PolicySchema, unsetOverrides } from "../shared/policies";
import { defined, makeBot, NOW, useTempPaseoHome } from "./helpers";
import { LIVE_PROVIDERS } from "./provider-modes";

interface LaunchConfig {
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
}

function harness(values: BotState) {
  const configs: LaunchConfig[] = [];
  const workspace = {
    current: () => ({ projectId: "fixture", projectRootPath: "/work", workspaceDirectory: "/work" }),
    refresh: async () => ({ projectId: "fixture", projectRootPath: "/work", workspaceDirectory: "/work" }),
    setTitle: async () => undefined,
    archive: async () => undefined,
    agents: {
      create: async ({ config }: { config: LaunchConfig }) => {
        configs.push(config);
        return { id: `chat-${configs.length}` };
      },
    },
  };
  const api = {
    config: { get: async () => ({ config: {} }) },
    projects: { list: async () => ({ projects: [] }) },
    workspaces: {
      list: async () => ({ entries: [] }),
      ref: () => workspace,
      open: async () => workspace,
      create: async () => workspace,
    },
    providers: { snapshot: async () => ({ entries: LIVE_PROVIDERS }) },
  };
  const host = new BotsHost({ read: async () => ({ revision: "r", values }) } as never);
  host.attach(api as never);
  return { api: api as ChatApi, host, configs };
}

function policyState(bot: Bot): BotState {
  return {
    bots: [bot],
    history: [],
    globalPolicy: { policyId: "pol-work", revision: null },
    policies: [
      PolicySchema.parse({
        id: "pol-work",
        revision: 1,
        createdAt: NOW,
        name: "Work",
        roles: { executor: { provider: "claude", model: "policy-model", thinkingOptionId: "high" } },
      }),
    ],
  };
}

const settings = (config: LaunchConfig) => ({
  provider: config.provider,
  modeId: config.modeId ?? null,
  thinkingOptionId: config.thinkingOptionId ?? null,
});

describe("chat launch policy resolution", () => {
  useTempPaseoHome("paseo-policy-chat-");

  it("uses the same policy settings from the client entrypoint and server startChat", async () => {
    const bot = unsetOverrides(makeBot({ provider: "claude", model: "old", modeId: "acceptEdits" }), [
      "provider",
    ]);
    const values = policyState(bot);
    const { api, host, configs } = harness(values);
    const relay = new Relay(host, []);
    try {
      await startBotChat(api, {
        bot,
        library: EMPTY_LIBRARY,
        policy: values,
        placement: { path: "/work", projectRoot: null },
        prompt: "p",
        systemPrompt: "s",
      });
      await startChat(host, relay, bot, { prompt: "p", title: "", labels: {} });
      const expected = { provider: "claude/policy-model", modeId: "acceptEdits", thinkingOptionId: "high" };
      expect(settings(defined(configs[0]))).toEqual(expected);
      expect(settings(defined(configs[1]))).toEqual(expected);
    } finally {
      await relay.stop();
    }
  });

  it("uses provider defaults and the original bot settings when no policy exists", async () => {
    const bot = makeBot({ provider: "claude", model: null, modeId: "acceptEdits", thinkingOptionId: "max" });
    const values: BotState = { bots: [bot], history: [] };
    const { api, configs } = harness(values);
    await startBotChat(api, {
      bot,
      policy: values,
      library: EMPTY_LIBRARY,
      placement: { path: "/work", projectRoot: null },
      prompt: "p",
      systemPrompt: "s",
    });
    expect(settings(defined(configs[0]))).toEqual({
      provider: "claude/opus",
      modeId: "acceptEdits",
      thinkingOptionId: "max",
    });
  });
});

describe("routine launch permissions", () => {
  useTempPaseoHome("paseo-policy-routine-chat-");

  it("applies routine execution overrides and narrowed approval through the server path", async () => {
    const base = makeBot({
      provider: "claude",
      model: "old",
      modeId: "bypassPermissions",
      routines: [
        {
          id: "rt",
          name: "Review",
          prompt: "Check",
          enabled: true,
          schedule: { kind: "webhook" },
          createdAt: NOW,
          resultsChatId: null,
          overrides: { model: "routine-model" },
          modeId: "default",
        },
      ],
    });
    const bot = unsetOverrides(base, ["model"]);
    const { host, configs } = harness(policyState(bot));
    const relay = new Relay(host, []);
    try {
      await startChat(host, relay, bot, { prompt: "p", title: "", labels: {}, routineId: "rt" });
      expect(settings(defined(configs[0]))).toEqual({
        provider: "claude/routine-model",
        modeId: "default",
        thinkingOptionId: "high",
      });
    } finally {
      await relay.stop();
    }
  });

  it("does not create a workspace or agent when a policy changes approval semantics", async () => {
    const bot = makeBot({
      provider: "claude",
      model: "old",
      modeId: null,
      routines: [
        {
          id: "rt",
          name: "Move",
          prompt: "Go",
          enabled: true,
          schedule: { kind: "webhook" },
          createdAt: NOW,
          resultsChatId: null,
          overrides: { provider: "omp" },
        },
      ],
    });
    const { api, configs } = harness({ bots: [bot], history: [] });
    await expect(
      startBotChat(api, {
        bot,
        policy: {},
        routineId: "rt",
        library: EMPTY_LIBRARY,
        placement: { path: "/work", projectRoot: null },
        prompt: "p",
        systemPrompt: "s",
      }),
    ).rejects.toThrow("approval semantics");
    expect(configs).toEqual([]);
  });
});
