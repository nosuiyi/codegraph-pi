/**
 * Minimal MCP (Model Context Protocol) stdio client for pi extensions.
 *
 * JSON-RPC 2.0 over stdin/stdout, with request/response correlation
 * via numeric ids and a 60s timeout per request.
 *
 * Protocol flow:
 *   1. spawn("codegraph", ["serve", "--mcp"])
 *   2. send initialize → receive capabilities
 *   3. send notifications/initialized
 *   4. tools/call for each pi tool invocation
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";

// ── Types ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Constants ──────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 60_000;

// ── Helpers ────────────────────────────────────────────────────────

/** Find the `codegraph` binary — `.cmd` on Windows, plain on POSIX. */
function codegraphCommand(): string {
  return process.platform === "win32" ? "codegraph.cmd" : "codegraph";
}

// ── Client ─────────────────────────────────────────────────────────

export class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private _ready: Promise<void> | null = null;
  private _readyResolve: (() => void) | null = null;
  private _readyReject: ((err: Error) => void) | null = null;

  /** Server instructions from the MCP initialize response.
   *  These tell the agent HOW to use the tools (priority order,
   *  anti-patterns, etc.) and should be injected into the system prompt. */
  serverInstructions: string | null = null;

  /**
   * Start the MCP server subprocess and complete the initialization
   * handshake.  Resolves when the server is ready to handle
   * `tools/call` requests.
   */
  async start(): Promise<void> {
    // shell:true is required on Windows so spawn can execute .cmd files.
    // The trade-off is that proc.kill() only kills the shell, not the
    // tree — dispose() uses taskkill on Windows to compensate.
    const isWin = process.platform === "win32";
    this.proc = spawn(codegraphCommand(), ["serve", "--mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWin,
    });

    this._ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });

    // ── stdout: line-buffered JSON-RPC responses ────────────────
    const rl = createInterface({ input: this.proc.stdout! });

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // Non-JSON line (e.g. a stray log write) — ignore
        return;
      }

      if (msg.id === undefined || msg.id === null) {
        // Notification or malformed — nothing to resolve
        return;
      }

      const pending = this.pending.get(msg.id);
      if (!pending) return; // response for an unknown id

      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      if (msg.error) {
        pending.reject(
          new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
        );
      } else {
        pending.resolve(msg.result);
      }
    });

    // ── stderr: log for debugging ──────────────────────────────
    this.proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.error("[codegraph]", text);
    });

    // ── exit: reject all pending requests ──────────────────────
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const reason =
        signal != null
          ? `CodeGraph MCP server killed by signal ${signal}`
          : `CodeGraph MCP server exited with code ${code}`;

      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      this.pending.clear();

      // Only reject _ready during startup (before handshake completes).
      // After that, _readyReject is nulled out — process exit during
      // normal shutdown is expected and must not crash pi.
      this._readyReject?.(new Error(reason));
    };
    this.proc.on("exit", onExit);

    const onError = (err: Error) => {
      this._readyReject?.(err);
    };
    this.proc.on("error", onError);

    // ── MCP handshake ──────────────────────────────────────────
    try {
      await this._handshake();
    } catch (e) {
      // Handshake failed — clean up listeners so dispose() is a no-op
      this.proc.removeListener("exit", onExit);
      this.proc.removeListener("error", onError);
      this.proc.kill();
      this.proc = null;
      throw e;
    }

    // Handshake succeeded — _ready is resolved, so null out the reject
    // guard to prevent the exit handler from crashing pi on normal shutdown.
    this._readyReject = null;
  }

  private async _handshake(): Promise<void> {
    // 1. initialize
    const initResult = (await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-codegraph", version: "1.0.0" },
    })) as {
      protocolVersion?: string;
      serverInfo?: unknown;
      instructions?: string;
    };

    if (!initResult || typeof initResult !== "object") {
      throw new Error("Invalid initialize response from CodeGraph MCP server");
    }

    // Capture the server instructions so we can inject them into pi's
    // system prompt — this is the "how to use these tools" playbook.
    this.serverInstructions = initResult.instructions ?? null;

    // 2. initialized notification (no response expected)
    this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   */
  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.proc) {
      throw new Error("MCP client not started");
    }

    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      this.proc!.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  /**
   * List tools available from the MCP server.
   */
  async listTools(): Promise<
    Array<{ name: string; description: string; inputSchema: unknown }>
  > {
    const result = (await this.call("tools/list", {})) as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    return result.tools ?? [];
  }

  /** Write a JSON-RPC message to stdin (fire-and-forget, no response). */
  private _send(msg: JsonRpcMessage): void {
    if (!this.proc) return;
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  /**
   * Kill the subprocess and clean up.  Safe to call multiple times.
   */
  dispose(): void {
    if (this.proc) {
      // Prevent the exit handler from firing during shutdown —
      // remove all listeners before killing so pi doesn't see an
      // unhandled rejection.
      this.proc.removeAllListeners();
      if (this.proc.pid) {
        try {
          if (process.platform === "win32") {
            // With shell:true, proc.kill() only kills cmd.exe — the
            // actual codegraph process survives.  taskkill /t kills
            // the entire tree.
            spawn("taskkill", ["/pid", String(this.proc.pid), "/f", "/t"], {
              stdio: "ignore",
            });
          } else {
            this.proc.kill();
          }
        } catch {
          // Best-effort cleanup
        }
      }
      this.proc = null;
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP client disposed"));
    }
    this.pending.clear();
  }
}
