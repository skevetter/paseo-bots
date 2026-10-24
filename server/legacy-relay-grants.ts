import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { pluginDataPath } from "./bot-home";
import { publishDurableExclusive } from "./files";

// Immutable authorization receipts for legacy chats. A receipt holds only the relay grant captured at
// admission. It never carries a prompt, model, environment, credential, or execution authority.

const MAX_BYTES = 64 * 1024;
const ID = /^[a-z0-9-]+$/;

const Permissions = z.strictObject({
  contactBots: z.enum(["ask", "allow", "off"]),
  apps: z.array(z.string().min(1)),
  appLimits: z.record(
    z.string(),
    z.strictObject({
      tools: z.array(z.string()).nullable(),
      account: z.strictObject({ id: z.string(), alias: z.string().nullable() }).nullable(),
    }),
  ),
});

const Body = z.strictObject({
  version: z.literal(1),
  botId: z.string().regex(ID),
  agentId: z.string().regex(ID),
  frozen: z.strictObject({ tools: z.boolean(), apps: z.boolean() }),
  permissions: Permissions,
});
type Body = z.infer<typeof Body>;

const File = z.strictObject({ body: Body, checksum: z.string() });

export class LegacyRelayGrantError extends Error {
  constructor(detail: string) {
    super(`Legacy relay grant ${detail}.`);
    this.name = "LegacyRelayGrantError";
  }
}

export interface LegacyRelayGrant {
  botId: string;
  agentId: string;
  frozen: { tools: boolean; apps: boolean };
  permissions: z.infer<typeof Permissions>;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** One receipt per agent under a fixed on-disk layout; the filename digest keeps raw agent IDs out of paths. */
function receiptPath(agentId: string): string {
  return join(receiptDirectory(), `${digest(agentId)}.json`);
}

function receiptDirectory(): string {
  return join(pluginDataPath(), "legacy-relay-grants");
}

async function privateNamespace(create: boolean): Promise<boolean> {
  let directory: FileHandle;
  try {
    if (create) await mkdir(receiptDirectory(), { recursive: true, mode: 0o700 });
    directory = await open(
      receiptDirectory(),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (!create && error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw new LegacyRelayGrantError("namespace is unavailable or is not a real directory");
  }
  try {
    if (((await directory.stat()).mode & 0o077) !== 0)
      throw new LegacyRelayGrantError("namespace is accessible to other users");
    return true;
  } finally {
    await directory.close();
  }
}

function parseBody(value: unknown): Body {
  const result = Body.safeParse(value);
  if (!result.success) throw new LegacyRelayGrantError("is malformed");
  return result.data;
}

/** Stable writer bytes for checksum validation and immutable no-replace replay. */
function render(body: Body): string {
  return `${JSON.stringify({ body, checksum: digest(JSON.stringify(body)) }, null, 2)}\n`;
}

function parseFile(raw: string): z.infer<typeof File> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LegacyRelayGrantError("is undecodable");
  }
  const result = File.safeParse(json);
  if (!result.success) throw new LegacyRelayGrantError("is malformed or unsupported");
  return result.data;
}

function decode(raw: string, agentId: string): LegacyRelayGrant {
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new LegacyRelayGrantError("is too large");
  const file = parseFile(raw);
  if (file.checksum !== digest(JSON.stringify(file.body)))
    throw new LegacyRelayGrantError("failed its checksum");
  if (file.body.agentId !== agentId) throw new LegacyRelayGrantError("names another agent");
  return {
    botId: file.body.botId,
    agentId: file.body.agentId,
    frozen: file.body.frozen,
    permissions: file.body.permissions,
  };
}

/**
 * Publishes the receipt before the caller hands out any native MCP config. An exact replay succeeds;
 * a different grant for the same agent is refused and the existing receipt is left untouched.
 */
export async function publishLegacyRelayGrant(grant: LegacyRelayGrant): Promise<void> {
  const body = parseBody({
    version: 1,
    botId: grant.botId,
    agentId: grant.agentId,
    frozen: { tools: grant.frozen.tools, apps: grant.frozen.apps },
    permissions: grant.permissions,
  });
  const text = render(body);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new LegacyRelayGrantError("is too large");
  await privateNamespace(true);
  await readReceipt(grant.agentId);
  try {
    await publishDurableExclusive(receiptPath(grant.agentId), text, 0o600);
  } catch {
    throw new LegacyRelayGrantError("conflicts with or could not be published over the existing receipt");
  }
}

/** Missing returns null; any other unreadable, symlinked, oversized, or malformed receipt throws. */
export async function readLegacyRelayGrant(agentId: string): Promise<LegacyRelayGrant | null> {
  if (!ID.test(agentId)) return null;
  if (!(await privateNamespace(false))) return null;
  return readReceipt(agentId);
}

async function readReceipt(agentId: string): Promise<LegacyRelayGrant | null> {
  let handle: FileHandle;
  try {
    handle = await open(
      receiptPath(agentId),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new LegacyRelayGrantError("is unreadable");
  }
  try {
    const identity = await handle.stat();
    if (!identity.isFile()) throw new LegacyRelayGrantError("is not a regular file");
    if ((identity.mode & 0o077) !== 0) throw new LegacyRelayGrantError("is accessible to other users");
    if (identity.size > MAX_BYTES) throw new LegacyRelayGrantError("is too large");
    return decode((await handle.readFile()).toString("utf8"), agentId);
  } finally {
    await handle.close();
  }
}
