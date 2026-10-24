import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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

/** A newer writer owns this file. Keep it in place so every subsequent read and write also refuses it. */
export class UnsupportedFileVersionError extends Error {
  constructor(version: number) {
    super(`Unsupported file version ${version}. Upgrade the plugin before opening this configuration.`);
    this.name = "UnsupportedFileVersionError";
  }
}

/**
 * A missing file reads as null; one `parse` rejects is moved aside first so the next write can't destroy it,
 * then also reads as null. A version from a newer writer stays in place and throws; other read errors throw.
 */
export function readParsed<T>(path: string, parse: (text: string) => T): Promise<T | null> {
  return withFileLock(path, async () => {
    const text = await readIfPresent(path);
    if (text === null) return null;
    try {
      return parse(text);
    } catch (error) {
      if (error instanceof UnsupportedFileVersionError) throw error;
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

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function durableDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  let current = await realpath(path);
  // An existing ancestor may have been created by a caller without syncing its parent entry.
  for (;;) {
    await syncDirectory(current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function withDurableStage(
  path: string,
  text: string,
  mode: number | undefined,
  publish: (temporary: string) => Promise<void>,
): Promise<void> {
  await durableDirectory(dirname(path));
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const stage = await open(temporary, "wx", 0o600);
  try {
    await stage.writeFile(text, "utf8");
    if (mode !== undefined) await stage.chmod(mode);
    await stage.sync();
    await publish(temporary);
  } finally {
    try {
      await stage.close();
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Sync before replacement; a post-publication directory-sync failure still requires recovery. */
export function writeDurableAtomic(
  path: string,
  text: string,
  options: { mode?: number; beforePublish?: () => Promise<void> } = {},
): Promise<void> {
  return withFileLock(path, () =>
    withDurableStage(path, text, options.mode, async (temporary) => {
      await options.beforePublish?.();
      await rename(temporary, path);
      await syncDirectory(await realpath(dirname(path)));
    }),
  );
}

async function verifyDurableExisting(path: string, text: string): Promise<void> {
  try {
    const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const identity = await existing.stat();
      if (!identity.isFile()) throw new Error("Existing target is not a regular file.");
      if (!(await existing.readFile()).equals(Buffer.from(text, "utf8")))
        throw new Error("Existing target bytes differ from the complete expected content.");
      await existing.sync();
      const current = await lstat(path);
      if (!current.isFile() || current.ino !== identity.ino || current.dev !== identity.dev)
        throw new Error("Existing target changed during validation.");
    } finally {
      await existing.close();
    }
  } catch (error) {
    throw new Error(
      `Durable publication refused for ${path}; recover the existing target without overwriting it.`,
      {
        cause: error,
      },
    );
  }
}

/** A no-replace publication; only an exact, regular existing file is a recoverable replay. */
export function publishDurableExclusive(path: string, text: string, mode?: number): Promise<void> {
  return withFileLock(path, () =>
    withDurableStage(path, text, mode, async (temporary) => {
      try {
        await link(temporary, path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        await verifyDurableExisting(path, text);
      }
      await syncDirectory(await realpath(dirname(path)));
    }),
  );
}
