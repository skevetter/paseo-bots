import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { McpServerConfig, McpTool } from "../shared/bot";
import { browserUnreachableMessage, browserUrlOf } from "../shared/browser";
import { PLUGIN_VERSION } from "../shared/version";
import { deadline } from "./composio";

const TIMEOUT_MS = 30_000;
const BROWSER_TIMEOUT_MS = 3_000;
const MAX_TOOLS = 200;
const MAX_PAGES = 5;
const PROTOCOL_VERSION = "2025-06-18";

export type ProbeResult = { ok: true; tools: McpTool[] } | { ok: false; error: string };

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { message?: string };
}

type Request = (method: string, params?: unknown) => Promise<unknown>;
type Notify = (method: string) => Promise<void>;

const initializeParams = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "paseo-bots", version: PLUGIN_VERSION },
};

async function listTools(request: Request, notify: Notify): Promise<McpTool[]> {
  await request("initialize", initializeParams);
  await notify("notifications/initialized");
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
    const result = (await request("tools/list", cursor ? { cursor } : {})) as ToolsPage;
    tools.push(...pageTools(result));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools.slice(0, MAX_TOOLS);
}

interface ToolsPage {
  tools?: { name?: unknown; description?: unknown }[];
  nextCursor?: string;
}

function pageTools(page: ToolsPage): McpTool[] {
  const tools: McpTool[] = [];
  for (const tool of page.tools ?? []) {
    if (typeof tool.name !== "string") continue;
    const description =
      typeof tool.description === "string" ? tool.description.split("\n")[0].slice(0, 300) : "";
    tools.push({ name: tool.name, description });
  }
  return tools;
}

function completePieces(buffer: string, separator: string): { pieces: string[]; rest: string } {
  const pieces = buffer.split(separator);
  const rest = pieces.pop() ?? "";
  return { pieces, rest };
}

function parseMessage(line: string): JsonRpcResponse | null {
  if (!line) return null;
  try {
    return JSON.parse(line) as JsonRpcResponse;
  } catch {
    return null;
  }
}

function rpcError(response: JsonRpcResponse): Error {
  return new Error(response.error?.message || "The server returned an error.");
}

