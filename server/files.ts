import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const fileLocks = new Map<string, Promise<unknown>>();

/** Keeps a read that sets a broken file aside from racing a write that replaces it. */
function withFileLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const next = (fileLocks.get(path) ?? Promise.resolve()).then(task);
  fileLocks.set(
    path,
    next.catch(() => {}),
  );
  return next;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** True for anything at `path`, a broken symlink included. */
export async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

async function setAside(path: string, error: unknown): Promise<void> {
  const aside = `${path}.corrupt-${Date.now()}`;
  try {
    await rename(path, aside);
    console.error(`paseo-bots: couldn't read ${path}; moved it to ${aside} and started fresh`, error);
  } catch (renameError) {
    if (!isMissing(renameError)) throw renameError;
  }
}

/**
 * A missing file reads as null; one `parse` rejects is moved aside first so the next write can't destroy it,
 * then also reads as null. Any other read error throws.
 */
export function readParsed<T>(path: string, parse: (text: string) => T): Promise<T | null> {
  return withFileLock(path, async () => {
    const text = await readIfPresent(path);
    if (text === null) return null;
    try {
      return parse(text);
    } catch (error) {
      await setAside(path, error);
      return null;
    }
  });
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  return ((await readParsed(path, JSON.parse)) as T | null) ?? fallback;
}

/** Written whole and renamed into place, so a failed or interrupted write leaves the old file intact. */
export function writeAtomic(path: string, text: string, mode?: number): Promise<void> {
  return withFileLock(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, text, { encoding: "utf8", ...(mode ? { mode } : {}) });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  });
}

export function writeJson(path: string, value: unknown, mode?: number): Promise<void> {
  return writeAtomic(path, JSON.stringify(value, null, 2), mode);
}
