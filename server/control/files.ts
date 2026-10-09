import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pluginDataPath } from "../bot-home";
import { writeAtomic, writeJson } from "../files";

const TOKEN = /^[a-f0-9]{64}$/;

export function controlPaths() {
  const root = pluginDataPath();
  return {
    tokenFile: join(root, "control-token"),
    infoFile: join(root, "control.json"),
    shim: join(root, "bin", "paseo-bots-mcp"),
  };
}

export async function rotateControlToken(): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await writeAtomic(controlPaths().tokenFile, token, 0o600);
  return token;
}

/** Made once and kept until it's rotated. */
export async function controlToken(): Promise<string> {
  const saved = (await readFile(controlPaths().tokenFile, "utf8").catch(() => "")).trim();
  return TOKEN.test(saved) ? saved : rotateControlToken();
}

/** What the stdio shim reads to find the endpoint; only there while it listens. */
export async function publishControl(url: string): Promise<void> {
  await writeJson(controlPaths().infoFile, { url, tokenFile: controlPaths().tokenFile }, 0o600);
}

export async function unpublishControl(): Promise<void> {
  await rm(controlPaths().infoFile, { force: true });
}
