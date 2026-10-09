// No React Native imports here, so it can be unit tested.
import type { ComposerAttachment } from "../../../shared/attachments";

/** Paseo's `sendBehavior` app setting. */
export type SendBehavior = "interrupt" | "steer" | "queue";
export const DEFAULT_SEND_BEHAVIOR: SendBehavior = "steer";

export function parseSendBehavior(raw: string | null | undefined): SendBehavior {
  if (!raw) return DEFAULT_SEND_BEHAVIOR;
  try {
    const value = (JSON.parse(raw) as { sendBehavior?: unknown } | null)?.sendBehavior;
    return value === "interrupt" || value === "steer" || value === "queue" ? value : DEFAULT_SEND_BEHAVIOR;
  } catch {
    return DEFAULT_SEND_BEHAVIOR;
  }
}

/** Queueing behind a permission prompt would strand the message. */
export function resolveActiveSendBehavior(
  behavior: SendBehavior,
  hasPendingPermission: boolean,
): SendBehavior {
  return behavior === "queue" && hasPendingPermission ? "interrupt" : behavior;
}

export function activeTurnBehaviorFor(behavior: SendBehavior): "steer" | "interrupt" {
  return behavior === "steer" ? "steer" : "interrupt";
}

export type SendAction = "send" | "queue" | "none";

export function resolveDefaultAction(input: {
  behavior: SendBehavior;
  running: boolean;
  canQueue: boolean;
}): SendAction {
  return input.behavior === "queue" && input.running && input.canQueue ? "queue" : "send";
}

export function resolveAlternateAction(input: {
  behavior: SendBehavior;
  running: boolean;
  canQueue: boolean;
}): SendAction {
  if (input.behavior === "queue") return "send";
  return input.running && input.canQueue ? "queue" : "none";
}

export type PrimaryActionKind = "send" | "active" | "none";

export function resolvePrimaryAction(input: {
  hasContent: boolean;
  running: boolean;
  loading: boolean;
}): PrimaryActionKind {
  if (input.hasContent) return "send";
  if (input.running) return "active";
  if (input.loading) return "send";
  return "none";
}

export function submitAccessibilityLabel(input: {
  canPressLoading: boolean;
  behavior: SendBehavior;
  running: boolean;
}): string {
  if (input.canPressLoading) return "Interrupt agent";
  if (input.behavior === "queue" && input.running) return "Queue message";
  if (input.running) return input.behavior === "steer" ? "Send and steer" : "Send and interrupt";
  return "Send message";
}

export interface ComposerKeyEvent {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** Enter while an IME is composing confirms the candidate, it doesn't send. */
export function isImeComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return Boolean(event.isComposing) || event.keyCode === 229;
}

export function resolveEnterKey(
  event: ComposerKeyEvent,
  context: { submitOnEnter: boolean; running: boolean; canQueue: boolean },
): "default" | "alternate" | null {
  if (isImeComposing(event)) return null;
  if (event.key !== "Enter" || !context.submitOnEnter || event.shiftKey) return null;
  if ((event.metaKey || event.ctrlKey) && context.running && context.canQueue) return "alternate";
  return "default";
}

export const MIN_INPUT_HEIGHT_WEB = 46;
export const MIN_INPUT_HEIGHT_NATIVE = 30;
const DEFAULT_MAX_INPUT_HEIGHT = 160;

export function resolveMaxInputHeight(windowHeight: number): number {
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return DEFAULT_MAX_INPUT_HEIGHT;
  return Math.max(DEFAULT_MAX_INPUT_HEIGHT, Math.floor(windowHeight * 0.5));
}

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
}

export function enqueue(queue: readonly QueuedMessage[], message: QueuedMessage): QueuedMessage[] {
  if (!message.text.trim() && message.attachments.length === 0) return [...queue];
  return [...queue, message];
}

export function takeQueued(
  queue: readonly QueuedMessage[],
  id: string,
): { item: QueuedMessage | null; rest: QueuedMessage[] } {
  const item = queue.find((entry) => entry.id === id) ?? null;
  return { item, rest: item ? queue.filter((entry) => entry.id !== id) : [...queue] };
}

export function shouldDrainQueue(input: {
  running: boolean;
  queued: number;
  inFlight: boolean;
  hasAgent: boolean;
}): boolean {
  return input.hasAgent && !input.running && input.queued > 0 && !input.inFlight;
}

export interface ComposerDraft {
  text: string;
  attachments: ComposerAttachment[];
  updatedAt: number;
}

export function composerDraftKey(hostKey: string, botId: string, agentId: string | null): string {
  return agentId ? `agent:${hostKey}:${agentId}` : `new:${hostKey}:${botId}`;
}

export function isDraftEmpty(
  draft: { text: string; attachments: readonly unknown[] } | null | undefined,
): boolean {
  return !draft || (draft.text.length === 0 && draft.attachments.length === 0);
}

const MAX_DRAFTS = 50;
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

