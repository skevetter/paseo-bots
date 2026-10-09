import type { z } from "zod";
import { describeSchedule, type ScheduleInput, scheduleFrom } from "../routines";
import { BOT_TEMPLATES } from "../templates";
import { oneLine } from "./fields";
import type { AppInputValue, AvatarInput, BotFieldValues, Change, ChangeOf } from "./schema";

export const list = (items: readonly string[]) => items.join(", ");

function appText(entry: AppInputValue): string {
  const tools =
    !entry.tools || entry.tools === "all"
      ? ""
      : entry.tools === "read"
        ? " (read-only tools)"
        : ` (${list(entry.tools)})`;
  return `${entry.app}${tools}${entry.account ? " with one account" : ""}`;
}

function agentText(fields: BotFieldValues): string[] {
  const parts: string[] = [];
  if (fields.provider !== undefined) parts.push(`provider ${fields.provider}`);
  if (fields.model !== undefined) parts.push(fields.model ? `model ${fields.model}` : "the default model");
  if (fields.mode !== undefined)
    parts.push(fields.mode ? `approval mode ${fields.mode}` : "the default approval mode");
  if (fields.thinking !== undefined)
    parts.push(fields.thinking ? `thinking ${fields.thinking}` : "default thinking");
  return parts;
}

function profileText(fields: BotFieldValues): string[] {
  const parts: string[] = [];
  if (fields.title !== undefined) parts.push(`title "${oneLine(fields.title)}"`);
  if (fields.description !== undefined) parts.push("a new blurb");
  if (fields.instructions !== undefined) parts.push("new instructions");
  return parts;
}

function avatarText(avatar: z.infer<typeof AvatarInput>): string {
  if (avatar.image_url) return "a picture";
  return avatar.image_url === null ? "the pixel face back" : "a different face";
}

function settingsText(fields: BotFieldValues): string[] {
  const parts: string[] = [];
  if (fields.contact_bots !== undefined)
    parts.push(
      {
        ask: "asks before contacting other bots",
        allow: "contacts other bots freely",
        off: "doesn't contact other bots",
      }[fields.contact_bots],
    );
  if (fields.avatar) parts.push(avatarText(fields.avatar));
  if (fields.working_folder !== undefined)
    parts.push(fields.working_folder ? `working folder ${fields.working_folder}` : "its own working folder");
  if (fields.pinned !== undefined) parts.push(fields.pinned ? "pinned" : "unpinned");
  return parts;
}

function fieldsText(fields: BotFieldValues): string[] {
  return [...profileText(fields), ...agentText(fields), ...settingsText(fields)];
}

function scheduleText(input: z.infer<typeof ScheduleInput>): string {
  try {
    return describeSchedule(scheduleFrom(input, new Date()));
  } catch {
    return input.type;
  }
}

function listPart(label: string, items: readonly string[] | undefined, suffix = ""): string[] {
  return items?.length ? [`${label} ${list(items)}${suffix}`] : [];
}

function createBotText(change: ChangeOf<"create_bot">): string {
  const start = change.role
    ? [`starts as ${BOT_TEMPLATES.find((template) => template.id === change.role)?.title ?? change.role}`]
    : change.preset
      ? [`starts from preset ${change.preset}`]
      : [];
  const parts = [
    ...start,
    ...fieldsText(change),
    ...listPart("skills", change.skills),
    ...listPart("MCP servers", change.mcp_servers),
    ...listPart("apps", change.apps?.map(appText)),
    ...listPart(
      "playbooks",
      change.playbooks?.map((playbook) => playbook.name),
    ),
  ];
  return `**New bot ${oneLine(change.name)}**${parts.length ? `: ${parts.join("; ")}` : ""}`;
}

function updateBotText(change: ChangeOf<"update_bot">): string {
  const parts = [
    ...(change.name !== undefined ? [`renamed to ${oneLine(change.name)}`] : []),
    ...fieldsText(change),
    ...(change.archived !== undefined ? [change.archived ? "archived" : "unarchived"] : []),
    ...listPart("turns on skills", change.add_skills),
    ...listPart("turns off skills", change.remove_skills),
    ...listPart("turns on MCP servers", change.add_mcp_servers),
    ...listPart("turns off MCP servers", change.remove_mcp_servers),
    ...listPart("may use", change.add_apps?.map(appText)),
    ...listPart("no longer uses", change.remove_apps),
    ...listPart("uses", change.allow_tools, " without asking"),
    ...listPart("asks again before", change.disallow_tools),
    ...listPart(
      "playbooks",
      change.add_playbooks?.map((playbook) => playbook.name),
    ),
    ...listPart("removes playbooks", change.remove_playbooks),
  ];
  return `**${change.bot}**: ${parts.join("; ") || "no changes"}`;
}

function updateRoutineText(change: ChangeOf<"update_routine">): string {
  const parts = [
    ...(change.name !== undefined ? [`renamed to "${change.name}"`] : []),
    ...(change.instructions !== undefined ? ["new instructions"] : []),
    ...(change.schedule ? [scheduleText(change.schedule)] : []),
    ...(change.enabled !== undefined ? [change.enabled ? "resumed" : "paused"] : []),
  ];
  return `**${change.bot}**: routine "${change.routine}" ${parts.join("; ") || "unchanged"}`;
}

