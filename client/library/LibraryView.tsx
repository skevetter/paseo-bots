import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type LayoutRectangle, View } from "react-native";
import type { AppAccount, AppCard } from "../../shared/apps";
import {
  type Bot,
  type BotMcpServer,
  type BotSettingsValues,
  EMPTY_LIBRARY,
  type Library,
  type LibraryMcpServer,
  type LibrarySkill,
} from "../../shared/bot";
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
import { appsConnectRpc, skillDeleteRpc } from "../../shared/rpc";
import { errorText, nativeTokens } from "../native";
import type { LibraryTarget } from "../navigation";
import { SlideOver } from "../ui/Columns";
import { useMenu } from "../ui/Menu";
import { AppPage } from "./AppPage";
import { AppsPage } from "./AppsPage";
import { useAppsAccounts, useAppsCatalog, useAppsInvalidate, useAppsStatus } from "./apps";
import { LibraryList } from "./LibraryList";
import { McpPage } from "./McpPage";
import { BLANK_SERVER, ImportSheet, type McpDraft, ServerSheet } from "./McpSheets";
import { BackBar, PAGE_STYLE } from "./parts";
import { SkillPage, skillQueryKey } from "./SkillPage";
import { ImportSkillsSheet, NewSkillSheet, type SavedSkill } from "./SkillSheets";

/** Paseo's SETTINGS_DESKTOP_SIDEBAR_WIDTH. */
const LIST_WIDTH = 320;

type Colors = PluginSurfaceProps["theme"]["colors"];

type Sheet =
  | { kind: "import-skills" }
  | { kind: "new-skill" }
  | { kind: "new-server"; initial: McpDraft }
  | { kind: "paste-servers" };

interface LibraryViewProps {
  colors: Colors;
  layout: PluginSurfaceProps["layout"];
  values: BotSettingsValues;
  commit(mutate: (values: BotSettingsValues) => BotSettingsValues): Promise<boolean>;
  /** Page shown; null is the list screen on compact. */
  target: LibraryTarget | null;
  onTarget(target: LibraryTarget | null): void;
  onBack(): void;
  bottomInset: number;
}

type SetTarget = (target: LibraryTarget | null) => void;

type SaveLibrary = (
  mutate: (library: Library, bots: Bot[]) => { library?: Library; bots?: Bot[] },
) => Promise<boolean>;

interface PendingSignIn {
  slug: string;
  since: number;
  known: string[];
}

interface AppConnections {
  /** App whose sign-in is open in the browser. */
  pending: string | null;
  accounts: AppAccount[];
  catalog: AppCard[];
  startConnect(slug: string, alias?: string): Promise<void>;
}

interface LibraryActions {
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

type Selection =
  | { kind: "skill"; skill: LibrarySkill }
  | { kind: "mcp"; server: LibraryMcpServer }
  | { kind: "app"; app: AppCard; accounts: AppAccount[] }
  | { kind: "apps" };

export function LibraryView({
  colors,
  layout,
  values,
  commit,
  target,
  onTarget: setTarget,
  onBack,
  bottomInset,
}: LibraryViewProps) {
  const compact = layout.compact;
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const apps = useAppConnections(setTarget);
  const actions = useLibraryActions(commit, setTarget);
  const menus = useAddMenus(setSheet);
  const library = values.library ?? EMPTY_LIBRARY;

  const shown = target ?? (compact ? null : firstTarget(library));
  const selection = resolveSelection({ library, shown, accounts: apps.accounts, catalog: apps.catalog });

  const list = (
    <LibraryList
      colors={colors}
      library={library}
      query={query}
      onQuery={setQuery}
      selected={compact ? null : shown}
      onSelect={setTarget}
      onAddSkill={menus.openSkillMenu}
      onAddServer={menus.openServerMenu}
      touch={compact || layout.platform !== "web"}
      onBack={compact ? undefined : onBack}
      bottomInset={bottomInset}
    />
  );

  const scrollPage = (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[PAGE_STYLE, { paddingBottom: PAGE_STYLE.paddingBottom + bottomInset }]}
    >
      <LibraryPage
        colors={colors}
        selection={selection}
        library={library}
        bots={values.bots}
        compact={compact}
        actions={actions}
        apps={apps}
        setTarget={setTarget}
      />
    </ScrollView>
  );

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.surface0 }}>
      {compact ? (
        <CompactColumns
          colors={colors}
          list={list}
          page={scrollPage}
          open={shown !== null}
          title={pageTitle(selection, shown)}
          onBack={onBack}
          onClose={() => setTarget(null)}
        />
      ) : (
        <DesktopColumns colors={colors} list={list} page={scrollPage} />
      )}

      <LibrarySheets
        colors={colors}
        sheet={sheet}
        library={library}
        actions={actions}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

