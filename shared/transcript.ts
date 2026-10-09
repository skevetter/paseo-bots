import { localTime } from "./time";
import { toolCallLabel } from "./tool-name";

interface TranscriptEntry {
  item: { type: string; text?: unknown; name?: unknown; status?: unknown; metadata?: unknown };
  timestamp: string;
}

function plain(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>#]/g, "\\$&");
}

function entryToolLabel(item: TranscriptEntry["item"]): string | null {
  if (item.type !== "tool_call" || typeof item.name !== "string") return null;
  const label = toolCallLabel({ name: item.name, metadata: item.metadata });
  return item.status === "failed" ? `${label} (failed)` : label;
}

function entryMessageText(item: TranscriptEntry["item"]): string {
  if (item.type !== "user_message" && item.type !== "assistant_message") return "";
  return String(item.text ?? "").trim();
}

export function chatTranscript(input: {
  title: string;
  botName: string;
  entries: readonly TranscriptEntry[];
  exportedAt: Date;
}): string {
  const lines = [
    `# ${plain(input.title)}`,
    "",
    `_${plain(input.botName)} · exported ${input.exportedAt.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}_`,
  ];
  let speaker: string | null = null;
  let tools: string[] = [];
  const say = (who: string, at: string) => {
    if (who === speaker) return;
    lines.push("", "---", "", `### ${plain(who)} · ${localTime(new Date(at))}`);
    speaker = who;
  };
  const flushTools = () => {
    if (tools.length)
      lines.push("", `> Used ${tools.map((tool) => `\`${tool.replace(/`/g, "'")}\``).join(", ")}`);
    tools = [];
  };
  for (const { item, timestamp } of input.entries) {
    const label = entryToolLabel(item);
    if (label !== null) {
      say(input.botName, timestamp);
      tools.push(label);
      continue;
    }
    const text = entryMessageText(item);
    if (!text) continue;
    flushTools();
    say(item.type === "user_message" ? "You" : input.botName, timestamp);
    lines.push("", text);
  }
  flushTools();
  if (speaker === null) lines.push("", "_No messages yet._");
  return `${lines.join("\n")}\n`;
}
