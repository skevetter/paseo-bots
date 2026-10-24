import { constants } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishDurableExclusive, writeDurableAtomic } from "../server/files";

const faults = vi.hoisted(() => ({
  stageSync: false,
  existingSyncPath: null as string | null,
  directorySyncPath: null as string | null,
  linkWindow: null as { path: string; bytes: string } | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const directoryFailure = (path: string) => (path === faults.directorySyncPath ? "directory" : null);
  const syncFailure = (path: string, flags: string | number | undefined): string | null => {
    if (flags === "wx" && faults.stageSync) return "staged-file";
    if (typeof flags === "number" && (flags & constants.O_DIRECTORY) !== 0) return directoryFailure(path);
    return path === faults.existingSyncPath ? "existing-file" : null;
  };
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const [path, flags] = args;
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        const failure = syncFailure(String(path), flags);
        if (failure) throw new Error(`Injected ${failure} sync failure`);
        await sync();
      };
      return handle;
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      const window = faults.linkWindow;
      if (window && String(args[1]) === window.path) {
        faults.linkWindow = null;
        await actual.writeFile(window.path, window.bytes, { flag: "wx", mode: 0o600 });
      }
      return actual.link(...args);
    },
  };
});

let directory: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "paseo-durable-files-")));
  faults.stageSync = false;
  faults.existingSyncPath = null;
  faults.directorySyncPath = null;
  faults.linkWindow = null;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("durable atomic replacement", () => {
  it("preserves the actual old bytes when the staged FileHandle cannot sync", async () => {
    const path = join(directory, "state.json");
    const oldBytes = Buffer.from([0, 255, 10, 42]);
    await writeFile(path, oldBytes);
    faults.stageSync = true;
    await expect(writeDurableAtomic(path, "new complete state")).rejects.toThrow("staged-file sync failure");
    expect(await readFile(path)).toEqual(oldBytes);
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("does not publish when final revision validation refuses the replacement", async () => {
    const path = join(directory, "state.json");
    await writeFile(path, "original revision");
    await expect(
      writeDurableAtomic(path, "new revision", {
        beforePublish: async () => {
          expect(await readFile(path, "utf8")).toBe("original revision");
          throw new Error("Revision conflict");
        },
      }),
    ).rejects.toThrow("Revision conflict");
    expect(await readFile(path, "utf8")).toBe("original revision");
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("replaces the complete content with private default permissions", async () => {
    const path = join(directory, "state.json");
    await writeFile(path, "old");
    await writeDurableAtomic(path, "complete new state\n");
    expect(await readFile(path, "utf8")).toBe("complete new state\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("honors an explicit file mode without making it depend on the previous inode", async () => {
    const path = join(directory, "state.json");
    await writeFile(path, "old", { mode: 0o600 });
    await writeDurableAtomic(path, "new", { mode: 0o640 });
    expect(await readFile(path, "utf8")).toBe("new");
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  it("reports directory-sync uncertainty after publication instead of claiming rollback", async () => {
    const path = join(directory, "state.json");
    await writeFile(path, "old");
    await expect(
      writeDurableAtomic(path, "published", {
        beforePublish: async () => {
          faults.directorySyncPath = directory;
        },
      }),
    ).rejects.toThrow("directory sync failure");
    expect(await readFile(path, "utf8")).toBe("published");
    expect(await readdir(directory)).toEqual(["state.json"]);
  });
});

describe("durable directory creation", () => {
  it.each(["existing parent", "first created directory", "deepest created directory"])(
    "does not publish if syncing the %s fails",
    async (failureAt) => {
      const first = join(directory, "new-parent");
      const deepest = join(first, "new-child");
      const path = join(deepest, "state.json");
      const targets: Record<string, string> = {
        "existing parent": directory,
        "first created directory": first,
        "deepest created directory": deepest,
      };
      faults.directorySyncPath = targets[failureAt] ?? null;
      await expect(writeDurableAtomic(path, "first state")).rejects.toThrow("directory sync failure");
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      faults.directorySyncPath = null;
      await writeDurableAtomic(path, "first state");
      expect(await readFile(path, "utf8")).toBe("first state");
      expect(await readdir(deepest)).toEqual(["state.json"]);
    },
  );
});

describe("precreated directory ancestry", () => {
  it.each(["replacement", "exclusive"] as const)(
    "refuses %s publication when a precreated grandparent entry cannot be synced",
    async (publication) => {
      const deepest = join(directory, "already-created", "child", "data");
      await mkdir(deepest, { recursive: true });
      const path = join(deepest, "state.json");
      faults.directorySyncPath = directory;
      const publish = publication === "replacement" ? writeDurableAtomic : publishDurableExclusive;
      await expect(publish(path, "first state")).rejects.toThrow("directory sync failure");
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(deepest)).toEqual([]);
      faults.directorySyncPath = null;
      await publish(path, "first state");
      expect(await readFile(path, "utf8")).toBe("first state");
    },
  );

  it("resolves directory aliases without accepting a symlink as an exclusive file target", async () => {
    const physical = join(directory, "physical");
    const alias = join(directory, "alias");
    await mkdir(physical);
    await symlink(physical, alias);
    await writeDurableAtomic(join(alias, "state.json"), "complete state");
    expect(await readFile(join(physical, "state.json"), "utf8")).toBe("complete state");
    await publishDurableExclusive(join(alias, "backup"), "frozen");
    expect(await readFile(join(physical, "backup"), "utf8")).toBe("frozen");
  });
});

describe("exclusive durable publication", () => {
  it("creates a complete private file, with an explicit mode when requested", async () => {
    const path = join(directory, "backup");
    await publishDurableExclusive(path, "frozen backup", 0o400);
    expect(await readFile(path, "utf8")).toBe("frozen backup");
    expect((await stat(path)).mode & 0o777).toBe(0o400);
    expect(await readdir(directory)).toEqual(["backup"]);
  });

  it("preserves a matching existing inode and permissions instead of replacing it", async () => {
    const path = join(directory, "backup");
    await writeFile(path, "same complete bytes", { mode: 0o400 });
    const original = await stat(path);
    await publishDurableExclusive(path, "same complete bytes", 0o600);
    const replay = await stat(path);
    expect(await readFile(path, "utf8")).toBe("same complete bytes");
    expect(replay.ino).toBe(original.ino);
    expect(replay.mode & 0o777).toBe(0o400);
    expect(await readdir(directory)).toEqual(["backup"]);
  });

  it.each(["partial", "different complete state"])(
    "refuses existing %s bytes without overwriting them",
    async (bytes) => {
      const path = join(directory, "backup");
      await writeFile(path, bytes);
      const original = await stat(path);
      await expect(publishDurableExclusive(path, "complete expected state")).rejects.toThrow(
        /recover.*without overwriting/i,
      );
      expect(await readFile(path, "utf8")).toBe(bytes);
      expect((await stat(path)).ino).toBe(original.ino);
      expect(await readdir(directory)).toEqual(["backup"]);
    },
  );

  it("does not confuse invalid UTF-8 with equal decoded replacement text", async () => {
    const path = join(directory, "backup");
    const original = Buffer.from([255]);
    await writeFile(path, original);
    await expect(publishDurableExclusive(path, "\uFFFD")).rejects.toThrow(/recover/i);
    expect(await readFile(path)).toEqual(original);
  });

  it("refuses even a symlink pointing to matching content", async () => {
    const target = join(directory, "real-backup");
    const path = join(directory, "backup");
    await writeFile(target, "complete expected state");
    await symlink(target, path);
    await expect(publishDurableExclusive(path, "complete expected state")).rejects.toThrow(/recover/i);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("complete expected state");
    expect((await readdir(directory)).sort()).toEqual(["backup", "real-backup"]);
  });
});

describe("exclusive publication failure windows", () => {
  it("leaves no target when syncing a new staged file fails", async () => {
    const path = join(directory, "backup");
    faults.stageSync = true;
    await expect(publishDurableExclusive(path, "complete expected state")).rejects.toThrow(
      "staged-file sync failure",
    );
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses a partial target appearing between stage sync and hardlink publication", async () => {
    const path = join(directory, "backup");
    faults.linkWindow = { path, bytes: "partial" };
    await expect(publishDurableExclusive(path, "complete expected state")).rejects.toThrow(/recover/i);
    expect(await readFile(path, "utf8")).toBe("partial");
    expect(await readdir(directory)).toEqual(["backup"]);
  });

  it("adopts a complete target appearing in the hardlink publication window", async () => {
    const path = join(directory, "backup");
    faults.linkWindow = { path, bytes: "complete expected state" };
    await publishDurableExclusive(path, "complete expected state");
    expect(await readFile(path, "utf8")).toBe("complete expected state");
    expect(await readdir(directory)).toEqual(["backup"]);
  });

  it("does not report a matching existing target durable when its inode sync fails", async () => {
    const path = join(directory, "backup");
    await writeFile(path, "complete expected state");
    const original = await stat(path);
    faults.existingSyncPath = path;
    await expect(publishDurableExclusive(path, "complete expected state")).rejects.toThrow(/recover/i);
    expect(await readFile(path, "utf8")).toBe("complete expected state");
    expect((await stat(path)).ino).toBe(original.ino);
    expect(await readdir(directory)).toEqual(["backup"]);
  });

  it("never overwrites another exclusive publisher's different content", async () => {
    const path = join(directory, "backup");
    const results = await Promise.allSettled([
      publishDurableExclusive(path, "publisher one"),
      publishDurableExclusive(path, "publisher two"),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(["publisher one", "publisher two"]).toContain(await readFile(path, "utf8"));
    expect(await readdir(directory)).toEqual(["backup"]);
  });
});
