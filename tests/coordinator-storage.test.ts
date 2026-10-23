import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoordinatorLock } from "../server/coordinator-lock";
import { RunArtifacts } from "../server/run-artifacts";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-coordinator-storage-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("immutable execution artifacts", () => {
  it("publishes private digest-addressed JSON and reopens without replacing the inode", async () => {
    const artifacts = new RunArtifacts(directory);
    const value = { provider: "omp", config: { token: "restricted-snapshot" }, prompt: "tea ☕" };
    const sha256 = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const ref = await artifacts.put(value);
    expect(ref).toEqual({ id: sha256, sha256 });
    const path = join(directory, "run-artifacts", `${ref.id}.json`);
    const before = await stat(path);
    expect(before.mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "run-artifacts"))).mode & 0o777).toBe(0o700);
    const reopened = new RunArtifacts(directory);
    expect(await reopened.get(ref)).toEqual(value);
    expect(await reopened.put(value)).toEqual(ref);
    const after = await stat(path);
    expect({ ino: after.ino, mtime: after.mtimeMs }).toEqual({ ino: before.ino, mtime: before.mtimeMs });
  });

  it("allows concurrent publication of identical content without losing either reference", async () => {
    const first = new RunArtifacts(directory);
    const second = new RunArtifacts(directory);
    const value = { permissionEnvelope: ["read"] };
    const [a, b] = await Promise.all([first.put(value), second.put(value)]);
    expect(a).toEqual(b);
    expect(await first.get(a)).toEqual(value);
    expect(await second.get(b)).toEqual(value);
  });

  it("rejects tampering on read and refuses to repair a previously published digest", async () => {
    const artifacts = new RunArtifacts(directory);
    const value = { prompt: "original" };
    const ref = await artifacts.put(value);
    const path = join(directory, "run-artifacts", `${ref.id}.json`);
    const tampered = JSON.stringify({ prompt: "replaced" });
    await writeFile(path, tampered);
    await expect(artifacts.get(ref)).rejects.toThrow("digest mismatch");
    await expect(artifacts.put(value)).rejects.toThrow("digest mismatch");
    expect(await readFile(path, "utf8")).toBe(tampered);
  });
});

describe("artifact path boundaries", () => {
  it.each(["../private", "/tmp/private", "a/../../private", "A".repeat(64), "a".repeat(63)])(
    "rejects invalid artifact ID %s before reading outside storage",
    async (id) => {
      const artifacts = new RunArtifacts(directory);
      await expect(artifacts.get({ id, sha256: id })).rejects.toThrow("Invalid run artifact reference");
    },
  );

  it("rejects a reference whose digest does not name its content address", async () => {
    const artifacts = new RunArtifacts(directory);
    const ref = await artifacts.put({ prompt: "original" });
    await expect(artifacts.get({ ...ref, sha256: "0".repeat(64) })).rejects.toThrow(
      "Invalid run artifact reference",
    );
  });

  it("does not follow an artifact symlink even when the external bytes have the expected digest", async () => {
    const artifacts = new RunArtifacts(directory);
    const value = { secret: "outside" };
    const text = JSON.stringify(value);
    const sha256 = createHash("sha256").update(text).digest("hex");
    await mkdir(join(directory, "run-artifacts"));
    const external = join(directory, "external.json");
    await writeFile(external, text);
    await symlink(external, join(directory, "run-artifacts", `${sha256}.json`));
    await expect(artifacts.get({ id: sha256, sha256 })).rejects.toThrow();
    await expect(artifacts.put(value)).rejects.toThrow();
    expect(await readFile(external, "utf8")).toBe(text);
  });

  it("rejects non-JSON input instead of publishing an unusable reference", async () => {
    const artifacts = new RunArtifacts(directory);
    await expect(artifacts.put(undefined)).rejects.toThrow("must contain JSON");
    await expect(artifacts.put(1n)).rejects.toThrow();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(artifacts.put(cyclic)).rejects.toThrow();
  });
});

describe("coordinator lock contention", () => {
  it("refuses another instance, repeated acquisition and overlapping acquisition in the same process", async () => {
    const owner = new CoordinatorLock(directory);
    const pending = owner.acquire();
    await expect(owner.acquire()).rejects.toThrow("already acquired");
    await pending;
    await expect(owner.acquire()).rejects.toThrow("already acquired");
    await expect(new CoordinatorLock(directory).acquire()).rejects.toThrow("recover it manually");
    expect((await stat(join(directory, "coordinator.lock"))).mode & 0o777).toBe(0o600);
    await owner.release();
    const next = new CoordinatorLock(directory);
    await next.acquire();
    await next.release();
  });

  it("enforces ownership against a real second process and permits it after release", async () => {
    const owner = new CoordinatorLock(directory);
    const moduleUrl = new URL("../server/coordinator-lock.ts", import.meta.url).href;
    const source = `
      import { CoordinatorLock } from ${JSON.stringify(moduleUrl)};
      const lock = new CoordinatorLock(${JSON.stringify(directory)});
      try { await lock.acquire(); await lock.release(); }
      catch (error) { console.error(error.message); process.exitCode = 2; }
    `;
    const args = ["--experimental-strip-types", "--input-type=module", "-e", source];
    await owner.acquire();
    await expect(promisify(execFile)(process.execPath, args)).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("recover it manually"),
    });
    await owner.release();
    await promisify(execFile)(process.execPath, args);
    await expect(stat(join(directory, "coordinator.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never steals a stale, foreign-host or malformed lock", async () => {
    const path = join(directory, "coordinator.lock");
    for (const text of [
      JSON.stringify({ pid: 2147483647, hostname: "retired-host", token: "stale" }),
      "{interrupted write",
    ]) {
      await writeFile(path, text);
      const contender = new CoordinatorLock(directory);
      await expect(contender.acquire()).rejects.toThrow("recover it manually");
      await contender.release();
      expect(await readFile(path, "utf8")).toBe(text);
    }
  });
});

describe("coordinator lock ownership changes", () => {
  it("does not release a replacement inode even when the original token is copied", async () => {
    const owner = new CoordinatorLock(directory);
    await owner.acquire();
    const path = join(directory, "coordinator.lock");
    const original = await readFile(path, "utf8");
    await rename(path, `${path}.retired`);
    await writeFile(path, original);
    await expect(owner.release()).rejects.toThrow("ownership changed");
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(new CoordinatorLock(directory).acquire()).rejects.toThrow("recover it manually");
  });

  it("does not release an unchanged inode whose ownership token was replaced", async () => {
    const owner = new CoordinatorLock(directory);
    await owner.acquire();
    const path = join(directory, "coordinator.lock");
    const original = JSON.parse(await readFile(path, "utf8"));
    const replacement = JSON.stringify({ ...original, token: "new-owner" });
    const before = await stat(path);
    await writeFile(path, replacement);
    expect((await stat(path)).ino).toBe(before.ino);
    await expect(owner.release()).rejects.toThrow("ownership changed");
    expect(await readFile(path, "utf8")).toBe(replacement);
  });
});
