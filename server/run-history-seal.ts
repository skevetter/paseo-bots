import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { publishDurableExclusive } from "./files";

export class RunHistoryIntegrityError extends Error {
  constructor(detail: string) {
    super(
      `Run history requires explicit recovery; preserve the history, initialized marker, artifacts and backups before repair: ${detail}`,
    );
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function markerText(path: string): string {
  const body = { version: 1, kind: "paseo-bots-managed-history", path };
  return `${JSON.stringify({ ...body, sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") })}\n`;
}

/** Metadata and seals must be regular UTF-8 files; never follow a substituted symlink. */
export async function readHistoryText(path: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new RunHistoryIntegrityError(`${path} is not a regular file`);
    const bytes = await handle.readFile();
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes))
      throw new RunHistoryIntegrityError(`${path} is not valid UTF-8`);
    return text;
  } finally {
    await handle.close();
  }
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function artifactEvidence(path: string): Promise<boolean> {
  const directory = join(dirname(path), "run-artifacts");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new RunHistoryIntegrityError("artifact directory is not a regular directory");
    return (await readdir(directory)).length > 0;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function priorEvidence(path: string): Promise<"managed" | "legacy" | null> {
  if ((await present(`${path}.v2.bak`)) || (await present(`${path}.v3.bak`))) return "managed";
  if (await artifactEvidence(path)) return "managed";
  for (const suffix of [".pre-run-store", ".v1.bak"]) if (await present(`${path}${suffix}`)) return "legacy";
  return null;
}

export async function inspectHistorySeal(
  path: string,
): Promise<{ sealed: boolean; known: boolean; managed: boolean }> {
  const marker = await readHistoryText(`${path}.initialized`);
  if (marker !== null) {
    if (marker !== markerText(path))
      throw new RunHistoryIntegrityError("initialized marker is invalid or belongs to another path");
    return { sealed: true, known: true, managed: true };
  }
  const evidence = await priorEvidence(path);
  return { sealed: false, known: evidence !== null, managed: evidence === "managed" };
}

/** Called only after authoritative bytes are durable, before exposing them to execution. */
export function sealHistory(path: string): Promise<void> {
  return publishDurableExclusive(`${path}.initialized`, markerText(path), 0o600);
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function legacyRecord(value: unknown): boolean {
  if (value === null) return true;
  return (
    object(value) &&
    ["lastRunAt", "runs", "lastStatus", "lastError", "lastAgentId"].some((field) => field in value)
  );
}

function recognizableLegacy(saved: Record<string, unknown>): boolean {
  if (saved.version === 0 || saved.version === 1) return object(saved.routines);
  const entries = Object.values(saved);
  return saved.version === undefined && entries.length > 0 && entries.every(legacyRecord);
}

function referencesManagedRun(value: unknown): boolean {
  if (!object(value) || !Array.isArray(value.runs)) return false;
  return value.runs.some((run) => object(run) && object(run.managed));
}

function recognizableManagedLegacy(saved: Record<string, unknown>): boolean {
  return (
    saved.version === 1 &&
    object(saved.coordinator) &&
    object(saved.routines) &&
    Object.values(saved.routines).some(referencesManagedRun)
  );
}

/** An initialized store must never reinterpret lost managed bytes as a fresh legacy store. */
export function requireRecognizableHistory(raw: string | null, sealed: boolean, managed: boolean): void {
  if (raw === null)
    throw new RunHistoryIntegrityError(
      "known history is missing; automatic empty initialization is forbidden",
    );
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    throw new RunHistoryIntegrityError("known history is empty or malformed; file left unchanged");
  }
  if (!object(saved)) throw new RunHistoryIntegrityError("known history is not an envelope");
  if (typeof saved.version === "number" && saved.version >= 2) return;
  if (sealed)
    throw new RunHistoryIntegrityError(
      "initialized managed history was replaced with a legacy or unrecognizable document",
    );
  if (managed && !recognizableManagedLegacy(saved))
    throw new RunHistoryIntegrityError(
      "managed evidence has no recognizable supported migration envelope; file left unchanged",
    );
  if (recognizableLegacy(saved)) return;
  throw new RunHistoryIntegrityError(
    "prior managed evidence exists but history is unrecognizable; file left unchanged",
  );
}
