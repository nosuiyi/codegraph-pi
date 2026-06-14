/**
 * CodeGraph extension for pi coding agent.
 *
 * Bridges pi's tool system to the CodeGraph MCP server (stdio JSON-RPC 2.0).
 * When a `.codegraph/` index is present in the project root, registers four
 * tools — `codegraph_explore`, `codegraph_node`, `codegraph_search`,
 * `codegraph_callers` — that proxy to `codegraph serve --mcp`.
 *
 * Installation:
 *   Copy this file + mcp-client.ts into ~/.pi/agent/extensions/codegraph/
 *
 * Upgrade safety:
 *   `codegraph upgrade` replaces the global binary; the next pi restart
 *   spawns the new version.  No extension changes needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "fs";
import { join } from "path";
import { McpClient } from "./mcp-client";

// ── Shared parameter descriptions ──────────────────────────────────

const PROJECT_PATH_DESC =
  "Path to a different project with .codegraph/ initialized. " +
  "If omitted, uses the current project directory.";

// ── Tool call helper ───────────────────────────────────────────────

type ToolContent = Array<{ type: "text"; text: string }>;

async function callMcpTool(
  client: McpClient | null,
  toolName: string,
  params: Record<string, unknown>,
): Promise<{ content: ToolContent; details: Record<string, unknown> }> {
  if (!client) {
    return {
      content: [{ type: "text", text: "CodeGraph: not connected." }],
      details: {},
    };
  }

  try {
    const result = (await client.call("tools/call", {
      name: toolName,
      arguments: params,
    })) as { content: ToolContent; isError?: boolean };

    return { content: result.content, details: {} };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text", text: `CodeGraph error: ${message}` }],
      details: {},
    };
  }
}

// ── Entry point ────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  let client: McpClient | null = null;

  // ── Startup ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const dbPath = join(process.cwd(), ".codegraph", "codegraph.db");

    if (!existsSync(dbPath)) {
      // No index → no tools.  Matches CodeGraph's own inactive-state
      // design: an empty tool list is the clearest signal to the agent.
      return;
    }

    try {
      client = new McpClient();
      await client.start();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.ui.notify(`CodeGraph: ${message}`, "warning");
      client?.dispose();
      client = null;
      return;
    }

    // ── Register tools ─────────────────────────────────────────

    pi.registerTool({
      name: "codegraph_explore",
      label: "CodeGraph Explore",
      description: [
        "PRIMARY TOOL — call FIRST for almost any question OR before an edit:",
        "how does X work, architecture, a bug, where/what is X, surveying an area,",
        "or the symbols you are about to change.  Returns the verbatim source of",
        "the relevant symbols grouped by file in ONE capped call (Read-equivalent —",
        "treat the shown source as already Read; do NOT re-open those files), plus",
        "the call path among them.  Query can be a natural-language question OR a",
        "bag of symbol/file names.  Usually the ONLY call you need.",
      ].join(" "),
      parameters: Type.Object({
        query: Type.String({
          description: [
            'Symbol names, file names, or short code terms to explore',
            '(e.g., "AuthService loginUser session-manager",',
            '"GraphTraverser BFS impact traversal.ts").  For a flow',
            "question, name the symbols spanning the flow",
            '(e.g. "mutateElement renderScene").  A natural-language',
            "question works too.",
          ].join(" "),
        }),
        maxFiles: Type.Optional(
          Type.Number({
            description:
              "Maximum number of files to include source code from (default: 12).",
          }),
        ),
        projectPath: Type.Optional(
          Type.String({ description: PROJECT_PATH_DESC }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        return callMcpTool(client!, "codegraph_explore", params as Record<string, unknown>);
      },
    });

    pi.registerTool({
      name: "codegraph_node",
      label: "CodeGraph Node",
      description: [
        "Two modes.  (1) READ A FILE — use INSTEAD of the Read tool: pass",
        '"file" (a path or basename) with no "symbol" and it returns that',
        "file's current on-disk source with line numbers, exactly the shape",
        'Read gives you, narrowable with "offset"/"limit" just like Read —',
        "PLUS a one-line note of which files depend on it.  Same bytes as",
        "Read, faster (served from the index), with the blast radius",
        "attached.  Use it whenever you would Read a source file.",
        "(2) ONE SYMBOL you can name — its location, signature, verbatim",
        "source (includeCode=true) and caller/callee trail in one call, so",
        "before changing it you see what calls it and what your edit would",
        "break.  For an AMBIGUOUS name it returns EVERY matching definition's",
        "body in one call.  Use codegraph_explore for several related",
        "symbols or the full flow.",
      ].join(" "),
      parameters: Type.Object({
        symbol: Type.Optional(
          Type.String({
            description:
              'Name of the symbol to read (symbol mode).  Omit it and pass "file" alone to read a whole file like Read.',
          }),
        ),
        includeCode: Type.Optional(
          Type.Boolean({
            description:
              "Symbol mode: include the symbol's full body (default: false).",
          }),
        ),
        file: Type.Optional(
          Type.String({
            description:
              "A file path or basename.  Pass it ALONE (no symbol) to READ the file like the Read tool, or WITH a symbol to disambiguate an overloaded name.",
          }),
        ),
        offset: Type.Optional(
          Type.Number({
            description:
              "File mode: 1-based line to start reading from, exactly like Read's offset.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description:
              "File mode: maximum number of lines to return, exactly like Read's limit.",
          }),
        ),
        symbolsOnly: Type.Optional(
          Type.Boolean({
            description:
              "File mode: return just the file's symbol map + dependents instead of its source.",
          }),
        ),
        line: Type.Optional(
          Type.Number({
            description:
              "Symbol mode: disambiguate to the definition at/around this line.",
          }),
        ),
        projectPath: Type.Optional(
          Type.String({ description: PROJECT_PATH_DESC }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        return callMcpTool(client!, "codegraph_node", params as Record<string, unknown>);
      },
    });

    pi.registerTool({
      name: "codegraph_search",
      label: "CodeGraph Search",
      description:
        "Quick symbol search by name.  Returns locations only (no code).  Use codegraph_explore instead to get the actual source / understand an area in one call.",
      parameters: Type.Object({
        query: Type.String({
          description:
            'Symbol name or partial name (e.g., "auth", "signIn", "UserService").',
        }),
        kind: Type.Optional(
          Type.String({
            description:
              "Filter by node kind: function, method, class, interface, type, variable, route, component.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Maximum results (default: 10).",
          }),
        ),
        projectPath: Type.Optional(
          Type.String({ description: PROJECT_PATH_DESC }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        return callMcpTool(client!, "codegraph_search", params as Record<string, unknown>);
      },
    });

    pi.registerTool({
      name: "codegraph_callers",
      label: "CodeGraph Callers",
      description:
        "List every call site of a function — including where it is registered as a callback.  For the full flow, use codegraph_explore.",
      parameters: Type.Object({
        symbol: Type.String({
          description:
            "Name of the function, method, or class to find callers for.",
        }),
        file: Type.Optional(
          Type.String({
            description:
              "Narrow to the definition in this file (path or suffix) when several same-named symbols exist.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Maximum number of callers to return (default: 20).",
          }),
        ),
        projectPath: Type.Optional(
          Type.String({ description: PROJECT_PATH_DESC }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        return callMcpTool(client!, "codegraph_callers", params as Record<string, unknown>);
      },
    });
  });

  // ── Inject server instructions into system prompt ───────────
  // The MCP initialize response includes a detailed playbook for HOW
  // to use these tools (priority order, anti-patterns, etc.).  Without
  // this, the agent gets the tools but not the strategy — and defaults
  // to Read/Grep first, defeating the purpose.
  pi.on("before_agent_start", async (event) => {
    const instructions = client?.serverInstructions;
    if (!instructions) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + instructions,
    };
  });

  // ── Shutdown ─────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    client?.dispose();
    client = null;
  });
}
