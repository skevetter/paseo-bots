import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import type { LibrarySkill } from "../shared/bot";
import {
  parseSkillFrontmatter,
  parseSkillSource,
  type SkillSource,
  sanitizeSkillName,
} from "../shared/skills";
import { botDataPath, botsHomePath, pluginDataPath } from "./bot-home";

// Bots get a link to each of their skills in <bot>/skills, so the agent reads them inside its own
// working folder.

const MAX_SKILLS = 30;
const MAX_FILES_PER_SKILL = 40;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LISTED_FILES = 100;

export type ImportedSkill = Pick<LibrarySkill, "id" | "description" | "source">;

function librarySkillsPath(): string {
  return join(pluginDataPath(), "library", "skills");
}

export function librarySkillPath(id: string): string {
  return join(librarySkillsPath(), id);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "paseo-bots", Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T;
}

async function saveSkill(
  files: Map<string, string>,
  source: string,
  fallbackName: string,
): Promise<ImportedSkill> {
  const meta = parseSkillFrontmatter(files.get("SKILL.md") ?? "");
  const id = sanitizeSkillName(meta.name ?? fallbackName);
  const dir = librarySkillPath(id);
  await rm(dir, { recursive: true, force: true });
  for (const [path, text] of files) {
    const target = join(dir, ...path.split("/"));
    if (!target.startsWith(dir + sep)) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }
  return { id, description: meta.description ?? "", source };
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

interface GitTree {
  tree: TreeEntry[];
  truncated: boolean;
}

interface RepoTree {
  owner: string;
  repo: string;
  ref: string;
  entries: TreeEntry[];
  skillDirs: string[];
}

/** `source`: "owner/repo", "owner/repo/path", a GitHub URL or a SKILL.md link. */
export async function importSkills({
  source: input,
}: {
  source: string;
}): Promise<{ skills: ImportedSkill[] }> {
  const source = parseSkillSource(input);
  if (source.kind === "github") return { skills: await importGitHubSkills(source) };
  const text = await fetchText(source.url);
  const fallback = posix.basename(posix.dirname(new URL(source.url).pathname)) || "skill";
  return { skills: [await saveSkill(new Map([["SKILL.md", text]]), source.url, fallback)] };
}

async function importGitHubSkills(
  source: Extract<SkillSource, { kind: "github" }>,
): Promise<ImportedSkill[]> {
  const { owner, repo } = source;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const ref = source.ref ?? (await fetchJson<{ default_branch: string }>(api)).default_branch;
  const entries = await repoEntries(source, ref);
  const skillDirs = findSkillDirs(entries, source.path);
  if (skillDirs.length === 0)
    throw new Error(`No SKILL.md found in ${owner}/${repo}${source.path ? `/${source.path}` : ""}.`);

  const skills: ImportedSkill[] = [];
  for (const dir of skillDirs)
    skills.push(await importSkillDir({ owner, repo, ref, entries, skillDirs }, dir));
  return skills;
}

const treeUrl = (owner: string, repo: string, sha: string) =>
  `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(sha)}`;

/** GitHub cuts a recursive listing of a large repository short, so then only the folder asked for is listed. */
async function repoEntries(
  source: Extract<SkillSource, { kind: "github" }>,
  ref: string,
): Promise<TreeEntry[]> {
  const { owner, repo, path } = source;
  const whole = await fetchJson<GitTree>(`${treeUrl(owner, repo, ref)}?recursive=1`);
  if (!whole.truncated) return whole.tree;
  const tooBig = new Error(
    `${owner}/${repo} is too big for GitHub to list at once. Import a folder inside it, like ${owner}/${repo}/skills/<name>.`,
  );
  if (!path) throw tooBig;
  let sha: string | undefined = ref;
  for (const name of path.split("/")) {
    const level: GitTree = await fetchJson<GitTree>(treeUrl(owner, repo, sha));
    sha = level.tree.find((entry) => entry.type === "tree" && entry.path === name)?.sha;
    if (!sha) return [];
  }
  const folder = await fetchJson<GitTree>(`${treeUrl(owner, repo, sha)}?recursive=1`);
  if (folder.truncated) throw tooBig;
  return folder.tree.map((entry) => ({ ...entry, path: `${path}/${entry.path}` }));
}

function findSkillDirs(entries: TreeEntry[], path: string): string[] {
  const prefix = path ? `${path}/` : "";
  return entries
    .filter(
      (entry) =>
        entry.type === "blob" &&
        posix.basename(entry.path) === "SKILL.md" &&
        (entry.path === `${prefix}SKILL.md` || entry.path.startsWith(prefix)),
    )
    .map((entry) => posix.dirname(entry.path))
    .slice(0, MAX_SKILLS);
}

async function importSkillDir(tree: RepoTree, dir: string): Promise<ImportedSkill> {
  const { owner, repo, ref, skillDirs } = tree;
  const base = dir === "." ? "" : `${dir}/`;
  const blobs = tree.entries
    .filter(
      (entry) => entry.type === "blob" && entry.path.startsWith(base) && (entry.size ?? 0) <= MAX_FILE_BYTES,
    )
    // Nested skills are imported on their own.
    .filter(
      (entry) =>
        !skillDirs.some(
          (other) => other !== dir && other.startsWith(base) && entry.path.startsWith(`${other}/`),
        ),
    )
    // The cap must not drop the one file a skill needs.
    .sort((a, b) => Number(b.path === `${base}SKILL.md`) - Number(a.path === `${base}SKILL.md`))
    .slice(0, MAX_FILES_PER_SKILL);
  const files = new Map<string, string>();
  const encoded = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  for (const blob of blobs) {
    files.set(
      blob.path.slice(base.length),
      await fetchText(
        `https://raw.githubusercontent.com/${owner}/${repo}/${encoded(ref)}/${encoded(blob.path)}`,
      ),
    );
  }
  const origin = `github.com/${owner}/${repo}${dir === "." ? "" : `/${dir}`}`;
  return saveSkill(files, origin, dir === "." ? repo : posix.basename(dir));
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(relative(root, path).split(sep).join("/"));
    }
  };
  await walk(root);
  return files.sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function skillSha(id: string): Promise<string | null> {
  const text = await readFile(join(librarySkillPath(id), "SKILL.md"), "utf8").catch(() => null);
  return text === null ? null : sha256(text);
}

