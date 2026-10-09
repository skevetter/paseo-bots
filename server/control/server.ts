import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { json, readMessage, refuseNonPost, tokenMatches } from "../mcp-http";
import { answerMcp } from "../tools/mcp";
import { controlToken, publishControl, rotateControlToken, unpublishControl } from "./files";
import { installShim } from "./shim";
import type { ControlContext, ControlTool } from "./tool";

export const CONTROL_PORT = 6898;
const PATH = "/mcp";

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(address && typeof address === "object" ? address.port : port);
    });
  });
}

/** The external control endpoint: MCP over HTTP on 127.0.0.1, with its own bearer token. */
export class ControlServer {
  private server: Server | null = null;
  private token: string | null = null;
  private address: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly context: ControlContext,
    private readonly tools: readonly ControlTool[],
    private readonly port = CONTROL_PORT,
  ) {}

  get url(): string | null {
    return this.address;
  }

  /** Takes its usual port, or any free one when that's taken. */
  start(): Promise<string> {
    return this.serial(() => this.open());
  }

  stop(): Promise<void> {
    return this.serial(() => this.close());
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async open(): Promise<string> {
    if (this.address) return this.address;
    this.token = await controlToken();
    const server = createServer((request, response) => void this.handle(request, response));
    const port = await listen(server, this.port).catch(() => listen(server, 0));
    server.on("error", (error) => console.error("paseo-bots: the control server failed", error));
    this.server = server;
    this.address = `http://127.0.0.1:${port}${PATH}`;
    await installShim();
    await publishControl(this.address);
    return this.address;
  }

  private async close(): Promise<void> {
    const { server } = this;
    this.server = null;
    this.address = null;
    await unpublishControl();
    if (!server) return;
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }

  async rotate(): Promise<void> {
    this.token = await rotateControlToken();
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      await this.dispatch(request, response);
    } catch (error) {
      if (response.headersSent || response.destroyed) response.destroy();
      else
        json(response, 500, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
    }
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse) {
    if ((request.url ?? "").split("?")[0] !== PATH) return json(response, 404, { error: "not found" });
    // Browsers send an Origin; MCP clients don't.
    if (request.headers.origin) return json(response, 403, { error: "forbidden" });
    if (!this.token || !tokenMatches(this.token, request.headers.authorization))
      return json(response, 401, { error: "unauthorized" });
    if (refuseNonPost(request, response)) return;
    const message = await readMessage(request, response);
    if (!message) return;
    const answer = await answerMcp(message, { name: "paseo-bots-control", tools: this.tools }, this.context);
    if (!answer) return response.writeHead(202).end();
    json(response, 200, answer);
  }
}
