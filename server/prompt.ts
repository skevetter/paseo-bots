import { join } from "node:path";
import { recentWork } from "../shared/activity";
import type { AppAccount, PromptApp } from "../shared/apps";
import type { Bot, BotGroup, BotState, Library } from "../shared/bot";
import { botSkills } from "../shared/bot-agent";
import { composeSystemPrompt, type PromptContext, promptSections } from "../shared/bot-prompt";

import { teamOf, teamPrompt } from "../shared/groups";
import { type PaseoToolsConfig, paseoToolsState } from "../shared/paseo-tools";
import { selectPlaybooks } from "../shared/playbooks";
import { accounts, catalog, readState } from "./composio";
import { librarySkillPath, linkBotSkills, skillSha } from "./library";
import { injectedMemory, MAIN_MEMORY, memoryFolder, recentLogEntries } from "./memory";
import type { PaseoApi } from "./paseo";

async function botApps(bot: Bot): Promise<PromptApp[]> {
  if (bot.apps.length === 0 || !(await readState()).apiKey) return [];
  const connected = (await accounts().catch(() => ({ accounts: [] as AppAccount[] }))).accounts.filter(
    (account) => account.status === "connected",
  );
  const slugs = bot.apps.filter((slug) => connected.some((account) => account.slug === slug));
  if (slugs.length === 0) return [];
  const names = new Map(
    (await catalog().catch(() => ({ apps: [] }))).apps.map((app) => [app.slug, app.name]),
  );
  return slugs.map((slug) => {
    const rule = bot.appRules[slug];
    // A bot kept to one account doesn't pick; the relay fills it in.
    const mine = rule?.account ? [] : connected.filter((account) => account.slug === slug);
    return {
      name: names.get(slug) ?? slug,
      accounts:
        mine.length > 1
          ? mine.map((account) => ({ account: account.alias ?? account.id, name: account.name }))
          : [],
      tools: rule?.tools ?? "all",
    };
  });
}

export interface ChatStart {
  message?: string;
  team?: { group: BotGroup; bots: Bot[] };
}

/** Memory and skills live on this host, so bots on other hosts can't read or update them. */
export async function promptContext(
  bot: Bot,
  { local, library, paseoTools }: { local: boolean; library: Library; paseoTools: boolean },
  start: ChatStart = {},
): Promise<PromptContext> {
  // Playbooks and teams live in the settings, so they travel with the bot to any host.
  const playbooks = selectPlaybooks(start.message ?? "", bot.playbooks);
  const team = start.team ? teamPrompt(start.team.group, bot, start.team.bots) : null;
  // Connected apps go through this host's relay, so bots on other hosts can't reach them.
  if (!local)
    return {
      memory: "",
      memoryPath: null,
      recentWork: [],
      playbooks,
      team,
      skills: [],
      paseoTools,
      botTools: false,
      apps: [],
    };
  // Only skills whose SKILL.md is still what the user reviewed.
  const skills: typeof library.skills = [];
  for (const skill of botSkills(bot, library)) {
    if (
      skill.reviewedSha === undefined ||
      (skill.reviewedSha !== null && (await skillSha(skill.id)) === skill.reviewedSha)
    )
      skills.push(skill);
  }
  const paths = await linkBotSkills(
    bot.id,
    skills.map((skill) => skill.id),
  );
  return {
    memory: await injectedMemory(bot.id),
    memoryPath: join(memoryFolder(bot.id), MAIN_MEMORY),
    recentWork: recentWork(await recentLogEntries(bot.id, 3), new Date()),
    playbooks,
    team,
    skills: skills.map((skill) => ({
      name: skill.id,
      description: skill.description,
      path: paths.get(skill.id) ?? join(librarySkillPath(skill.id), "SKILL.md"),
    })),
    paseoTools,
    botTools: true,
    apps: await botApps(bot),
  };
}

/** Assumes yes when the config can't be read. */
async function paseoToolsOn(paseo: PaseoApi | null, provider: string): Promise<boolean> {
  if (!paseo) return true;
  try {
    const { config } = await paseo.config.get();
    return paseoToolsState(config as PaseoToolsConfig, provider).on;
  } catch {
    return true;
  }
}

/** `settings` supplies the bot's team. */
export async function systemPrompt(
  { bot, local, message }: { bot: Bot; local: boolean; message?: string },
  library: Library,
  paseo: PaseoApi | null,
  settings?: BotState | null,
) {
  const group = teamOf(bot.id, settings?.groups ?? []);
  const start: ChatStart = {
    ...(message !== undefined ? { message } : {}),
    ...(group && settings ? { team: { group, bots: settings.bots } } : {}),
  };
  // Another host's config isn't readable from here; Paseo gives agents its tools by default.
  const context = await promptContext(
    bot,
    { local, library, paseoTools: local ? await paseoToolsOn(paseo, bot.provider) : true },
    start,
  );
  return { systemPrompt: composeSystemPrompt(bot, context), sections: promptSections(bot, context) };
}