export async function readSkill({ id }: { id: string }) {
  const dir = librarySkillPath(id);
  const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => null);
  return {
    text: text ?? "",
    sha: text === null ? null : sha256(text),
    missing: text === null,
    path: join(dir, "SKILL.md"),
    files: await listFiles(dir),
  };
}

export async function writeSkill({ id, text }: { id: string; text: string }) {
  const dir = librarySkillPath(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), text, "utf8");
  return { description: parseSkillFrontmatter(text).description ?? "", sha: sha256(text) };
}

export async function deleteSkill({ id }: { id: string }) {
  await rm(librarySkillPath(id), { recursive: true, force: true });
  return { ok: true };
}

/** The first copy of a skill name wins; later ones stay in their bot's folder. */
export async function migrateBotSkills(): Promise<void> {
  const bots = await readdir(botsHomePath(), { withFileTypes: true }).catch(() => []);
  for (const bot of bots) {
    if (bot.isDirectory()) await migrateSkillsFolder(join(botsHomePath(), bot.name, "skills"));
  }
}

async function migrateSkillsFolder(skillsDir: string): Promise<void> {
  const skills = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  for (const skill of skills) {
    if (!skill.isDirectory() || skill.name.startsWith(".")) continue;
    const target = librarySkillPath(skill.name);
    if (await lstat(target).catch(() => null)) continue;
    await mkdir(librarySkillsPath(), { recursive: true });
    await rename(join(skillsDir, skill.name), target);
  }
}

/** Returns each skill's SKILL.md path for the agent: the link, or the library copy when linking fails. */
export async function linkBotSkills(botId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const dir = join(botDataPath(botId), "skills");
  const paths = new Map<string, string>();
  await mkdir(dir, { recursive: true }).catch(() => {});
  const existing = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of existing) {
    if (entry.isSymbolicLink() && !ids.includes(entry.name))
      await unlink(join(dir, entry.name)).catch(() => {});
  }
  for (const id of ids) {
    const target = librarySkillPath(id);
    const link = join(dir, id);
    const linked = await linkSkill(target, link);
    paths.set(id, join(linked ? link : target, "SKILL.md"));
  }
  return paths;
}

async function linkSkill(target: string, link: string): Promise<boolean> {
  const info = await lstat(link).catch(() => null);
  if (info && !info.isSymbolicLink()) return false;
  if (info) {
    if ((await readlink(link).catch(() => "")) === target) return true;
    await unlink(link).catch(() => {});
  }
  // "junction" lets Windows link folders without admin rights; other systems ignore it.
  return symlink(target, link, "junction").then(
    () => true,
    () => false,
  );
}
