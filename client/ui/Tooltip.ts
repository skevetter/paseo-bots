import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect } from "react";
import { Platform } from "react-native";
import { nativeTokens } from "../native";
import { ui } from "../typography";

// Plugins can't reach react-dom's portal, so one DOM bubble, shared by every tagged button,
// follows the pointer.

type Colors = PluginTheme["colors"];
type Side = "top" | "bottom";

interface El {
  closest(selector: string): El | null;
  contains(node: unknown): boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}
interface Bubble {
  textContent: string;
  style: Record<string, string>;
  offsetWidth: number;
  offsetHeight: number;
  appendChild(node: Bubble): void;
  remove(): void;
}
interface PointerEventLike {
  target: unknown;
  relatedTarget: unknown;
  pointerType?: string;
}
declare const document: {
  createElement(tag: "div"): Bubble;
  body: { appendChild(node: Bubble): void };
  addEventListener(
    type: string,
    listener: (event: PointerEventLike & { key?: string }) => void,
    capture: boolean,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: PointerEventLike & { key?: string }) => void,
    capture: boolean,
  ): void;
};
declare const window: {
  innerWidth: number;
  innerHeight: number;
  getComputedStyle(element: unknown): { fontFamily: string };
};

const web = Platform.OS === "web";
const SELECTOR = "[data-pb-tip]";
const DELAY_MS = 300;
const OFFSET = 8;
const EDGE = 8;
/** Paseo's compact breakpoint. */
const COMPACT_WIDTH = 720;
const UI_FONT =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

interface TooltipExtras {
  /** Under the label, in the same type. */
  lines?: string[];
  /** Muted 12pt lines at the end. */
  details?: string[];
  /** Milliseconds before it opens. */
  delay?: number;
}

export function tooltip(label: string, side: Side = "top", extras: TooltipExtras = {}): object {
  if (!web) return {};
  const dataSet: Record<string, string> = { pbTip: label, pbTipSide: side };
  if (extras.lines?.length) dataSet.pbTipLines = extras.lines.join("\n");
  if (extras.details?.length) dataSet.pbTipDetails = extras.details.join("\n");
  if (extras.delay !== undefined) dataSet.pbTipDelay = String(extras.delay);
  return { dataSet };
}

export function tooltipsShown(): boolean {
  return web && typeof window !== "undefined" && window.innerWidth >= COMPACT_WIDTH;
}

let colors: Colors | null = null;

/** Call it where plugin UI renders. */
export function useTooltipTheme(theme: Colors): void {
  useEffect(() => {
    colors = theme;
  }, [theme]);
}

function styleBubble(bubble: Bubble, target: El, theme: Colors | null): void {
  const tokens = theme ? nativeTokens(theme) : null;
  const dark = tokens?.dark ?? true;
  Object.assign(bubble.style, {
    position: "fixed",
    zIndex: "2147483000",
    pointerEvents: "none",
    maxWidth: "280px",
    padding: "4px 8px",
    borderRadius: "12px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens?.borderAccent ?? "#3a3d42",
    backgroundColor: theme ? (dark ? theme.surface2 : theme.surface0) : "#202225",
    color: theme?.foreground ?? "#e6e6e6",
    boxShadow: dark ? "0 4px 8px rgba(0, 0, 0, 0.20)" : "0 4px 16px rgba(0, 0, 0, 0.04)",
    fontFamily: window.getComputedStyle(target).fontFamily || UI_FONT,
    fontSize: `${ui(14)}px`,
    lineHeight: "1.4",
    whiteSpace: "normal",
    transition: "opacity 80ms ease-out",
    opacity: "0",
    left: "-9999px",
    top: "-9999px",
  });
}

function fillBubble(bubble: Bubble, target: El, label: string, theme: Colors | null): void {
  const lines = target.getAttribute("data-pb-tip-lines")?.split("\n") ?? [];
  const details = target.getAttribute("data-pb-tip-details")?.split("\n") ?? [];
  bubble.style.minWidth = details.length ? "200px" : "0";
  bubble.textContent = "";
  [label, ...lines, ...details].forEach((text, index) => {
    const line = document.createElement("div");
    line.textContent = text;
    const detail = index > lines.length;
    Object.assign(line.style, {
      marginTop: index === 0 ? "0" : "6px",
      color: detail ? (theme?.foregroundMuted ?? "#a1a1aa") : "inherit",
      fontSize: detail ? `${ui(12)}px` : "inherit",
    });
    bubble.appendChild(line);
  });
}

function fittingSide(wanted: Side, above: number, below: number, height: number): Side {
  const limit = window.innerHeight - EDGE;
  if (wanted === "top") return above < EDGE && below + height <= limit ? "bottom" : "top";
  return below + height > limit && above >= EDGE ? "top" : "bottom";
}

function placeBubble(bubble: Bubble, target: El): void {
  const rect = target.getBoundingClientRect();
  const width = bubble.offsetWidth;
  const height = bubble.offsetHeight;
  const wanted = (target.getAttribute("data-pb-tip-side") as Side | null) ?? "top";
  const above = rect.top - height - OFFSET;
  const below = rect.top + rect.height + OFFSET;
  const side = fittingSide(wanted, above, below, height);
  const left = Math.max(
    EDGE,
    Math.min(window.innerWidth - width - EDGE, rect.left + (rect.width - width) / 2),
  );
  bubble.style.left = `${left}px`;
  bubble.style.top = `${side === "top" ? above : below}px`;
  bubble.style.opacity = "1";
}

export function installTooltips(): () => void {
  if (!web || typeof document === "undefined") return () => {};
  let anchor: El | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bubble: Bubble | null = null;

  const hide = () => {
    clearTimeout(timer);
    timer = undefined;
    anchor = null;
    if (bubble) bubble.style.opacity = "0";
  };

  const show = (target: El) => {
    const label = target.getAttribute("data-pb-tip");
    if (!label || !tooltipsShown()) return;
    const theme = colors;
    bubble ??= document.createElement("div");
    styleBubble(bubble, target, theme);
    fillBubble(bubble, target, label, theme);
    document.body.appendChild(bubble);
    placeBubble(bubble, target);
  };

  const over = (event: PointerEventLike) => {
    if (event.pointerType === "touch") return;
    const target = (event.target as El | null)?.closest?.(SELECTOR) ?? null;
    if (target === anchor) return;
    hide();
    if (!target) return;
    anchor = target;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (anchor === target) show(target);
      },
      Number(target.getAttribute("data-pb-tip-delay") ?? DELAY_MS),
    );
  };
  const out = (event: PointerEventLike) => {
    if (anchor && !anchor.contains(event.relatedTarget)) hide();
  };
  const key = (event: { key?: string }) => {
    if (event.key === "Escape") hide();
  };

  const listeners: Array<[string, (event: PointerEventLike & { key?: string }) => void]> = [
    ["pointerover", over],
    ["pointerout", out],
    ["pointerdown", hide],
    ["keydown", key],
    ["scroll", hide],
    ["wheel", hide],
  ];
  for (const [type, listener] of listeners) document.addEventListener(type, listener, true);
  return () => {
    hide();
    bubble?.remove();
    for (const [type, listener] of listeners) document.removeEventListener(type, listener, true);
  };
}
