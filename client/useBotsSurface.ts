import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { type ToastApi, useToast } from "@getpaseo/plugin/client/react-native";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef, useState } from "react";
import { BackHandler, Platform, type View } from "react-native";
import {
  type Bot,
  type BotGroup,
  type BotListUi,
  type BotState,
  DEFAULT_BOT_LIST_UI,
  type TeamFileTeam,
} from "../shared/bot";
import { patchSavedBot, pushHistory } from "../shared/bot-history";

import type { ImportedBot } from "../shared/library";
import { exportBotRpc, importBotRpc, importTeamRpc } from "../shared/rpc";
import {
  type BotHost,
  type LocalHost,
  useBotHost,
  useChatInvalidation,
  useHostResolver,
  useProviders,
} from "./data";
import { takeNewBotRequest } from "./intent";
import { homeIndicatorInset, useKeyboardHeight } from "./keyboard";
import { type LibraryTarget, onLibraryTarget } from "./navigation";
import type { SectionId } from "./panel/BotPanel";
import type { Selection } from "./sidebar/types";
import { useTypeScale } from "./typography";
import { type MenuApi, useMenu } from "./ui/Menu";
import { type BotStoreState, type CommitBotState, useBotState } from "./useBotState";

const SAVE_DELAY_MS = 600;

type Setter<T> = Dispatch<SetStateAction<T>>;

interface LatestSettings {
  readonly current: BotStoreState;
}

export interface PanelState {
  open: boolean;
  section: SectionId | null;
}

export interface LibraryViewState {
  target: LibraryTarget | null;
}

export interface DragWidths {
  list?: number;
  panel?: number;
}

export interface SurfaceServices {
  settings: BotStoreState;
  commit: CommitBotState;
  toast: ToastApi;
  menu: MenuApi;
  queryClient: QueryClient;
  localHost: LocalHost;
  resolveHost(hostId: string | null): BotHost;
  defaultProvider(): string;
  exportBot(input: { bot: Bot; includeMemory: boolean }): Promise<{ json: string }>;
  importBot(input: { botId: string; json: string }): Promise<{ bot: Bot }>;
  importTeam(input: { json: string }): Promise<{ bots: ImportedBot[]; teams: TeamFileTeam[] }>;
}

export interface ScreenState {
  selection: Selection | null;
  setSelection: Setter<Selection | null>;
  panel: PanelState;
  setPanel: Setter<PanelState>;
  panelVersion: number;
  setPanelVersion: Setter<number>;
  creating: boolean;
  setCreating: Setter<boolean>;
  teamMap: boolean;
  setTeamMap: Setter<boolean>;
  editingTeam: BotGroup | "new" | null;
  setEditingTeam: Setter<BotGroup | "new" | null>;
  libraryView: LibraryViewState | null;
  setLibraryView: Setter<LibraryViewState | null>;
  renaming: Bot | null;
  setRenaming: Setter<Bot | null>;
  exporting: Bot | null;
  setExporting: Setter<Bot | null>;
}

export interface ListUiState {
  uiOverride: BotListUi | null;
  currentUi(): BotListUi;
  updateUi(mutate: (current: BotListUi) => BotListUi): void;
}

export interface SurfaceLayoutState {
  paneRef: RefObject<View | null>;
  keyboardHeight: number;
  bottomInset: number;
  surfaceWidth: number;
  setSurfaceWidth: Setter<number>;
  dragWidths: DragWidths;
  setDragWidths: Setter<DragWidths>;
  typeVersion: number;
}

export interface DraftState {
  drafts: Record<string, Bot>;
  flush(): Promise<void>;
  patchBot(botId: string, patch: Partial<Bot>): void;
  updateBot(botId: string, patch: Partial<Bot>, recordHistory?: boolean): Promise<boolean>;
}

export interface BotsSurfaceModel
  extends SurfaceServices,
    ScreenState,
    ListUiState,
    SurfaceLayoutState,
    DraftState {
  colors: PluginTheme["colors"];
  layout: PluginScreenProps["layout"];
  navigation: PluginScreenProps["navigation"];
  goBack(): boolean;
}

