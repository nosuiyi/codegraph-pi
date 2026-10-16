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

import { execFileSync, spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { pathToFileURL } from "url";

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

/** A tool as reported by the server's `tools/list`. */
export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments, passed through to pi. */
  inputSchema?: unknown;
  /** MCP tool annotations (readOnlyHint and friends). */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

// ── Constants ──────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 60_000;

/** How many trailing stderr lines to keep for failure diagnostics. */
const STDERR_TAIL_LINES = 20;

// ── Helpers ────────────────────────────────────────────────────────

/** How to launch `codegraph serve --mcp`. */
interface Launch {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Resolve how to launch the CodeGraph CLI.
 *
 * POSIX spawns it directly. On Windows, npm / Scoop / pnpm install `codegraph`
 * as a `.cmd` (or `.ps1`) shim that Node cannot execute without a shell, so ask
 * `where.exe` for the real candidates: prefer a native `.exe`, otherwise run
 * the `.cmd` through the shell. Falls back to the plain name when `where.exe`
 * finds nothing, so a PATH it cannot read still has a chance.
 */
function resolveLaunch(cwd: string): Launch {
  const args = ["serve", "--mcp", "--path", cwd];

  if (process.platform !== "win32") {
    return { command: "codegraph", args, shell: false };
  }

  let candidates: string[] = [];
  try {
    candidates = execFileSync("where.exe", ["codegraph"], {
      encoding: "utf8",
      windowsHide: true,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // `where.exe` found nothing — fall through to the default.
  }

  const exe = candidates.find((p) => /\.exe$/i.test(p));
  if (exe) return { command: exe, args, shell: false };

  const cmd = candidates.find((p) => /\.(cmd|bat)$/i.test(p));
  if (cmd) return { command: cmd, args, shell: true };

  return { command: "codegraph.cmd", args, shell: true };
}

/**
 * Accept the path spellings Windows users actually type. Git Bash reports
 * `/c/Users/...` and WSL mounts drives at `/mnt/c/...`; CodeGraph wants a
 * native path. Input on other platforms is returned unchanged.
 */
export function normalizeProjectPath(input: string): string {
  const trimmed = input.trim();
  if (process.platform !== "win32") return trimmed;

  const wsl = trimmed.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (wsl) return `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, "\\")}`;

  const gitBash = trimmed.match(/^\/([a-zA-Z])\/(.*)$/);
  if (gitBash) return `${gitBash[1].toUpperCase()}:\\${gitBash[2].replace(/\//g, "\\")}`;

  return trimmed;
}

// ── Client ─────────────────────────────────────────────────────────

export class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private _ready: Promise<void> | null = null;
  private _readyResolve: (() => void) | null = null;
  private _readyReject: ((err: Error) => void) | null = null;
  private _cwd: string = process.cwd();
  /**
   * Recent stderr lines from the server, kept in memory for diagnostics.
   *
   * Never written to the terminal while the server is healthy: pi's TUI owns
   * every screen cell, so a raw `console.error` here gets painted over the
   * input box and only disappears on the next repaint — it reads as a glitch.
   * CodeGraph's startup chatter ("no default project", worker-pool notices)
   * is informational, so it stays buffered and is only surfaced when the
   * handshake or a request actually fails. Set CODEGRAPH_DEBUG=1 to echo it.
   */
  private stderrTail: string[] = [];

  /** Server instructions from the MCP initialize response.
   *  These tell the agent HOW to use the tools (priority order,
   *  anti-patterns, etc.) and should be injected into the system prompt. */
  serverInstructions: string | null = null;

  /**
   * Start the MCP server subprocess and complete the initialization
   * handshake.  Resolves when the server is ready to handle
   * `tools/call` requests.
   */
  async start(cwd?: string): Promise<void> {
    this._cwd = cwd ?? process.cwd();

    // Resolve the CLI (shell shim on Windows) and launch it inside the session
    // directory: CodeGraph 1.0.x finds the project from the process cwd, and
    // only 1.6+ reads rootUri/workspaceFolders.
    const launch = resolveLaunch(this._cwd);
    this.proc = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: launch.shell,
      cwd: this._cwd,
      windowsHide: true,
      env: {
        ...process.env,
        // Name pi as the real host past the Windows shell (or any launcher),
        // so CodeGraph's ppid watchdog shuts this server down with pi.
        CODEGRAPH_HOST_PPID: String(process.pid),
      },
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

    // ── stderr: buffer for diagnostics, never paint the TUI ────
    this.proc.stderr?.on("data", (data: Buffer) => {
      this._noteStderr(data.toString());
    });

    // ── exit: reject all pending requests ──────────────────────
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const reason = this._withStderrTail(
        signal != null
          ? `CodeGraph MCP server killed by signal ${signal}`
          : `CodeGraph MCP server exited with code ${code}`,
      );

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
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(this._withStderrTail(message));
    }

    // Handshake succeeded — _ready is resolved, so null out the reject
    // guard to prevent the exit handler from crashing pi on normal shutdown.
    this._readyReject = null;
  }

  /** Append buffered stderr lines to a failure message, if there are any. */
  private _withStderrTail(message: string): string {
    if (this.stderrTail.length === 0) return message;
    return `${message}\n── CodeGraph stderr (last ${this.stderrTail.length} line(s)) ──\n${this.stderrTail.join("\n")}`;
  }

  /** Buffer a chunk of server stderr; echo it only under CODEGRAPH_DEBUG. */
  private _noteStderr(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) this.stderrTail.push(trimmed);
    }
    if (this.stderrTail.length > STDERR_TAIL_LINES) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LINES);
    }
    if (process.env.CODEGRAPH_DEBUG) {
      const trimmed = text.trim();
      if (trimmed) console.error("[codegraph]", trimmed);
    }
  }

  private async _handshake(): Promise<void> {
    // 1. initialize
    const rootUri = pathToFileURL(this._cwd).href;

    const initResult = (await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-codegraph", version: "2.0.0" },
      // CodeGraph 1.0.x indexes the process cwd; 1.6+ reads the project from
      // rootUri / workspaceFolders.  Send both so either version works.
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
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
   *
   * Pass the tool call's `AbortSignal` to cancel in flight: pi aborts it when
   * the user interrupts, and CodeGraph is told so it can drop the work.
   */
  call(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.proc) {
      throw new Error("MCP client not started");
    }

    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;

      const settle = (fn: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };

      const onAbort = () => {
        // Best-effort cancel so the server can drop in-flight work.
        this._send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "client aborted" },
        });
        settle(() => reject(new Error(`MCP request aborted: ${method}`)));
      };

      timer = setTimeout(
        () =>
          settle(() =>
            reject(new Error(`MCP request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method}`)),
          ),
        REQUEST_TIMEOUT_MS,
      );

      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (reason) => settle(() => reject(reason)),
        timer,
      });

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

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
  async listTools(): Promise<McpTool[]> {
    const all: McpTool[] = [];
    let cursor: string | undefined;

    do {
      const result = (await this.call(
        "tools/list",
        cursor ? { cursor } : {},
      )) as { tools?: McpTool[]; nextCursor?: string };

      all.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return all;
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
