import type { PluginTheme } from "@getpaseo/plugin";
import type { AppAccount, AppCard } from "../../shared/apps";
import type { Bot, Library, LibraryMcpServer, LibrarySkill } from "../../shared/bot";
import { mcpServerLabel } from "../../shared/browser";
import { upsertSkills } from "../../shared/library";
import type { LibraryTarget } from "../navigation";
import { AppPage } from "./AppPage";
import { AppsPage } from "./AppsPage";
import type { LibraryActions, SetTarget } from "./actions";
import type { AppConnections } from "./connections";
import { McpPage, type ServerTests } from "./McpPage";
import { SkillPage } from "./SkillPage";

type Colors = PluginTheme["colors"];

type Selection =
  | { kind: "skill"; skill: LibrarySkill }
  | { kind: "mcp"; server: LibraryMcpServer }
  | { kind: "app"; app: AppCard; accounts: AppAccount[] }
  | { kind: "apps" };

export function firstTarget(library: Library): LibraryTarget {
  const firstSkill = library.skills.map((entry) => entry.id).sort((a, b) => a.localeCompare(b))[0];
  if (firstSkill) return { kind: "skill", id: firstSkill };
  const firstServer = library.mcpServers.slice().sort((a, b) => a.name.localeCompare(b.name))[0];
  if (firstServer) return { kind: "mcp", id: firstServer.id };
  return { kind: "apps" };
}

export function resolveSelection({
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

export function pageTitle(selection: Selection, shown: LibraryTarget | null): string {
  switch (selection.kind) {
    case "skill":
      return selection.skill.id;
    case "mcp":
      return mcpServerLabel(selection.server);
    case "app":
      return selection.app.name;
    default:
      return shown?.kind === "apps" ? "Connected apps" : "";
  }
}

export function LibraryPage({
  colors,
  selection,
  library,
  bots,
  compact,
  actions,
  apps,
  serverTests,
  setTarget,
}: {
  colors: Colors;
  selection: Selection;
  library: Library;
  bots: Bot[];
  compact: boolean;
  actions: LibraryActions;
  apps: AppConnections;
  serverTests: ServerTests;
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
          testing={serverTests.testing.has(server.id)}
          onTest={(config, enable) => serverTests.test(server.id, config, enable)}
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
