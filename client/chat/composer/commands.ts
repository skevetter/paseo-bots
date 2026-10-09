import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { LEARN_COMMAND } from "../../../shared/skills";
import type { BotHost } from "../../data";
import { errorText } from "../../native";
import type { PaseoApi } from "../../paseo";
import type { ComposerDraftState } from "./draftState";
import { applyCommand, commandQuery, filterCommands, type SlashCommand, withPluginCommands } from "./logic";

const PLUGIN_COMMANDS: SlashCommand[] = [{ ...LEARN_COMMAND, kind: "command" }];

interface CommandResult {
  commands: SlashCommand[];
  error: string | null;
}

// Commands are listed per live session; cache them per agent for the session.
const commandCache = new Map<string, Promise<CommandResult>>();

function cachedCommands(agentId: string, api: PaseoApi): Promise<CommandResult> {
  const cached = commandCache.get(agentId);
  if (cached) return cached;
  const promise = api.agents
    .ref(agentId)
    .commands()
    .then((result) => ({ commands: result.commands as SlashCommand[], error: result.error }))
    .catch((error: unknown) => ({ commands: [], error: errorText(error) }));
  commandCache.set(agentId, promise);
  // Don't cache failures: the next chat visit asks again.
  void promise.then((result) => result.error && commandCache.delete(agentId));
  return promise;
}

export interface SlashCommandsState {
  visible: boolean;
  list: SlashCommand[];
  activeIndex: number;
  setActiveIndex: Dispatch<SetStateAction<number>>;
  loading: boolean;
  error: string | null;
  dismiss(): void;
  select(command: SlashCommand): void;
}

export function useSlashCommands(
  agentId: string | null,
  host: BotHost,
  draft: ComposerDraftState,
  focusInput: () => void,
): SlashCommandsState {
  const [commandState, setCommandState] = useState<(CommandResult & { agentId: string }) | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const query = agentId ? commandQuery(draft.text) : null;
  const visible = query !== null && !dismissed;
  const loadedFor = useRef(commandState?.agentId);
  loadedFor.current = commandState?.agentId;

  useEffect(() => {
    if (query === null) setDismissed(false);
    setActiveIndex(0);
  }, [query]);
  useEffect(() => {
    if (!visible || !agentId || !host.api || loadedFor.current === agentId) return;
    let alive = true;
    void cachedCommands(agentId, host.api).then((result) => alive && setCommandState({ agentId, ...result }));
    return () => {
      alive = false;
    };
  }, [visible, agentId, host.api]);

  const loaded = commandState?.agentId === agentId ? commandState : null;
  const list = visible
    ? filterCommands(
        withPluginCommands(host.isLocal ? PLUGIN_COMMANDS : [], loaded?.commands ?? []),
        query ?? "",
      )
    : [];
  return {
    visible,
    list,
    activeIndex,
    setActiveIndex,
    loading: loaded === null,
    error: loaded?.error ?? null,
    dismiss: () => setDismissed(true),
    select: (command) => {
      draft.updateText(applyCommand(command));
      setDismissed(true);
      focusInput();
    },
  };
}