interface BackState {
  panel: PanelState;
  compact: boolean;
  selection: Selection | null;
  teamMap: boolean;
  libraryView: LibraryViewState | null;
}

type BackSetters = Pick<ScreenState, "setPanel" | "setTeamMap" | "setSelection" | "setLibraryView">;

function applyDrafts(values: BotState, pending: Record<string, Bot>): BotState {
  let history = values.history;
  const bots = values.bots.map((bot) => {
    const draft = pending[bot.id];
    if (!draft) return bot;
    history = pushHistory(history, bot);
    return draft;
  });
  return { ...values, bots, history };
}

function withoutSaved(current: Record<string, Bot>, saved: Record<string, Bot>): Record<string, Bot> {
  const next = { ...current };
  for (const [id, bot] of Object.entries(saved)) if (next[id] === bot) delete next[id];
  return next;
}

function useServices(host: PluginScreenProps["host"]): SurfaceServices & { latest: LatestSettings } {
  const { settings, latest, commit } = useBotState();
  const toast = useToast();
  const menu = useMenu();
  const queryClient = useQueryClient();
  const localHost: LocalHost = { id: host.id, label: host.label };
  const localProviders = useProviders(useBotHost(null, localHost));
  const resolveHost = useHostResolver(localHost);
  const exportBot = useRpc(exportBotRpc);
  const importBot = useRpc(importBotRpc);
  const importTeam = useRpc(importTeamRpc);
  const defaultProvider = () => {
    const ready = (localProviders.data ?? []).filter((entry) => entry.status === "ready");
    return (ready.find((entry) => entry.provider === "claude") ?? ready[0])?.provider ?? "";
  };
  return {
    settings,
    latest,
    commit,
    toast,
    menu,
    queryClient,
    localHost,
    resolveHost,
    defaultProvider,
    exportBot,
    importBot,
    importTeam,
  };
}

function useScreenState(params: PluginScreenProps["params"]): ScreenState {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [panel, setPanel] = useState<PanelState>({ open: false, section: null });
  const [panelVersion, setPanelVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [teamMap, setTeamMap] = useState(false);
  const [editingTeam, setEditingTeam] = useState<BotGroup | "new" | null>(null);
  /** `target` is the page; null is the list, on compact. */
  const [libraryView, setLibraryView] = useState<LibraryViewState | null>(null);
  const [renaming, setRenaming] = useState<Bot | null>(null);
  const [exporting, setExporting] = useState<Bot | null>(null);

  useEffect(() => {
    if (takeNewBotRequest(params)) setCreating(true);
  }, [params]);

  return {
    selection,
    setSelection,
    panel,
    setPanel,
    panelVersion,
    setPanelVersion,
    creating,
    setCreating,
    teamMap,
    setTeamMap,
    editingTeam,
    setEditingTeam,
    libraryView,
    setLibraryView,
    renaming,
    setRenaming,
    exporting,
    setExporting,
  };
}

function useListUi(latest: LatestSettings, commit: CommitBotState): ListUiState {
  // List state (collapsed groups, pins, order, display options) applies at once and saves behind.
  const [uiOverride, setUiOverride] = useState<BotListUi | null>(null);
  const uiRef = useRef<BotListUi | null>(null);

  const currentUi = (): BotListUi =>
    uiRef.current ??
    (latest.current.status === "ready" ? latest.current.values.ui : undefined) ??
    DEFAULT_BOT_LIST_UI;

  const updateUi = (mutate: (current: BotListUi) => BotListUi) => {
    const next = mutate(currentUi());
    uiRef.current = next;
    setUiOverride(next);
    void commit((values) => ({ ...values, ui: uiRef.current ?? next }));
  };

  return { uiOverride, currentUi, updateUi };
}

function useSurfaceLayout(): SurfaceLayoutState {
  const paneRef = useRef<View>(null);
  const keyboardHeight = useKeyboardHeight();
  /** The keyboard covers the home indicator while it's up. */
  const bottomInset = keyboardHeight > 0 ? 0 : homeIndicatorInset();
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  const [dragWidths, setDragWidths] = useState<DragWidths>({});
  const typeVersion = useTypeScale();
  return {
    paneRef,
    keyboardHeight,
    bottomInset,
    surfaceWidth,
    setSurfaceWidth,
    dragWidths,
    setDragWidths,
    typeVersion,
  };
}

function useDrafts(latest: LatestSettings, commit: CommitBotState): DraftState {
  const [drafts, setDrafts] = useState<Record<string, Bot>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flush = async () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const pending = draftsRef.current;
    if (Object.keys(pending).length === 0) return;
    const ok = await commit((values) => applyDrafts(values, pending));
    if (ok) setDrafts((current) => withoutSaved(current, pending));
  };

  const patchBot = (botId: string, patch: Partial<Bot>) => {
    setDrafts((current) => {
      const base =
        current[botId] ??
        (latest.current.status === "ready"
          ? latest.current.values.bots.find((bot) => bot.id === botId)
          : undefined);
      return base
        ? { ...current, [botId]: { ...base, ...patch, updatedAt: new Date().toISOString() } }
        : current;
    });
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => void flushRef.current(), []);

  /** Patches any unsaved draft too, so autosave can't undo the change. */
  const updateBot = (botId: string, patch: Partial<Bot>, recordHistory = false) => {
    setDrafts((current) =>
      current[botId] ? { ...current, [botId]: { ...current[botId], ...patch } } : current,
    );
    return commit((values) => patchSavedBot(values, botId, patch, recordHistory));
  };

  return { drafts, flush, patchBot, updateBot };
}

