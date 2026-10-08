export type SkillSource =
  | { kind: "raw"; url: string }
  | { kind: "github"; owner: string; repo: string; ref: string | null; path: string };

const trimSlashes = (path: string) => path.replace(/^\/+|\/+$/g, "");

function parseGitHubUrl(url: URL): SkillSource {
  const [owner, repo, mode, ref, ...rest] = trimSlashes(url.pathname).split("/");
  if (!owner || !repo) throw new Error("That GitHub URL doesn't name a repository.");
  const repoName = repo.replace(/\.git$/, "");
  if (mode !== "blob" && mode !== "tree")
    return { kind: "github", owner, repo: repoName, ref: null, path: "" };
  let path = rest.join("/");
  if (mode === "blob") path = path.replace(/\/?SKILL\.md$/i, "");
  return { kind: "github", owner, repo: repoName, ref: ref ?? null, path };
}

function parseSkillUrl(source: string): SkillSource {
  const url = new URL(source);
  if (url.hostname === "github.com") return parseGitHubUrl(url);
  if (/SKILL\.md$/i.test(url.pathname)) return { kind: "raw", url: source };
  throw new Error("Use a GitHub repository, a GitHub folder, or a link to a SKILL.md file.");
}

export function parseSkillSource(input: string): SkillSource {
  const source = input.trim();
  if (/^https?:\/\//i.test(source)) return parseSkillUrl(source);
  const parts = trimSlashes(source).split("/");
  const [owner, repo, ...rest] = parts;
  if (!owner || !repo || parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error('Use "owner/repo", "owner/repo/path/to/skill" or a GitHub URL.');
  }
  return {
    kind: "github",
    owner,
    repo,
    ref: null,
    path: rest.join("/").replace(/\/?SKILL\.md$/i, ""),
  };
}

export function parseSkillFrontmatter(text: string): { name: string | null; description: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const read = (key: string) => {
    const line = match?.[1]?.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key}:`));
    const value = line
      ?.slice(line.indexOf(":") + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    return value ? value : null;
  };
  return { name: read("name"), description: read("description") };
}

export function sanitizeSkillName(name: string): string {
  // No leading dots: "." and ".." would name a folder outside the library.
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return clean || "skill";
}

/** Agents expect the frontmatter name to match the folder. */
export function skillMarkdown(id: string, description: string, body: string): string {
  const line = description.replace(/\s+/g, " ").trim();
  return `---\nname: ${id}\ndescription: ${line}\n---\n\n${body.trim()}\n`;
}

export function skillBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export const LEARN_COMMAND = {
  name: "learn",
  description: "Save what the bot just did as a skill",
  argumentHint: "[what to focus on]",
};

export function learnPrompt(focus = ""): string {
  const topic = focus.trim().replace(/[.!?]*$/, ".");
  const about = focus.trim() ? ` Focus on: ${topic}` : "";
  return `Turn what you just did into a reusable skill: the steps that worked, what to check, and what a good result looks like.${about} Then propose it with the propose_skill tool so I can review it. Don't write the skill file yourself.`;
}

export function expandLearn(text: string): string | null {
  const match = /^\/learn(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? learnPrompt(match[1] ?? "") : null;
}

/** Warnings only; the user decides. */
export function scanSkillText(text: string): string[] {
  const warnings: string[] = [];
  if (/[A-Za-z0-9+/]{400,}={0,2}/.test(text))
    warnings.push("It contains a long encoded blob that could hide instructions or a program.");
  if (/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(text))
    warnings.push("It pipes a download straight into a shell.");
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(text))
    warnings.push("It contains invisible characters, which can hide text from you.");
  if (
    /\b(ignore|disregard)\b[^\n]{0,30}\b(previous|prior|above|all)\b[^\n]{0,20}\binstructions\b/i.test(text)
  )
    warnings.push("It tells the bot to ignore its other instructions.");
  if (/\b(rm\s+-rf\s+[~/]|mkfs\b|dd\s+if=)/.test(text))
    warnings.push("It includes commands that can erase data.");
  return warnings;
}
