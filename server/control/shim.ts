import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { controlPaths } from "./files";

const LAUNCHER = `#!/bin/sh
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v bun >/dev/null 2>&1; then exec bun "$dir/paseo-bots-mcp.mjs" "$@"; fi
exec node "$dir/paseo-bots-mcp.mjs" "$@"
`;

/** MCP over stdio for clients that start a command: each line goes to the control endpoint control.json names. */
const SCRIPT = `import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const infoFile = join(dirname(fileURLToPath(import.meta.url)), "..", "control.json");
const OFF =
  "paseo-bots external control isn't reachable. Turn on Settings > Bots > External control (MCP) in Paseo and check that Paseo is running.";
let endpoint = null;

async function locate() {
  const info = JSON.parse(await readFile(infoFile, "utf8"));
  const token = (await readFile(info.tokenFile, "utf8")).trim();
  return { url: info.url, token };
}

async function post(body, fresh) {
  if (fresh || !endpoint) endpoint = await locate();
  return fetch(endpoint.url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + endpoint.token,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body,
  });
}

async function send(body) {
  try {
    const response = await post(body, false);
    return response.status === 401 ? await post(body, true) : response;
  } catch {
    return post(body, true);
  }
}

function failure(id, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

async function forward(line) {
  let id = null;
  try {
    id = JSON.parse(line).id ?? null;
  } catch {
    return failure(null, "Parse error");
  }
  let response;
  try {
    response = await send(line);
  } catch {
    return id === null ? null : failure(id, OFF);
  }
  if (response.status === 202) return null;
  const text = await response.text();
  try {
    if (JSON.parse(text).jsonrpc === "2.0") return text;
  } catch {}
  return id === null ? null : failure(id, "The control endpoint answered " + response.status + ": " + text);
}

let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  queue = queue.then(async () => {
    const answer = await forward(line);
    if (answer) process.stdout.write(answer.replace(/\\n/g, " ") + "\\n");
  });
});
`;

/** Written next to control.json, so the command stays the same across plugin versions and ports. */
export async function installShim(): Promise<string> {
  const launcher = controlPaths().shim;
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(`${launcher}.mjs`, SCRIPT, "utf8");
  await writeFile(launcher, LAUNCHER, "utf8");
  await chmod(launcher, 0o755);
  return launcher;
}