function probeStdio(
  config: Extract<McpServerConfig, { type: "stdio" }>,
  signal: AbortSignal,
): Promise<McpTool[]> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(config.command, config.args, {
      env: { ...process.env, ...config.env },
      stdio: "pipe",
    });
    let nextId = 1;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error: Error | null, tools?: McpTool[]) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      terminateProcess(child, "SIGTERM").catch((error: unknown) =>
        console.error("paseo-bots: couldn't stop an MCP server probe", error),
      );
      if (error) reject(error);
      else resolve(tools ?? []);
    };
    const onAbort = () =>
      finish(new Error(`No answer within ${TIMEOUT_MS / 1000} seconds.${lastLine(stderr)}`));
    signal.addEventListener("abort", onAbort);

    child.on("error", (error) => finish(new Error(`Couldn't start "${config.command}": ${error.message}`)));
    child.on("exit", (code) =>
      finish(
        new Error(
          `The server exited${code === null ? "" : ` with code ${code}`} before answering.${lastLine(stderr)}`,
        ),
      ),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    const deliver = (message: JsonRpcResponse) => {
      const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (!waiter) return;
      pending.delete(message.id as number);
      if (message.error) waiter.reject(rpcError(message));
      else waiter.resolve(message.result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const { pieces, rest } = completePieces(stdout + chunk.toString("utf8"), "\n");
      stdout = rest;
      for (const line of pieces) {
        const message = parseMessage(line.trim());
        if (message) deliver(message);
      }
    });

    const write = (payload: object) => child.stdin.write(`${JSON.stringify(payload)}\n`);
    const request: Request = (method, params) =>
      new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      });
    const notify: Notify = async (method) => {
      write({ jsonrpc: "2.0", method });
    };
    listTools(request, notify).then(
      (tools) => finish(null, tools),
      (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function lastLine(stderr: string): string {
  const line = stderr.trim().split("\n").pop()?.trim();
  return line ? ` ${line.slice(0, 300)}` : "";
}

async function* serverEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      const { pieces, rest } = completePieces(
        buffer + decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n"),
        "\n\n",
      );
      buffer = rest;
      for (const block of pieces) {
        const parsed = parseEvent(block);
        if (parsed) yield parsed;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function parseEvent(block: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

async function readAnswer(response: Response, id: number): Promise<JsonRpcResponse | undefined> {
  const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  if (!streamed || !response.body) return (await response.json()) as JsonRpcResponse;
  for await (const { data } of serverEvents(response.body)) {
    const parsed = JSON.parse(data) as JsonRpcResponse;
    if (parsed.id === id) return parsed;
  }
  return undefined;
}

async function nextMatch<T>(
  events: AsyncGenerator<{ event: string; data: string }>,
  pick: (message: { event: string; data: string }) => T | null,
): Promise<T | null> {
  for (;;) {
    const next = await events.next();
    if (next.done) return null;
    const picked = pick(next.value);
    if (picked !== null) return picked;
  }
}

async function awaitAnswer(
  events: AsyncGenerator<{ event: string; data: string }>,
  id: number,
): Promise<unknown> {
  const answer = await nextMatch(events, ({ event, data }) => {
    if (event !== "message") return null;
    const parsed = JSON.parse(data) as JsonRpcResponse;
    return parsed.id === id ? parsed : null;
  });
  if (!answer) throw new Error("The server closed the connection without answering.");
  if (answer.error) throw rpcError(answer);
  return answer.result;
}

async function httpFailure(response: Response): Promise<Error> {
  const text = (await response.text().catch(() => "")).trim().slice(0, 200);
  const hint =
    response.status === 401 || response.status === 403
      ? " Check the server's headers (for example an Authorization token)."
      : "";
  return new Error(`The server answered ${response.status}${text ? `: ${text}` : "."}${hint}`);
}

/** Streamable HTTP: every message is a POST; answers come back as JSON or as a short event stream. */
async function probeHttp(
  config: Extract<McpServerConfig, { type: "http" }>,
  signal: AbortSignal,
): Promise<McpTool[]> {
  let sessionId: string | null = null;
  let nextId = 1;
  const post = (payload: object) =>
    fetch(config.url, {
      method: "POST",
      signal,
      headers: {
        ...config.headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(payload),
    });
  const request: Request = async (method, params) => {
    const id = nextId++;
    const response = await post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    if (!response.ok) throw await httpFailure(response);
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const message = await readAnswer(response, id);
    if (!message) throw new Error("The server closed the connection without answering.");
    if (message.error) throw rpcError(message);
    return message.result;
  };
  const notify: Notify = async (method) => {
    const response = await post({ jsonrpc: "2.0", method });
    await response.body?.cancel().catch(() => {});
  };
  try {
    return await listTools(request, notify);
  } finally {
    if (sessionId) {
      void fetch(config.url, {
        method: "DELETE",
        headers: { ...config.headers, "Mcp-Session-Id": sessionId },
      }).catch(() => {});
    }
  }
}

/** The older HTTP+SSE transport: an event stream names a URL to POST to, and answers arrive on the stream. */
async function probeSse(
  config: Extract<McpServerConfig, { type: "sse" }>,
  signal: AbortSignal,
): Promise<McpTool[]> {
  const stream = await fetch(config.url, {
    signal,
    headers: { ...config.headers, Accept: "text/event-stream" },
  });
  if (!stream.ok || !stream.body) throw await httpFailure(stream);
  const events = serverEvents(stream.body);
  try {
    const endpoint = await nextMatch(events, ({ event, data }) =>
      event === "endpoint" ? new URL(data, config.url).toString() : null,
    );
    if (!endpoint) throw new Error("The server's event stream didn't say where to send messages.");
    let nextId = 1;
    const send = async (payload: object) => {
      const response = await fetch(endpoint, {
        method: "POST",
        signal,
        headers: { ...config.headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw await httpFailure(response);
      await response.body?.cancel().catch(() => {});
    };
    const request: Request = async (method, params) => {
      const id = nextId++;
      await send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      return awaitAnswer(events, id);
    };
    return await listTools(request, (method) => send({ jsonrpc: "2.0", method }));
  } finally {
    await events.return(undefined);
  }
}

function redact(text: string, config: McpServerConfig): string {
  const secrets = Object.values(config.type === "stdio" ? config.env : config.headers).filter(
    (value) => value.length >= 4,
  );
  return secrets.reduce((out, secret) => out.split(secret).join("•••"), text);
}

/** chrome-devtools-mcp lists its tools without the browser, so check the browser is listening first. */
async function browserAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/json/version", url), { signal: deadline(BROWSER_TIMEOUT_MS) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function probe(config: McpServerConfig, signal: AbortSignal): Promise<McpTool[]> {
  if (config.type === "http") return probeHttp(config, signal);
  if (config.type === "sse") return probeSse(config, signal);
  const browserUrl = browserUrlOf(config);
  if (browserUrl && !(await browserAnswers(browserUrl)))
    throw new Error(browserUnreachableMessage(browserUrl));
  return probeStdio(config, signal);
}

function failureMessage(error: unknown, aborted: boolean): string {
  const ownTimeout = error instanceof Error && error.message.startsWith("No answer");
  if (aborted && !ownTimeout) return `No answer within ${TIMEOUT_MS / 1000} seconds.`;
  return error instanceof Error ? error.message : String(error);
}

export async function probeMcpServer({ config }: { config: McpServerConfig }): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const tools = await probe(config, controller.signal);
    return { ok: true, tools };
  } catch (error) {
    return { ok: false, error: redact(failureMessage(error, controller.signal.aborted), config) };
  } finally {
    clearTimeout(timer);
  }
}
