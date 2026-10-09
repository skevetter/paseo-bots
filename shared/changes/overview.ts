import {
  type Bot,
  type BotDefaults,
  type BotGroup,
  type BotState,
  DEFAULT_BOT_DEFAULTS,
  EMPTY_LIBRARY,
  type Library,
} from "../bot";
import { teamMembers, teamOf } from "../groups";
import { mcpServerTested } from "../library";
import { describeSchedule } from "../routines";
import { BOT_TEMPLATES } from "../templates";
import type { AppAccountInfo, ProviderInfo } from "./context";
import { list } from "./describe";
import { findBot } from "./refs";

function teamPart(bot: Bot, groups: readonly BotGroup[]): string | null {
  const team = teamOf(bot.id, groups);
  if (!team) return null;
  return `team ${team.name}${team.leadId === bot.id ? " (Chief of Staff)" : ""}`;
}

function usesParts(bot: Bot, library: Library): (string | null)[] {
  const servers = bot.mcpServerIds.map(
    (id) => library.mcpServers.find((server) => server.id === id)?.name ?? id,
  );
  const routines = bot.routines.length;
  return [
    bot.skillIds.length ? `skills ${list(bot.skillIds)}` : null,
    servers.length ? `MCP servers ${list(servers)}` : null,
    bot.apps.length ? `apps ${list(bot.apps)}` : null,
    routines ? `${routines} routine${routines === 1 ? "" : "s"}` : null,
  ];
}

function botLine(bot: Bot, values: BotState): string {
  const parts = [
    [bot.provider || "no provider", bot.model ?? "default model", bot.modeId ? `mode ${bot.modeId}` : null]
      .filter(Boolean)
      .join(" · "),
    teamPart(bot, values.groups ?? []),
    ...usesParts(bot, values.library ?? EMPTY_LIBRARY),
    `contact other bots: ${bot.contactBots}`,
    bot.archived ? "archived" : null,
  ].filter(Boolean);
  return `- ${bot.name} (id ${bot.id})${bot.title ? `: ${bot.title}` : ""}. ${parts.join("; ")}.`;
}

function teamsSection(groups: readonly BotGroup[], names: ReadonlyMap<string, string>): string {
  const lines = groups.map((group) => {
    const members = teamMembers(group)
      .filter((id) => id !== group.leadId)
      .map((id) => names.get(id) ?? id);
    const lead = group.leadId ? (names.get(group.leadId) ?? group.leadId) : "none";
    return `- ${group.name} (id ${group.id}): Chief of Staff ${lead}; members ${list(members) || "none"}${group.instructions.trim() ? "; has shared instructions" : ""}.`;
  });
  return `Teams (${groups.length}):\n${lines.join("\n") || "- none"}`;
}

function skillsSection(skills: Library["skills"]): string {
  const lines = skills.map((skill) => {
    const state = skill.reviewedSha === null ? "needs review" : skill.enabled ? "on" : "off";
    return `- ${skill.id}: ${skill.description || "no description"} [${state}]`;
  });
  return `Library skills (${skills.length}):\n${lines.join("\n") || "- none"}`;
}

function serversSection(servers: Library["mcpServers"]): string {
  const lines = servers.map((server) => {
    const state = server.enabled ? "on" : mcpServerTested(server) ? "off" : "off, untested";
    return `- ${server.name}${server.description ? `: ${server.description}` : ""} [${state}]`;
  });
  return `Library MCP servers (${servers.length}):\n${lines.join("\n") || "- none"}`;
}

function appsSection(apps: readonly AppAccountInfo[] | null): string {
  if (!apps) return "Connected apps: not set up.";
  const lines = [...new Set(apps.map((account) => account.slug))].map(
    (slug) =>
      `- ${slug}: accounts ${list(apps.filter((account) => account.slug === slug).map((account) => account.names[0] ?? account.id))}`,
  );
  return `Connected apps:\n${lines.join("\n") || "- none"}`;
}

