import type { Playbook } from "./bot";

// Only the chat's first message is matched, so unrelated guidance stays out of the prompt.

const MAX_SELECTED = 3;
const MAX_CHARS = 24_000;

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function selectPlaybooks(text: string, playbooks: readonly Playbook[]): Playbook[] {
  const job = ` ${normalize(text)} `;
  return playbooks
    .filter(
      (playbook) =>
        playbook.instructions.trim() &&
        playbook.triggers.some((trigger) => normalize(trigger) && job.includes(` ${normalize(trigger)} `)),
    )
    .slice(0, MAX_SELECTED);
}

export function renderPlaybooks(playbooks: readonly Playbook[]): string {
  let remaining = MAX_CHARS;
  const parts: string[] = [];
  for (const playbook of playbooks) {
    if (remaining <= 0) break;
    const instructions = playbook.instructions.trim().slice(0, remaining);
    remaining -= instructions.length;
    parts.push(`<playbook name=${JSON.stringify(playbook.name)}>\n${instructions}\n</playbook>`);
  }
  return [
    "Playbooks that match this job. Follow them as process guidance; they don't grant tools or permissions, or override the user.",
    ...parts,
  ].join("\n");
}

export function parseTriggers(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((trigger) => trigger.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}
