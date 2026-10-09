import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { turnEnded, turnStarted } from "./server/activity";
import { hostProviders, newBotStart } from "./server/apply-context";
import { ensureBotHome, ensureBotsHome, migrateRenamedPluginData } from "./server/bot-home";
import { CommandAllowlist } from "./server/commands";
import {
  accounts,
  status as appsStatus,
  appTools,
  catalog,
  connect,
  disconnect,
  removeKey,
  renameAccount,
  setKey,
} from "./server/composio";
import { controlPaths } from "./server/control/files";
import { ControlServer } from "./server/control/server";
import { followControlSetting } from "./server/control/switch";
import type { ControlContext } from "./server/control/tool";
import { CONTROL_TOOLS } from "./server/control/tools";
import { BotsHost } from "./server/host";
import { generateAvatar, imageStatus, removeImageKey, setImageKey } from "./server/images";
import { MemoryJournal } from "./server/journal";
import { deleteSkill, importSkills, migrateBotSkills, readSkill, writeSkill } from "./server/library";
import { probeMcpServer } from "./server/mcp-probe";
import { mcpSources } from "./server/mcp-sources";
import { deleteLogDay, listLogDays, listMemory, readLogDay, readMemory } from "./server/memory";
import { systemPrompt } from "./server/prompt";
import { acceptProposal, dismissProposal, getProposal, listProposals } from "./server/proposals";
import { Relay } from "./server/relay";
import { RoutineScheduler } from "./server/scheduler";
import { exportBot, exportTeam, importBot, importTeam } from "./server/share";
import { BotStore } from "./server/state";
import { BOT_TOOLS } from "./server/tools";
import { saveUpload } from "./server/uploads";
import { botSettings } from "./shared/bot";
import { shellCommand } from "./shared/commands";
import {
  appsAccountsRpc,
  appsCatalogRpc,
  appsConnectRpc,
  appsDisconnectRpc,
  appsRemoveKeyRpc,
  appsRenameRpc,
  appsSetKeyRpc,
  appsStatusRpc,
  appsToolsRpc,
  avatarGenerateRpc,
  avatarKeyStatusRpc,
  avatarRemoveKeyRpc,
  avatarSetKeyRpc,
  commandAllowRpc,
  commandListRpc,
  commandRemoveRpc,
  controlRotateRpc,
  controlStatusRpc,
  ensureBotHomeRpc,
  exportBotRpc,
  exportTeamRpc,
  helloRpc,
  importBotRpc,
  importTeamRpc,
  mcpProbeRpc,
  mcpSourcesRpc,
  memoryDeleteRpc,
  memoryJournalRpc,
  memoryListRpc,
  memoryLogDeleteRpc,
  memoryLogRpc,
  memoryReadRpc,
  memoryUndoRpc,
  memoryWriteRpc,
  mountRpc,
  proposalAcceptRpc,
  proposalDismissRpc,
  proposalGetRpc,
  proposalListRpc,
  routineRunNowRpc,
  routineStatusRpc,
  routineWebhookRpc,
  skillDeleteRpc,
  skillImportRpc,
  skillReadRpc,
  skillWriteRpc,
  stateReadRpc,
  stateWriteRpc,
  systemPromptRpc,
  uploadRpc,
} from "./shared/rpc";

interface ChatEventServices {
  host: BotsHost;
  journal: MemoryJournal;
  scheduler: RoutineScheduler;
  commands: CommandAllowlist;
}

function prepareData() {
  try {
    migrateRenamedPluginData();
  } catch (error) {
    console.error("paseo-bots: couldn't move the data of the old paseo-bot plugin", error);
  }
  void ensureBotsHome()
    .then(migrateBotSkills)
    .catch((error: unknown) => console.error("paseo-bots: couldn't prepare the Bots folder", error));
}

function handleMemory(server: PluginServerContext, journal: MemoryJournal) {
  server.handle(memoryListRpc, ({ botId }) => listMemory(botId));
  server.handle(memoryReadRpc, ({ botId, name }) => readMemory(botId, name));
  server.handle(memoryWriteRpc, async ({ botId, name, text }) => {
    await journal.write(botId, name, text);
    return { ok: true };
  });
  server.handle(memoryDeleteRpc, async ({ botId, name }) => {
    await journal.write(botId, name, null);
    return { ok: true };
  });
  server.handle(memoryJournalRpc, async ({ botId }) => ({ entries: await journal.rows(botId) }));
  server.handle(memoryUndoRpc, async ({ botId, id }) => {
    await journal.undo(botId, id);
    return { ok: true };
  });
  server.handle(memoryLogRpc, async ({ botId, day }) => ({
    ...(await listLogDays(botId)),
    text: day ? (await readLogDay(botId, day)).text : null,
  }));
  server.handle(memoryLogDeleteRpc, ({ botId, day }) => deleteLogDay(botId, day));
}

function handleSkillsAndApps(server: PluginServerContext) {
  server.handle(skillImportRpc, importSkills);
  server.handle(skillReadRpc, readSkill);
  server.handle(skillWriteRpc, writeSkill);
  server.handle(skillDeleteRpc, deleteSkill);
  server.handle(mcpProbeRpc, probeMcpServer);
  server.handle(mcpSourcesRpc, () => mcpSources());
  server.handle(avatarKeyStatusRpc, () => imageStatus());
  server.handle(avatarSetKeyRpc, setImageKey);
  server.handle(avatarRemoveKeyRpc, () => removeImageKey());
  server.handle(avatarGenerateRpc, generateAvatar);
  server.handle(appsStatusRpc, () => appsStatus());
  server.handle(appsSetKeyRpc, setKey);
  server.handle(appsRemoveKeyRpc, () => removeKey());
  server.handle(appsCatalogRpc, () => catalog());
  server.handle(appsAccountsRpc, accounts);
  server.handle(appsConnectRpc, connect);
  server.handle(appsDisconnectRpc, disconnect);
  server.handle(appsRenameRpc, renameAccount);
  server.handle(appsToolsRpc, appTools);
}

