import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useMemo, useState } from "react";
import { View } from "react-native";
import { type BotState, EMPTY_LIBRARY } from "../../shared/bot";
import { withBrowserServer } from "../../shared/browser";
import { nativeTokens } from "../native";
import type { LibraryTarget } from "../navigation";
import { SlideOver } from "../ui/Columns";
import { type CommitSettings, useLibraryActions } from "./actions";
import { useAppConnections } from "./connections";
import { LibraryList } from "./LibraryList";
import { firstTarget, LibraryPage, pageTitle, resolveSelection } from "./LibraryPage";
import { LibrarySheets, type Sheet, useAddMenus } from "./LibrarySheets";
import { useServerTests } from "./McpPage";
import { BackBar, PAGE_STYLE } from "./parts";

/** Paseo's SETTINGS_DESKTOP_SIDEBAR_WIDTH. */
const LIST_WIDTH = 320;

type Colors = PluginSurfaceProps["theme"]["colors"];

interface LibraryViewProps {
  colors: Colors;
  layout: PluginSurfaceProps["layout"];
  values: BotState;
  commit: CommitSettings;
  /** Page shown; null is the list screen on compact. */
  target: LibraryTarget | null;
  onTarget(target: LibraryTarget | null): void;
  onBack(): void;
  bottomInset: number;
}

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
  const serverTests = useServerTests(actions.patchServer);
  const menus = useAddMenus(setSheet);
  const library = useMemo(() => withBrowserServer(values.library ?? EMPTY_LIBRARY), [values.library]);

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
      testingServers={serverTests.testing}
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
        serverTests={serverTests}
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
            <BackBar colors={colors} title={title} backLabel="Back to Skills & Tools" onBack={onClose} />
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