function useAppConnections(setTarget: SetTarget): AppConnections {
  const toast = useToast();
  const connectApp = useRpc(appsConnectRpc);
  const invalidateApps = useAppsInvalidate();
  const [pending, setPending] = useState<PendingSignIn | null>(null);
  const appsStatus = useAppsStatus();
  const appsConfigured = appsStatus.data?.configured ?? false;
  const appAccounts = useAppsAccounts(appsConfigured, pending !== null);
  const appCatalog = useAppsCatalog(appsConfigured);
  const accountsData = appAccounts.data;
  const latestRef = useRef({ catalog: appCatalog.data?.apps, toast, setTarget, invalidateApps });
  latestRef.current = { catalog: appCatalog.data?.apps, toast, setTarget, invalidateApps };

  useEffect(() => {
    if (!pending) return;
    if (hasNewAccount(accountsData?.accounts ?? [], pending)) {
      const latest = latestRef.current;
      const name = latest.catalog?.find((app) => app.slug === pending.slug)?.name ?? pending.slug;
      latest.toast.show(`Connected ${name}`, { variant: "success" });
      setPending(null);
      latest.setTarget({ kind: "app", id: pending.slug });
      void latest.invalidateApps();
    } else if (Date.now() - pending.since > 5 * 60_000) {
      setPending(null);
    }
  }, [accountsData, pending]);

  /** The accounts query polls until the sign-in finishes. */
  const startConnect = async (slug: string, alias?: string) => {
    try {
      const { url } = await connectApp({ slug, ...(alias?.trim() ? { alias: alias.trim() } : {}) });
      setPending({
        slug,
        since: Date.now(),
        known: (appAccounts.data?.accounts ?? [])
          .filter((entry) => entry.slug === slug)
          .map((entry) => entry.id),
      });
      await openExternalUrl(url);
    } catch (error) {
      setPending(null);
      toast.error(`Couldn't start the sign-in: ${errorText(error)}`);
    }
  };

  return {
    pending: pending?.slug ?? null,
    accounts: appAccounts.data?.accounts ?? [],
    catalog: appCatalog.data?.apps ?? [],
    startConnect,
  };
}

/** The app may already have accounts; only a new one finishes the sign-in. */
function hasNewAccount(accounts: readonly AppAccount[], pending: PendingSignIn): boolean {
  return accounts.some(
    (entry) =>
      entry.slug === pending.slug && entry.status === "connected" && !pending.known.includes(entry.id),
  );
}

