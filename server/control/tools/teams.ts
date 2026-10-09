import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { plural } from "../../../shared/activity";
import { type Bot, type BotGroup, type BotState, EMPTY_LIBRARY, type TeamLogo } from "../../../shared/bot";
import { describeChange } from "../../../shared/changes/describe";
import { findBot, findTeam } from "../../../shared/changes/refs";
import { type Change, LogoInput } from "../../../shared/changes/schema";
import { importElevations } from "../../../shared/elevated";
import { groupBots, teamLogoOf } from "../../../shared/groups";
import { addImportedBots } from "../../../shared/library";
import { applyContext } from "../../apply-context";
import { createProposal } from "../../proposals";
import { exportBot, exportTeam, importTeam } from "../../share";
import type { ToolResult } from "../../tools/mcp";
import {
  applyOrPropose,
  BotRef,
  Confirm,
  type ControlContext,
  type ControlTool,
  defineControlTool,
  needsApproval,
  pendingResult,
  result,
} from "../tool";

const TeamRef = z.string().min(1).max(100).describe("The team's name or id.");
const TeamName = z.string().min(1).max(60);
const Bots = z.array(BotRef).max(50);
const Instructions = z
  .string()
  .max(20_000)
  .describe("Shared instructions added to every member's prompt. Only the user edits them in the app.");
const AbsolutePath = z.string().min(1).max(4_096).refine(isAbsolute, "Use an absolute path.");
/** The app's import RPC takes files up to this size. */
const MAX_IMPORT_CHARS = 20_000_000;

interface NamedBot {
  id: string;
  name: string;
}

interface TeamView {
  id: string;
  name: string;
  lead: NamedBot | null;
  /** The lead first, then the others; archived bots are left out. */
  members: NamedBot[];
  instructions: string;
  logo: TeamLogo;
}

function teamView(group: BotGroup, bots: readonly Bot[]): TeamView {
  const { lead, members } = groupBots(group, bots);
  const named = (bot: Bot): NamedBot => ({ id: bot.id, name: bot.name });
  return {
    id: group.id,
    name: group.name,
    lead: lead ? named(lead) : null,
    members: [...(lead ? [lead] : []), ...members].map(named),
    instructions: group.instructions,
    logo: teamLogoOf(group),
  };
}

function teamLine(team: TeamView): string {
  const members = team.members.map((bot) => bot.name).join(", ") || "no bots";
  return `${team.name} (${team.id}): lead ${team.lead?.name ?? "none"}; ${plural(team.members.length, "member")}: ${members}.`;
}

async function changeTeam(
  context: ControlContext,
  change: Change,
  done: (values: BotState) => ToolResult,
): Promise<ToolResult> {
  const outcome = await applyOrPropose(context, describeChange(change), [change]);
  return outcome.status === "pending" ? outcome.result : done(outcome.values);
}

function savedTeam(values: BotState, teamId: string): ToolResult {
  const group = (values.groups ?? []).find((entry) => entry.id === teamId);
  if (!group) throw new Error("The team was saved, then changed before it could be read back.");
  const team = teamView(group, values.bots);
  return result(`Saved team ${teamLine(team)}`, { status: "applied", team });
}

const teamsList = defineControlTool({
  name: "teams_list",
  description:
    "List the teams with their Chief of Staff (lead), members and shared instructions. A bot is on one team at most.",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  async run(_input, context) {
    const values = await context.host.values();
    const teams = (values.groups ?? []).map((group) => teamView(group, values.bots));
    return result(teams.map(teamLine).join("\n") || "There are no teams.", { teams });
  },
});

const teamsCreate = defineControlTool({
  name: "teams_create",
  description:
    "Create a team. Adding a bot takes it off its other team. The lead is the user's main contact and hands work to the others.",
  input: z.object({
    name: TeamName,
    lead: BotRef.optional().describe("Its Chief of Staff; added to the members."),
    members: Bots.optional().describe("The team's bots."),
    instructions: Instructions.optional(),
    logo: LogoInput.optional(),
  }),
  async run(input, context) {
    // A new team is saved last, so it's the last group once applied.
    return changeTeam(context, { type: "create_team", ...input }, (values) =>
      savedTeam(values, values.groups?.at(-1)?.id ?? ""),
    );
  },
});

const teamsUpdate = defineControlTool({
  name: "teams_update",
  description:
    "Change a team's name, lead, members, shared instructions or logo. Adding a bot takes it off its other team.",
  input: z.object({
    team: TeamRef,
    name: TeamName.optional(),
    lead: BotRef.nullable().optional().describe("Its Chief of Staff, added to the members; null for none."),
    add_members: Bots.optional(),
    remove_members: Bots.optional(),
    instructions: Instructions.optional().describe("Replaces the shared instructions."),
    logo: LogoInput.optional(),
  }),
  async run({ team, ...fields }, context) {
    const { id } = findTeam(await context.host.values(), team);
    return changeTeam(context, { type: "update_team", team: id, ...fields }, (values) =>
      savedTeam(values, id),
    );
  },
});