function useLibraryEntry(flush: () => Promise<void>, setLibraryView: Setter<LibraryViewState | null>) {
  /** Saves bot edits first so the library sees them. */
  const enterLibrary = (target: LibraryTarget | null) => {
    void flush();
    setLibraryView({ target });
  };

  const enterLibraryRef = useRef(enterLibrary);
  enterLibraryRef.current = enterLibrary;
  useEffect(
    () =>
      onLibraryTarget((target) => {
        enterLibraryRef.current(target);
      }),
    [],
  );
}

function closeOverlay(state: BackState, set: BackSetters): boolean {
  if (state.libraryView) {
    set.setLibraryView(state.compact && state.libraryView.target ? { target: null } : null);
    return true;
  }
  if (state.panel.open) {
    set.setPanel(state.panel.section ? { open: true, section: null } : { open: false, section: null });
    return true;
  }
  return false;
}

function closeCompactPane(state: BackState, set: BackSetters): boolean {
  if (state.teamMap) {
    set.setTeamMap(false);
    return true;
  }
  if (state.selection) {
    set.setSelection(null);
    return true;
  }
  return false;
}

// With nothing left to step back from, `false` lets Back leave the plugin.
function useBackNavigation(state: BackState, set: BackSetters): () => boolean {
  const back = useRef(state);
  back.current = state;
  const goBack = (): boolean => {
    const current = back.current;
    return closeOverlay(current, set) || (current.compact && closeCompactPane(current, set));
  };
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => goBackRef.current());
    return () => subscription.remove();
  }, []);
  return goBack;
}

export function useBotsSurface({
  theme,
  layout,
  host,
  navigation,
  params,
}: PluginScreenProps): BotsSurfaceModel {
  const { latest, ...services } = useServices(host);
  const screen = useScreenState(params);
  const listUi = useListUi(latest, services.commit);
  const surfaceLayout = useSurfaceLayout();
  useChatInvalidation();
  const drafts = useDrafts(latest, services.commit);
  useLibraryEntry(drafts.flush, screen.setLibraryView);
  const { panel, selection, teamMap, libraryView } = screen;
  const goBack = useBackNavigation(
    { panel, compact: layout.compact, selection, teamMap, libraryView },
    screen,
  );
  return {
    colors: theme.colors,
    layout,
    navigation,
    ...services,
    ...screen,
    ...listUi,
    ...surfaceLayout,
    ...drafts,
    goBack,
  };
}