function createTeamText(change: ChangeOf<"create_team">): string {
  const members = (change.members ?? []).filter((member) => member !== change.lead);
  const parts = [
    ...(change.lead ? [`led by ${change.lead}`] : []),
    ...listPart("with", members),
    ...(change.instructions?.trim() ? ["shared instructions"] : []),
  ];
  return `**New team ${oneLine(change.name)}**${parts.length ? `: ${parts.join("; ")}` : ""}`;
}

function updateTeamText(change: ChangeOf<"update_team">): string {
  const parts = [
    ...(change.name !== undefined ? [`renamed to ${oneLine(change.name)}`] : []),
    ...(change.lead !== undefined ? [change.lead ? `led by ${change.lead}` : "no Chief of Staff"] : []),
    ...listPart("adds", change.add_members),
    ...listPart("removes", change.remove_members),
    ...(change.instructions !== undefined ? ["new shared instructions"] : []),
    ...(change.logo ? ["a new logo"] : []),
  ];
  return `**Team ${change.team}**: ${parts.join("; ") || "no changes"}`;
}

const APPROVAL_TEXT = {
  provider: "each provider's default mode",
  ask: "a mode that asks first",
  unattended: "a mode that runs without asking",
} as const;

function setDefaultsText(change: ChangeOf<"set_defaults">): string {
  const parts = [
    ...agentText(change),
    ...(change.approval ? [`approval: ${APPROVAL_TEXT[change.approval]}`] : []),
    ...Object.entries(change.mode_by_provider ?? {}).map(([provider, mode]) =>
      mode ? `${provider} in approval mode ${mode}` : `${provider} by the approval setting`,
    ),
    ...(change.contact_bots ? [`contact other bots: ${change.contact_bots}`] : []),
  ];
  return `**New bots start with** ${parts.join("; ") || "the same defaults"}`;
}

function defaultsWarnings(change: ChangeOf<"set_defaults">): string[] {
  return [
    ...(change.approval === "unattended" ? ["New bots start in a mode that runs without asking."] : []),
    ...Object.entries(change.mode_by_provider ?? {}).flatMap(([provider, mode]) =>
      mode ? [`New ${provider} bots start in approval mode "${mode}".`] : [],
    ),
  ];
}

export function describeChange(change: Change): string {
  switch (change.type) {
    case "create_bot":
      return createBotText(change);
    case "update_bot":
      return updateBotText(change);
    case "delete_bot":
      return `**Delete bot ${change.bot}**; its chats stay in Paseo's history`;
    case "add_routine":
      return `**${change.bot}**: new routine "${change.name}", ${scheduleText(change.schedule)}`;
    case "update_routine":
      return updateRoutineText(change);
    case "delete_routine":
      return `**${change.bot}**: delete routine "${change.routine}"`;
    case "create_team":
      return createTeamText(change);
    case "update_team":
      return updateTeamText(change);
    case "delete_team":
      return `**Delete team ${change.team}**; its bots stay, without a team`;
    case "set_skill":
      return `**Skill ${change.skill}**: ${change.enabled ? "on" : "off"} for every bot that uses it`;
    case "add_mcp_server":
      return `**New MCP server ${change.name}**: ${change.command ? `runs \`${[change.command, ...(change.args ?? [])].join(" ")}\`` : `connects to ${change.url}`}; off until it passes a test in Skills & Tools`;
    case "set_mcp_server":
      return `**MCP server ${change.server}**: ${change.enabled ? "on" : "off"}`;
    case "remove_mcp_server":
      return `**Remove MCP server ${change.server}** from Skills & Tools and every bot`;
    case "set_defaults":
      return setDefaultsText(change);
    case "save_preset":
      return `**Save ${change.bot} as a preset**`;
    case "delete_preset":
      return `**Delete preset ${change.preset}**`;
  }
}

function botWarnings(change: ChangeOf<"create_bot"> | ChangeOf<"update_bot">): string[] {
  const who = change.type === "create_bot" ? change.name : change.bot;
  const warnings: string[] = [];
  if (change.mode) warnings.push(`${who} runs in approval mode "${change.mode}".`);
  if (change.contact_bots === "allow") warnings.push(`${who} may ask other bots without asking you.`);
  if (change.type === "update_bot" && change.allow_tools?.length)
    warnings.push(`${who} may use ${list(change.allow_tools)} without asking you.`);
  const apps = change.type === "create_bot" ? change.apps : change.add_apps;
  if (apps?.length)
    warnings.push(`${who} may use ${list(apps.map((entry) => entry.app))} with your connected accounts.`);
  if (change.working_folder) warnings.push(`${who} works in ${change.working_folder}.`);
  return warnings;
}

function changeWarning(change: Change): string[] {
  switch (change.type) {
    case "create_bot":
    case "update_bot":
      return botWarnings(change);
    case "add_mcp_server":
      return change.command
        ? [`The ${change.name} MCP server runs a program on this computer once it's on.`]
        : [];
    case "delete_bot":
      return [`Deletes the bot ${change.bot}.`];
    case "delete_team":
      return [`Deletes the team ${change.team}.`];
    case "remove_mcp_server":
      return [`Removes the MCP server ${change.server}.`];
    case "set_defaults":
      return defaultsWarnings(change);
    default:
      return [];
  }
}

export function changeWarnings(changes: readonly Change[]): string[] {
  return changes.flatMap((change) => changeWarning(change));
}