function useLibraryActions(commit: LibraryViewProps["commit"], setTarget: SetTarget): LibraryActions {
  /** Changes the library and the bots together in one write. */
  const save: SaveLibrary = (mutate) =>
    commit((values) => {
      const current = values.library ?? EMPTY_LIBRARY;
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

function useAddMenus(setSheet: (sheet: Sheet) => void) {
  const menu = useMenu();

  const openSkillMenu = (anchor: LayoutRectangle) =>
    menu.open({
      anchor,
      align: "end",
      width: 220,
      title: "Add skill",
      entries: [
        { label: "Import skills", icon: "Download", onSelect: () => setSheet({ kind: "import-skills" }) },
        { label: "New skill", icon: "FilePlus", onSelect: () => setSheet({ kind: "new-skill" }) },
      ],
    });

  const openServerMenu = (anchor: LayoutRectangle) =>
    menu.open({
      anchor,
      align: "end",
      width: 220,
      title: "Add MCP server",
      entries: [
        {
          label: "New server",
          icon: "Plus",
          onSelect: () => setSheet({ kind: "new-server", initial: BLANK_SERVER }),
        },
        { label: "Import config", icon: "Import", onSelect: () => setSheet({ kind: "paste-servers" }) },
      ],
    });

  return { openSkillMenu, openServerMenu };
}

function firstTarget(library: Library): LibraryTarget {
  const firstSkill = library.skills.map((entry) => entry.id).sort((a, b) => a.localeCompare(b))[0];
  if (firstSkill) return { kind: "skill", id: firstSkill };
  const firstServer = library.mcpServers.slice().sort((a, b) => a.name.localeCompare(b.name))[0];
  if (firstServer) return { kind: "mcp", id: firstServer.id };
  return { kind: "apps" };
}

function resolveSelection({
  library,
  shown,
  accounts,
  catalog,
}: {
  library: Library;
  shown: LibraryTarget | null;
  accounts: readonly AppAccount[];
  catalog: readonly AppCard[];
}): Selection {
  if (shown?.kind === "skill") {
    const skill = library.skills.find((entry) => entry.id === shown.id);
    if (skill) return { kind: "skill", skill };
  } else if (shown?.kind === "mcp") {
    const server = library.mcpServers.find((entry) => entry.id === shown.id);
    if (server) return { kind: "mcp", server };
  } else if (shown?.kind === "app") {
    return selectedApp(shown.id, accounts, catalog);
  }
  return { kind: "apps" };
}

function selectedApp(slug: string, accounts: readonly AppAccount[], catalog: readonly AppCard[]): Selection {
  const appAccounts = accounts.filter((account) => account.slug === slug);
  if (!appAccounts.length) return { kind: "apps" };
  const app = catalog.find((entry) => entry.slug === slug) ?? {
    slug,
    name: slug,
    description: "",
    logo: null,
    domain: null,
    noAuth: false,
  };
  return { kind: "app", app, accounts: appAccounts };
}

function pageTitle(selection: Selection, shown: LibraryTarget | null): string {
  switch (selection.kind) {
    case "skill":
      return selection.skill.id;
    case "mcp":
      return selection.server.name;
    case "app":
      return selection.app.name;
    default:
      return shown?.kind === "apps" ? "Connected apps" : "";
  }
}

function LibraryPage({
  colors,
  selection,
  library,
  bots,
  compact,
  actions,
  apps,
  setTarget,
}: {
  colors: Colors;
  selection: Selection;
  library: Library;
  bots: Bot[];
  compact: boolean;
  actions: LibraryActions;
  apps: AppConnections;
  setTarget: SetTarget;
}) {
  const showTitle = !compact;
  switch (selection.kind) {
    case "skill": {
      const { skill } = selection;
      return (
        <SkillPage
          key={`skill:${skill.id}`}
          colors={colors}
          skill={skill}
          bots={bots}
          showTitle={showTitle}
          onPatch={(patch) => actions.patchSkill(skill.id, patch)}
          onToggleBot={(bot, on) => actions.toggleBot("skill", skill.id, bot, on)}
          onImported={(skills) =>
            void actions.save((current) => ({ library: upsertSkills(current, skills) }))
          }
          onDelete={() => void actions.removeSkill(skill.id)}
        />
      );
    }
    case "mcp": {
      const { server } = selection;
      return (
        <McpPage
          key={`mcp:${server.id}`}
          colors={colors}
          server={server}
          bots={bots}
          otherNames={library.mcpServers.filter((entry) => entry.id !== server.id).map((entry) => entry.name)}
          showTitle={showTitle}
          onPatch={(patch) => actions.patchServer(server.id, patch)}
          onToggleBot={(bot, on) => actions.toggleBot("mcp", server.id, bot, on)}
          onDelete={() => void actions.removeServer(server.id)}
        />
      );
    }
    case "app": {
      const { app } = selection;
      return (
        <AppPage
          key={`app:${app.slug}`}
          colors={colors}
          app={app}
          accounts={selection.accounts}
          bots={bots}
          showTitle={showTitle}
          onToggleBot={(bot, on) => actions.toggleApp(app.slug, bot, on)}
          onDisconnected={() => setTarget(compact ? null : { kind: "apps" })}
          onConnect={(alias) => apps.startConnect(app.slug, alias)}
        />
      );
    }
    default:
      return (
        <AppsPage
          colors={colors}
          showTitle={showTitle}
          pending={apps.pending}
          onConnect={(slug) => void apps.startConnect(slug)}
        />
      );
  }
}

function CompactColumns({
  colors,
  list,
  page,
  open,
  title,
  onBack,
  onClose,
}: {
  colors: Colors;
  list: ReactNode;
  page: ReactNode;
  open: boolean;
  title: string;
  onBack(): void;
  onClose(): void;
}) {
  return (
    // Phones stack a page over the list, so a swipe or Back returns to it.
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, backgroundColor: nativeTokens(colors).surfaceSidebar }}>
        <BackBar colors={colors} title="Skills & Tools" backLabel="Back to bots" onBack={onBack} />
        {list}
      </View>
      {open ? (
        <SlideOver onClose={onClose}>
          <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
            <BackBar colors={colors} title={title} onBack={onClose} />
            {page}
          </View>
        </SlideOver>
      ) : null}
    </View>
  );
}

function DesktopColumns({ colors, list, page }: { colors: Colors; list: ReactNode; page: ReactNode }) {
  return (
    <>
      <View
        style={{
          width: LIST_WIDTH,
          borderRightWidth: 1,
          borderRightColor: colors.border,
          backgroundColor: nativeTokens(colors).surfaceSidebar,
        }}
      >
        {list}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>{page}</View>
    </>
  );
}

function LibrarySheets({
  colors,
  sheet,
  library,
  actions,
  onClose,
}: {
  colors: Colors;
  sheet: Sheet | null;
  library: Library;
  actions: LibraryActions;
  onClose(): void;
}) {
  switch (sheet?.kind) {
    case "import-skills":
      return (
        <ImportSkillsSheet
          colors={colors}
          onClose={onClose}
          onImported={(skills) => {
            onClose();
            void actions.addSkills(skills);
          }}
        />
      );
    case "new-skill":
      return (
        <NewSkillSheet
          colors={colors}
          taken={library.skills.map((entry) => entry.id)}
          onClose={onClose}
          onCreated={(created) => {
            onClose();
            void actions.addSkills([created]);
          }}
        />
      );
    case "new-server":
      return (
        <ServerSheet
          colors={colors}
          initial={sheet.initial}
          isNew
          otherNames={library.mcpServers.map((entry) => entry.name)}
          onClose={onClose}
          onSave={(draft) => {
            onClose();
            void actions.createServer(draft);
          }}
        />
      );
    case "paste-servers":
      return (
        <ImportSheet
          colors={colors}
          onClose={onClose}
          onImport={(drafts) => {
            onClose();
            void actions.addServers(drafts);
          }}
        />
      );
    default:
      return null;
  }
}