const teamsDelete = defineControlTool({
  name: "teams_delete",
  description: "Delete a team. Its bots stay, without a team.",
  input: z.object({ team: TeamRef, confirm: Confirm }),
  annotations: { destructiveHint: true },
  async run({ team }, context) {
    const group = findTeam(await context.host.values(), team);
    return changeTeam(context, { type: "delete_team", team: group.id }, () =>
      result(`Deleted team ${group.name}. Its bots stay, without a team.`, {
        status: "applied",
        team: { id: group.id, name: group.name },
      }),
    );
  },
});

function chosenBots(values: BotState, refs: readonly string[] | undefined): Bot[] {
  if (!refs) return values.bots.filter((bot) => !bot.archived);
  return [...new Map(refs.map((ref) => findBot(values, ref)).map((bot) => [bot.id, bot])).values()];
}

const FileEntry = z.object({ bot: z.object({ name: z.string() }) });
/** A team file holds `bots`; a bot file is one entry. */
const ExportedFile = z.union([z.object({ bots: z.array(FileEntry) }), FileEntry]);

function fileBotNames(json: string): string[] {
  const file = ExportedFile.parse(JSON.parse(json));
  return "bots" in file ? file.bots.map((entry) => entry.bot.name) : [file.bot.name];
}

const botsExport = defineControlTool({
  name: "bots_export",
  description:
    "Export bots to a file another Paseo can import. One bot gives a bot file; several give a team file that keeps their teams. Routines are paused and MCP env and header values are redacted; chats, keys, folders, tool grants and connected apps stay behind.",
  input: z.object({
    bots: Bots.min(1).optional().describe("The bots to export. Defaults to every bot that isn't archived."),
    include_memory: z
      .boolean()
      .default(false)
      .describe("Include MEMORY.md and topic files. Leave off when sharing with someone else."),
    path: AbsolutePath.optional().describe("Write the file to this absolute path instead of returning it."),
  }),
  async run({ bots: refs, include_memory: includeMemory, path }, context) {
    const values = await context.host.values();
    const bots = chosenBots(values, refs);
    const [only] = bots;
    if (!only) throw new Error("There are no bots to export.");
    const library = values.library ?? EMPTY_LIBRARY;
    const kind = bots.length === 1 ? "bot" : "team";
    const { json } =
      kind === "bot"
        ? await exportBot({ bot: only, includeMemory }, library)
        : await exportTeam({ bots, groups: values.groups ?? [], includeMemory }, library);
    const names = fileBotNames(json);
    const what = `${kind === "bot" ? "Bot" : "Team"} file with ${plural(names.length, "bot")} (${names.join(", ")})`;
    if (!path) return result(`${what}:\n${json}`, { kind, bots: names, json });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, json, "utf8");
    return result(`${what} saved to ${path}.`, { kind, bots: names, path });
  },
});

async function importFile(path: string): Promise<string> {
  if ((await stat(path)).size > MAX_IMPORT_CHARS)
    throw new Error("That file is too big to be a paseo-bots export.");
  return readFile(path, "utf8");
}

function teamsText(teams: readonly { name: string }[]): string {
  return teams.length
    ? ` and ${plural(teams.length, "team")} (${teams.map((team) => team.name).join(", ")})`
    : "";
}

const botsImport = defineControlTool({
  name: "bots_import",
  description: `Add the bots and teams in a bot or team file, as Settings > Bots > Team file does. Imports only add: a name already in use gets a number. Routines arrive paused, skills need a review, and MCP servers wait switched off. A file that brings MCP servers waits for approval unless "Allow elevated" is on.`,
  input: z
    .object({
      json: z.string().min(1).max(MAX_IMPORT_CHARS).optional().describe("The file's JSON."),
      path: AbsolutePath.optional().describe("An absolute path to the file, instead of json."),
    })
    .refine(
      (input) => (input.json === undefined) !== (input.path === undefined),
      "Give exactly one of json or path.",
    ),
  async run({ json, path }, context) {
    const imported = await importTeam({ json: path ? await importFile(path) : (json ?? "") });
    const values = await context.host.values();
    const reasons = importElevations(values, imported, (await applyContext(context.host)).modes);
    const incoming = imported.bots.map((entry) => entry.bot.name).join(", ");
    if (await needsApproval(context, reasons)) {
      const summary = `Import ${plural(imported.bots.length, "bot")} (${incoming})${teamsText(imported.teams)}`;
      const proposal = await createProposal({
        botId: "",
        agentId: "",
        origin: "control",
        kind: "import",
        data: { summary, bots: imported.bots, teams: imported.teams },
      });
      return pendingResult(proposal, reasons);
    }
    const saved = await context.host.store.update((current) =>
      addImportedBots(current, imported.bots, imported.teams),
    );
    const ids = new Set(imported.bots.map((entry) => entry.bot.id));
    const bots = saved.values.bots
      .filter((bot) => ids.has(bot.id))
      .map((bot) => ({ id: bot.id, name: bot.name }));
    return result(
      `Added ${plural(bots.length, "bot")} (${bots.map((bot) => bot.name).join(", ")})${teamsText(imported.teams)}. Routines arrive paused, skills need a review, and MCP servers wait switched off in Skills & Tools.`,
      { status: "applied", bots, teams: imported.teams.map((team) => team.name) },
    );
  },
});

export const TEAM_TOOLS: readonly ControlTool[] = [
  teamsList,
  teamsCreate,
  teamsUpdate,
  teamsDelete,
  botsExport,
  botsImport,
];
