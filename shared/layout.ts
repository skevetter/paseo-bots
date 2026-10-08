// Widths match Paseo's desktop layout (stores/panel-store/state.ts, components/*-sidebar-layout.ts).
export const LIST_WIDTH = { default: 320, min: 200, max: 600 };
const PANEL_WIDTH = { default: 320, min: 240 };
export const CENTER_MIN_WIDTH = 400;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Keeps the chat CENTER_MIN_WIDTH wide; the settings panel gives way before the list. */
export function fitColumns(
  total: number,
  list: number,
  panel: number | null,
): { list: number; panel: number | null } {
  let listWidth = clamp(list, LIST_WIDTH.min, LIST_WIDTH.max);
  if (panel === null) {
    return { list: Math.max(LIST_WIDTH.min, Math.min(listWidth, total - CENTER_MIN_WIDTH)), panel: null };
  }
  let panelWidth = Math.max(PANEL_WIDTH.min, panel);
  const overflow = listWidth + panelWidth + CENTER_MIN_WIDTH - total;
  if (overflow > 0) {
    const fromPanel = Math.min(overflow, panelWidth - PANEL_WIDTH.min);
    panelWidth -= fromPanel;
    listWidth -= Math.min(overflow - fromPanel, listWidth - LIST_WIDTH.min);
  }
  return { list: listWidth, panel: panelWidth };
}
