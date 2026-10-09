import type { PluginTheme } from "@getpaseo/plugin";
import type { LayoutRectangle } from "react-native";
import type { Library } from "../../shared/bot";
import { useMenu } from "../ui/Menu";
import type { LibraryActions } from "./actions";
import { BLANK_SERVER, ImportSheet, type McpDraft, ServerSheet } from "./McpSheets";
import { ImportSkillsSheet, NewSkillSheet } from "./SkillSheets";

type Colors = PluginTheme["colors"];

export type Sheet =
  | { kind: "import-skills" }
  | { kind: "new-skill" }
  | { kind: "new-server"; initial: McpDraft }
  | { kind: "paste-servers" };

export function useAddMenus(setSheet: (sheet: Sheet) => void) {
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

export function LibrarySheets({
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