function isAttachment(value: unknown): value is ComposerAttachment {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.size !== "number")
    return false;
  if (entry.kind === "image") return typeof entry.data === "string" && typeof entry.mimeType === "string";
  if (entry.kind === "text") return typeof entry.text === "string";
  if (entry.kind === "file") return typeof entry.path === "string" && typeof entry.mimeType === "string";
  return false;
}

function parseDraftEntry(value: unknown): ComposerDraft | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const text = typeof entry.text === "string" ? entry.text : "";
  const attachments = Array.isArray(entry.attachments) ? entry.attachments.filter(isAttachment) : [];
  const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
  return isDraftEmpty({ text, attachments }) ? null : { text, attachments, updatedAt };
}

export function parseDrafts(raw: string | null | undefined): Record<string, ComposerDraft> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const drafts: Record<string, ComposerDraft> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const draft = parseDraftEntry(value);
      if (draft) drafts[key] = draft;
    }
    return drafts;
  } catch {
    return {};
  }
}

/** Over the byte budget, image data goes first, from the oldest drafts. */
export function serializeDrafts(
  drafts: Record<string, ComposerDraft>,
  limits: { maxDrafts?: number; maxBytes?: number } = {},
): string {
  const maxDrafts = limits.maxDrafts ?? MAX_DRAFTS;
  const maxBytes = limits.maxBytes ?? MAX_DRAFT_BYTES;
  const entries = Object.entries(drafts)
    .filter(([, draft]) => !isDraftEmpty(draft))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, maxDrafts);
  let json = JSON.stringify(Object.fromEntries(entries));
  for (let index = entries.length - 1; index >= 0 && json.length > maxBytes; index--) {
    const entry = entries[index];
    if (!entry) continue;
    const [key, draft] = entry;
    if (!draft.attachments.some((attachment) => attachment.kind === "image")) continue;
    entries[index] = [
      key,
      { ...draft, attachments: draft.attachments.filter((attachment) => attachment.kind !== "image") },
    ];
    json = JSON.stringify(Object.fromEntries(entries.filter(([, value]) => !isDraftEmpty(value))));
  }
  return json;
}

/** Keeps anything typed while the failed send was in flight. */
export function restoreFailedSend(
  failed: { text: string; attachments: ComposerAttachment[] },
  current: { text: string; attachments: ComposerAttachment[] },
): { text: string; attachments: ComposerAttachment[] } {
  const typed = current.text.trim();
  const text = !typed ? failed.text : !failed.text ? current.text : `${failed.text}\n${current.text}`;
  const ids = new Set(failed.attachments.map((attachment) => attachment.id));
  return {
    text,
    attachments: [
      ...failed.attachments,
      ...current.attachments.filter((attachment) => !ids.has(attachment.id)),
    ],
  };
}

export interface ContextUsage {
  percent: number;
  used: number;
  max: number;
  costUsd: number | null;
}

export function contextUsage(
  usage:
    | {
        contextWindowMaxTokens?: number | null;
        contextWindowUsedTokens?: number | null;
        totalCostUsd?: number | null;
      }
    | null
    | undefined,
): ContextUsage | null {
  const max = usage?.contextWindowMaxTokens;
  const used = usage?.contextWindowUsedTokens;
  if (
    typeof max !== "number" ||
    typeof used !== "number" ||
    !Number.isFinite(max) ||
    max <= 0 ||
    !Number.isFinite(used) ||
    used < 0
  )
    return null;
  const cost = usage?.totalCostUsd;
  return { percent: (used / max) * 100, used, max, costUsd: typeof cost === "number" ? cost : null };
}

export function meterTone(percent: number): "danger" | "warning" | "normal" {
  const clamped = Math.max(0, Math.min(100, percent));
  if (clamped > 90) return "danger";
  if (clamped >= 70) return "warning";
  return "normal";
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return Math.round(value).toString();
}

export function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/**
 * Plugins have no SVG, so the ring is two clipped half-rings, each a circle with its top and
 * right borders coloured. Returns their rotations in degrees, clockwise from 12 o'clock.
 */
export function ringRotations(percent: number): { right: number; left: number | null } {
  const p = Math.max(0, Math.min(100, percent)) / 100;
  return { right: 225 + 360 * Math.min(p, 0.5), left: p > 0.5 ? 360 * p - 135 : null };
}

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: "command" | "skill";
}

export function commandQuery(text: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(text);
  return match?.[1]?.toLowerCase() ?? null;
}

export function withPluginCommands(
  plugin: readonly SlashCommand[],
  provider: readonly SlashCommand[],
): SlashCommand[] {
  const taken = new Set(plugin.map((command) => command.name));
  return [...plugin, ...provider.filter((command) => !taken.has(command.name))];
}

export function filterCommands(commands: readonly SlashCommand[], query: string, limit = 50): SlashCommand[] {
  const q = query.toLowerCase();
  const prefix: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(command);
    else if (q && name.includes(q)) contains.push(command);
  }
  const byName = (a: SlashCommand, b: SlashCommand) => a.name.localeCompare(b.name);
  return [...prefix.sort(byName), ...contains.sort(byName)].slice(0, limit);
}

export function applyCommand(command: SlashCommand): string {
  return `/${command.name} `;
}