function providersSection(providers: readonly ProviderInfo[] | null): string {
  if (!providers) return "Providers: unknown right now.";
  const lines = providers.map((provider) => {
    const models = list(
      provider.models.map(
        (model) =>
          `${model.id}${model.isDefault ? " (default)" : ""}${model.thinking.length ? ` [thinking: ${list(model.thinking)}]` : ""}`,
      ),
    );
    const modes = list(
      provider.modes.map((mode) => `${mode.id}${mode.id === provider.defaultModeId ? " (default)" : ""}`),
    );
    return `- ${provider.id}: models ${models || "none"}; modes ${modes || "none"}`;
  });
  return `Providers:\n${lines.join("\n")}`;
}

export function defaultsText(defaults: BotDefaults): string {
  const overrides = Object.entries(defaults.modeByProvider).map(([provider, mode]) => `${provider} ${mode}`);
  return [
    `provider ${defaults.provider || "any ready one"}`,
    `model ${defaults.model ?? "default"}`,
    `thinking ${defaults.thinkingOptionId ?? "default"}`,
    `approval ${defaults.approval}${overrides.length ? ` (modes: ${list(overrides)})` : ""}`,
    `contact other bots: ${defaults.contactBots}`,
  ].join(", ");
}

export function setupOverview(
  values: BotState,
  providers: readonly ProviderInfo[] | null,
  apps: readonly AppAccountInfo[] | null,
): string {
  const library = values.library ?? EMPTY_LIBRARY;
  const defaults = values.defaults ?? DEFAULT_BOT_DEFAULTS;
  const byId = new Map(values.bots.map((bot) => [bot.id, bot.name]));
  const sections = [
    `Bots (${values.bots.length}):\n${values.bots.map((bot) => botLine(bot, values)).join("\n") || "- none"}`,
    teamsSection(values.groups ?? [], byId),
    skillsSection(library.skills),
    serversSection(library.mcpServers),
    appsSection(apps),
    `New bots start with: ${defaultsText(defaults)}.`,
    `Presets: ${list((values.presets ?? []).map((preset) => preset.name)) || "none"}.`,
    providersSection(providers),
    `Roles for new bots: ${list(BOT_TEMPLATES.map((template) => `${template.id} (${template.title})`))}.`,
  ];
  return sections.join("\n\n");
}

export function botDetails(values: BotState, ref: string): string {
  const bot = findBot(values, ref);
  const library = values.library ?? EMPTY_LIBRARY;
  const block = (title: string, text: string) => `${title}:\n${text.trim() || "(none)"}`;
  return [
    botLine(bot, values),
    block("Blurb", bot.description),
    block("Instructions (Soul)", bot.soul),
    block(
      "Playbooks",
      bot.playbooks
        .map(
          (playbook) =>
            `- ${playbook.name} (triggers: ${list(playbook.triggers)}):\n${playbook.instructions}`,
        )
        .join("\n\n"),
    ),
    block(
      "Routines",
      bot.routines
        .map(
          (routine) =>
            `- ${routine.name} (id ${routine.id}, ${routine.enabled ? describeSchedule(routine.schedule) : "paused"}):\n${routine.prompt}`,
        )
        .join("\n\n"),
    ),
    block(
      "MCP servers",
      bot.mcpServerIds
        .map((id) => library.mcpServers.find((server) => server.id === id)?.name ?? id)
        .join(", "),
    ),
    block("Tools allowed without asking", bot.alwaysAllow.join(", ")),
    block(
      "Connected apps",
      bot.apps
        .map((slug) => {
          const rule = bot.appRules[slug];
          return `${slug}${rule ? ` (tools: ${Array.isArray(rule.tools) ? list(rule.tools) : rule.tools}${rule.account ? "; one account" : ""})` : ""}`;
        })
        .join(", "),
    ),
    block("Working folder", bot.cwd ?? "its own folder in the Bots project"),
  ].join("\n\n");
}
