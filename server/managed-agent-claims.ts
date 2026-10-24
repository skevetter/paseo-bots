import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { publishDurableExclusive } from "./files";
import { RunHistoryIntegrityError, readHistoryText } from "./run-history-seal";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

export class ManagedAgentClaimsError extends RunHistoryIntegrityError {
  constructor(detail: string) {
    super(
      `managed-agent claim coverage: ${detail}. Preserve the claim namespace too; restore intact provenance and explicitly run RunStore.backfillManagedAgentClaims() before permitting unclaimed execution`,
    );
  }
}

/** Scoping obligations only: a claim never supplies an execution identity, receipt or permission. */
export class ManagedAgentClaims {
  private readonly directory: string;
  private readonly published = new Set<string>();
  private covered = false;

  constructor(private readonly historyPath: string) {
    this.directory = `${historyPath}.managed-agents`;
  }

  private text(agentId?: string): string {
    return `${JSON.stringify({
      version: 1,
      kind: agentId === undefined ? "paseo-bots-managed-agent-coverage" : "paseo-bots-managed-agent-claim",
      path: this.historyPath,
      ...(agentId === undefined ? {} : { agentId }),
    })}\n`;
  }

  private target(agentId: string): string {
    return join(this.directory, `${digest(JSON.stringify(agentId))}.json`);
  }

  private async inspectDirectory(): Promise<boolean> {
    let info: Stats;
    try {
      info = await lstat(this.directory);
    } catch (error) {
      if (!missing(error)) throw error;
      if (this.covered || this.published.size > 0)
        throw new ManagedAgentClaimsError("the previously observed namespace disappeared");
      return false;
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ManagedAgentClaimsError("the namespace is not a regular directory");
    const handle = await open(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await handle.close();
    return true;
  }

  async hasCoverage(): Promise<boolean> {
    if (!(await this.inspectDirectory())) return false;
    const raw = await readHistoryText(join(this.directory, "coverage.json"));
    if (raw === null) {
      if (this.covered) throw new ManagedAgentClaimsError("the completion marker disappeared");
      return false;
    }
    if (raw !== this.text()) throw new ManagedAgentClaimsError("invalid or unsupported completion marker");
    this.covered = true;
    return true;
  }

  async has(agentId: string): Promise<boolean> {
    if (!(await this.inspectDirectory())) return false;
    const raw = await readHistoryText(this.target(agentId));
    if (raw === null) {
      if (this.published.has(agentId)) throw new ManagedAgentClaimsError("a published claim disappeared");
      return false;
    }
    if (raw !== this.text(agentId))
      throw new ManagedAgentClaimsError("invalid, mismatching or unsupported exact-agent claim");
    return true;
  }

  async inventory(): Promise<Set<string>> {
    const ids = new Set<string>();
    if (!(await this.inspectDirectory())) return ids;
    for (const name of await readdir(this.directory)) {
      if (name === "coverage.json" || /^(?:[a-f0-9]{64}|coverage)\.json\.[a-f0-9]{16}\.tmp$/.test(name))
        continue;
      if (!/^[a-f0-9]{64}\.json$/.test(name))
        throw new ManagedAgentClaimsError(`unrecognized claim namespace entry ${name}`);
      const path = join(this.directory, name);
      ids.add(this.decodeClaim(await readHistoryText(path), path));
    }
    return ids;
  }

  private decodeClaim(raw: string | null, path: string): string {
    let value: unknown;
    try {
      value = raw === null ? null : JSON.parse(raw);
    } catch {
      throw new ManagedAgentClaimsError(`undecodable retained claim ${path}`);
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("agentId" in value) ||
      typeof value.agentId !== "string" ||
      path !== this.target(value.agentId) ||
      raw !== this.text(value.agentId)
    )
      throw new ManagedAgentClaimsError(`invalid retained claim ${path}`);
    return value.agentId;
  }

  private async prepareDirectory(): Promise<void> {
    if (!(await this.inspectDirectory())) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.inspectDirectory();
  }

  async publish(agentIds: Iterable<string>): Promise<void> {
    await this.prepareDirectory();
    for (const agentId of new Set(agentIds)) {
      if (this.published.has(agentId)) {
        await this.has(agentId);
        continue;
      }
      await publishDurableExclusive(this.target(agentId), this.text(agentId), 0o600);
      this.published.add(agentId);
    }
  }

  /** Only the owning storage boundary may attest that all pre-existing evidence has been inventoried. */
  async complete(): Promise<void> {
    await this.prepareDirectory();
    await publishDurableExclusive(join(this.directory, "coverage.json"), this.text(), 0o600);
    this.covered = true;
  }
}

async function artifactDirectoryExists(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ManagedAgentClaimsError("artifact namespace is not a regular directory");
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** Inventory immutable retained launch snapshots without RunArtifacts.get's mkdir/chmod effects. */
export async function retainedArtifactAgentIds(historyPath: string): Promise<Set<string>> {
  const directory = join(dirname(historyPath), "run-artifacts");
  if (!(await artifactDirectoryExists(directory))) return new Set();
  const ids = new Set<string>();
  for (const name of await readdir(directory)) {
    // Stages cannot have been referenced by authoritative metadata or used for host creation.
    if (/^\.[a-f0-9-]{36}\.stage(?:\.[a-f0-9]{8}\.tmp)?$/.test(name)) continue;
    const match = /^([a-f0-9]{64})\.json$/.exec(name);
    if (!match) throw new ManagedAgentClaimsError(`unrecognized retained artifact ${name}`);
    const raw = await readRetainedArtifact(directory, name, match[1]);
    const agentId = retainedArtifactAgentId(raw, name);
    if (agentId !== null) ids.add(agentId);
  }
  return ids;
}

async function readRetainedArtifact(directory: string, name: string, expected: string): Promise<string> {
  const raw = await readHistoryText(join(directory, name));
  if (raw === null || digest(raw) !== expected)
    throw new ManagedAgentClaimsError(`missing or damaged retained artifact ${name}`);
  return raw;
}

function retainedArtifactAgentId(raw: string, name: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ManagedAgentClaimsError(`undecodable retained artifact ${name}`);
  }
  if (!value || typeof value !== "object" || !("prepared" in value)) return null;
  const prepared = value.prepared;
  if (
    !prepared ||
    typeof prepared !== "object" ||
    !("version" in prepared) ||
    prepared.version !== 1 ||
    !("agentId" in prepared) ||
    typeof prepared.agentId !== "string"
  )
    throw new ManagedAgentClaimsError(`unreadable launch identity in retained artifact ${name}`);
  return prepared.agentId;
}
