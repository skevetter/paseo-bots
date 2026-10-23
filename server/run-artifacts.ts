import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./files";

export interface RunArtifactRef {
  id: string;
  sha256: string;
}

function artifactName(ref: RunArtifactRef): string {
  if (!/^[a-f0-9]{64}$/.test(ref.id) || ref.id !== ref.sha256)
    throw new Error("Invalid run artifact reference");
  return `${ref.id}.json`;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readArtifact(path: string, ref: RunArtifactRef): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Run artifact is not a regular file");
    const bytes = await handle.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256)
      throw new Error("Run artifact digest mismatch");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Restricted execution snapshots are published whole, without replacing an existing digest. */
export class RunArtifacts {
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, "run-artifacts");
  }

  async put(value: unknown): Promise<RunArtifactRef> {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Run artifacts must contain JSON");
    const sha256 = createHash("sha256").update(text).digest("hex");
    const ref = { id: sha256, sha256 };
    await privateDirectory(this.path);
    const target = join(this.path, artifactName(ref));
    const staged = join(this.path, `.${randomUUID()}.stage`);
    try {
      await writeAtomic(staged, text, 0o600);
      await syncPath(staged);
      await this.publish(staged, target, ref);
      await syncPath(this.path);
      return ref;
    } finally {
      await unlink(staged).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    }
  }

  async get<T>(ref: RunArtifactRef): Promise<T> {
    const name = artifactName(ref);
    await privateDirectory(this.path);
    const bytes = await readArtifact(join(this.path, name), ref);
    return JSON.parse(bytes.toString("utf8")) as T;
  }

  private async publish(staged: string, target: string, ref: RunArtifactRef): Promise<void> {
    try {
      await link(staged, target);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await readArtifact(target, ref);
    }
  }
}
