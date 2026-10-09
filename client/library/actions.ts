import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Bot,
  type BotMcpServer,
  type BotSettingsValues,
  EMPTY_LIBRARY,
  type Library,
  type LibraryMcpServer,
  type LibrarySkill,
} from "../../shared/bot";
import { withBrowserServer } from "../../shared/browser";
import {
  addMcpServers,
  forgetItem,
  type LibraryKind,
  newMcpServerId,
  renameGrants,
  setBotUses,
  updateMcpServer,
  updateSkill,
  upsertSkills,
} from "../../shared/library";
import { skillDeleteRpc } from "../../shared/rpc";
import { errorText } from "../native";
import type { LibraryTarget } from "../navigation";
import type { McpDraft } from "./McpSheets";
import { skillQueryKey } from "./SkillPage";
import type { SavedSkill } from "./SkillSheets";

export type SetTarget = (target: LibraryTarget | null) => void;

export type CommitSettings = (mutate: (values: BotSettingsValues) => BotSettingsValues) => Promise<boolean>;

type SaveLibrary = (
  mutate: (library: Library, bots: Bot[]) => { library?: Library; bots?: Bot[] },
) => Promise<boolean>;

export interface LibraryActions {
  save: SaveLibrary;
  addSkills(skills: SavedSkill[]): Promise<void>;
  addServers(drafts: BotMcpServer[]): Promise<void>;
  createServer(draft: McpDraft): Promise<void>;
  patchSkill(id: string, patch: Partial<LibrarySkill>): void;
  patchServer(id: string, patch: Partial<LibraryMcpServer>): void;
  toggleApp(slug: string, bot: Bot, on: boolean): void;
  toggleBot(kind: LibraryKind, id: string, bot: Bot, on: boolean): void;
  removeSkill(id: string): Promise<void>;
  removeServer(id: string): Promise<void>;
}

export function useLibraryActions(commit: CommitSettings, setTarget: SetTarget): LibraryActions {
  /** Changes the library and the bots together in one write. */
  const save: SaveLibrary = (mutate) =>
    commit((values) => {
      const current = withBrowserServer(values.library ?? EMPTY_LIBRARY);
      const next = mutate(current, values.bots);
      return { ...values, library: next.library ?? current, bots: next.bots ?? values.bots };
    });
  const skillActions = useSkillActions(save, setTarget);

  const addServers = async (drafts: BotMcpServer[]) => {
    let ids: string[] = [];
    const ok = await save((current) => {
      const added = addMcpServers(current, drafts);
      ids = added.ids;
      return { library: added.library };
    });
    if (ok && ids[0]) setTarget({ kind: "mcp", id: ids[0] });
  };

  const createServer = async (draft: McpDraft) => {
    const server = newLibraryServer(draft);
    if (await save((current) => ({ library: { ...current, mcpServers: [...current.mcpServers, server] } })))
      setTarget({ kind: "mcp", id: server.id });
  };

  const removeServer = async (id: string) => {
    if (
      await save((current, currentBots) => ({
        library: { ...current, mcpServers: current.mcpServers.filter((server) => server.id !== id) },
        bots: forgetItem(currentBots, "mcp", id),
      }))
    ) {
      setTarget(null);
    }
  };

  return {
    ...skillActions,
    save,
    addServers,
    createServer,
    removeServer,
    patchSkill: (id, patch) => void save((current) => ({ library: updateSkill(current, id, patch) })),
    patchServer: (id, patch) =>
      void save((current, currentBots) => patchedServer({ library: current, bots: currentBots, id, patch })),
    toggleApp: (slug, bot, on) =>
      void save((_current, currentBots) => ({
        bots: withAppToggled(currentBots, { botId: bot.id, slug, on }),
      })),
    toggleBot: (kind, id, bot, on) =>
      void save((_current, currentBots) => ({
        bots: currentBots.map((entry) => (entry.id === bot.id ? setBotUses(entry, kind, id, on) : entry)),
      })),
  };
}

function useSkillActions(
  save: SaveLibrary,
  setTarget: SetTarget,
): Pick<LibraryActions, "addSkills" | "removeSkill"> {
  const toast = useToast();
  const queryClient = useQueryClient();
  const deleteSkillFiles = useRpc(skillDeleteRpc);

  const addSkills = async (skills: SavedSkill[]) => {
    const [first] = skills;
    if (!first) return;
    if (!(await save((current) => ({ library: upsertSkills(current, skills) })))) return;
    for (const skill of skills) void queryClient.invalidateQueries({ queryKey: skillQueryKey(skill.id) });
    toast.show(addedSkillsMessage(skills, first.id), { variant: "success" });
    setTarget({ kind: "skill", id: first.id });
  };

  const removeSkill = async (id: string) => {
    try {
      await deleteSkillFiles({ id });
    } catch (error) {
      toast.error(`Couldn't delete the files: ${errorText(error)}`);
      return;
    }
    if (
      await save((current, currentBots) => ({
        library: { ...current, skills: current.skills.filter((skill) => skill.id !== id) },
        bots: forgetItem(currentBots, "skill", id),
      }))
    ) {
      setTarget(null);
    }
  };

  return { addSkills, removeSkill };
}

function addedSkillsMessage(skills: readonly SavedSkill[], firstId: string): string {
  const added = skills.length === 1 ? `Added ${firstId}` : `Added ${skills.length} skills`;
  const unreviewed = skills.filter((skill) => !skill.reviewedSha).length;
  if (!unreviewed) return added;
  const them = unreviewed === 1 ? "it" : "them";
  return `${added}. Review ${them} before bots use ${them}.`;
}

function newLibraryServer(draft: McpDraft): LibraryMcpServer {
  const now = new Date().toISOString();
  // Off until a test connects to it.
  return {
    ...draft,
    id: newMcpServerId(),
    enabled: false,
    tools: null,
    checkedAt: null,
    checkError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function patchedServer({
  library,
  bots,
  id,
  patch,
}: {
  library: Library;
  bots: Bot[];
  id: string;
  patch: Partial<LibraryMcpServer>;
}): { library: Library; bots: Bot[] } {
  const before = library.mcpServers.find((server) => server.id === id);
  const name = patch.name;
  const renamed = name !== undefined && before !== undefined && name !== before.name;
  return {
    library: updateMcpServer(library, id, patch),
    bots: renamed ? renameGrants(bots, before.name, name) : bots,
  };
}

function withAppToggled(
  bots: Bot[],
  { botId, slug, on }: { botId: string; slug: string; on: boolean },
): Bot[] {
  return bots.map((entry) =>
    entry.id !== botId
      ? entry
      : {
          ...entry,
          apps: on ? [...new Set([...entry.apps, slug])] : entry.apps.filter((app) => app !== slug),
        },
  );
}