function handleChatEvents(
  server: PluginServerContext,
  { host, journal, scheduler, commands }: ChatEventServices,
) {
  server.on("agent.turn_started", async (event, context) => {
    host.attach(context.paseo);
    await turnStarted(host, journal, event).catch((error: unknown) =>
      console.error("paseo-bots: couldn't check memory before a turn", error),
    );
  });
  server.on("agent.permission_requested", async ({ agent, request }, context) => {
    host.attach(context.paseo);
    const shell = shellCommand(request, agent.cwd);
    if (!shell) return;
    const chat = await host.chatOf(agent.id);
    if (!chat || !(await commands.matches(chat.botId, shell.command, shell.cwd))) return;
    await context.paseo.agents
      .ref(agent.id)
      .respondToPermission({ requestId: request.id, response: { behavior: "allow" } })
      .catch((error: unknown) => console.error("paseo-bots: couldn't approve an allowed command", error));
  });
  server.on("agent.turn_ended", async (event, context) => {
    host.attach(context.paseo);
    await turnEnded(host, journal, scheduler, event).catch((error: unknown) =>
      console.error("paseo-bots: couldn't record a turn", error),
    );
  });
}

function handleControl(server: PluginServerContext, services: Omit<ControlContext, "settings">) {
  const settings = server.registerSettings(botSettings);
  const read = async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : botSettings.schema.parse({});
  };
  const control = new ControlServer({ ...services, settings: read }, CONTROL_TOOLS);
  const stop = followControlSetting(settings, control);
  server.handle(controlStatusRpc, () => ({
    url: control.url,
    tokenFile: controlPaths().tokenFile,
    command: controlPaths().shim,
  }));
  server.handle(controlRotateRpc, async () => {
    await control.rotate();
    return { ok: true };
  });
  return stop;
}

export default function contribute(server: PluginServerContext) {
  prepareData();
  const store = new BotStore();
  const host = new BotsHost(store);
  const relay = new Relay(host, BOT_TOOLS);
  void relay.start().catch((error: unknown) => console.error("paseo-bots: couldn't start the relay", error));
  const scheduler = new RoutineScheduler(host, relay);
  const journal = new MemoryJournal();
  const commands = new CommandAllowlist();
  const attach = ({ paseo }: PluginHandlerContext) => host.attach(paseo);

  server.handle(helloRpc, (_input, context) => {
    attach(context);
    return { scheduler: scheduler.running };
  });
  server.handle(stateReadRpc, (_input, context) => {
    attach(context);
    return store.read();
  });
  server.handle(stateWriteRpc, ({ revision, values }) => store.write(revision, values));
  server.handle(ensureBotHomeRpc, (input, context) => {
    attach(context);
    return ensureBotHome(input);
  });
  server.handle(systemPromptRpc, async (input, context) =>
    systemPrompt(input, await host.library(), context.paseo, await host.values()),
  );
  handleMemory(server, journal);
  handleSkillsAndApps(server);
  server.handle(mountRpc, async ({ botId, agentId }) => {
    const bot = await host.bot(botId);
    return {
      tools: await relay.mountTools(botId, agentId),
      apps: bot?.apps.length ? await relay.mountApps(botId) : null,
    };
  });
  server.handle(proposalGetRpc, async ({ id }) => ({ proposal: await getProposal(id) }));
  server.handle(proposalListRpc, async (filter) => ({ proposals: await listProposals(filter) }));
  server.handle(proposalAcceptRpc, async ({ id }, context) => {
    attach(context);
    return acceptProposal(id, { store, commands, providers: (await hostProviders(host)).providers });
  });
  server.handle(proposalDismissRpc, async ({ id }) => ({ proposal: await dismissProposal(id) }));
  server.handle(routineStatusRpc, (_input, context) => {
    attach(context);
    return scheduler.status();
  });
  server.handle(routineRunNowRpc, ({ botId, routineId }, context) => {
    attach(context);
    return scheduler.runNow(botId, routineId);
  });
  server.handle(routineWebhookRpc, ({ routineId, rotate }) => scheduler.webhookUrl(routineId, rotate));
  server.handle(commandListRpc, async ({ botId }) => ({ rules: await commands.list(botId) }));
  server.handle(commandAllowRpc, async ({ botId, command, cwd }) => ({
    rule: await commands.add(botId, command, cwd),
  }));
  server.handle(commandRemoveRpc, async ({ botId, id }) => ({ ok: await commands.remove(botId, id) }));
  server.handle(exportBotRpc, async (input) => exportBot(input, await host.library()));
  server.handle(importBotRpc, importBot);
  server.handle(exportTeamRpc, async (input) => exportTeam(input, await host.library()));
  server.handle(importTeamRpc, async (input, context) => {
    attach(context);
    return importTeam(input, await newBotStart(host));
  });
  server.handle(uploadRpc, saveUpload);
  handleChatEvents(server, { host, journal, scheduler, commands });
  const stopControl = handleControl(server, { host, relay, scheduler, journal, commands });

  return async () => {
    await Promise.all([scheduler.stop(), relay.stop(), stopControl()]);
  };
}
