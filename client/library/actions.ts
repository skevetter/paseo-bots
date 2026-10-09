import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import type { Bot, BotMcpServer, BotState, LibraryMcpServer, LibrarySkill } from "../../shared/bot";
import {
  addedSkillsMessage,
  addMcpServers,
  changeLibrary,
  type LibraryKind,
  type LibraryMutation,
  newLibraryServer,
  patchedServer,
  setBotUses,
  updateSkill,
  upsertSkills,
  withoutMcpServer,
  withoutSkill,
} from "../../shared/library";
import { skillDeleteRpc } from "../../shared/rpc";
import { errorText } from "../native";
import type { LibraryTarget } from "../navigation";
import type { McpDraft } from "./McpSheets";
import { skillQueryKey } from "./SkillPage";
import type { SavedSkill } from "./SkillSheets";

export type SetTarget = (target: LibraryTarget | null) => void;

export type CommitSettings = (mutate: (values: BotState) => BotState) => Promise<boolean>;

type SaveLibrary = (mutate: LibraryMutation) => Promise<boolean>;

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
  const save: SaveLibrary = (mutate) => commit((values) => changeLibrary(values, mutate));
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
    if (await save((current, currentBots) => withoutMcpServer(current, currentBots, id))) {
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
    toast.show(addedSkillsMessage(skills), { variant: "success" });
    setTarget({ kind: "skill", id: first.id });
  };

  const removeSkill = async (id: string) => {
    try {
      await deleteSkillFiles({ id });
    } catch (error) {
      toast.error(`Couldn't delete the files: ${errorText(error)}`);
      return;
    }
    if (await save((current, currentBots) => withoutSkill(current, currentBots, id))) {
      setTarget(null);
    }
  };

  return { addSkills, removeSkill };
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
