/**
 * CodeGraph extension for pi coding agent.
 *
 * Bridges pi's tool system to the CodeGraph MCP server (stdio JSON-RPC 2.0)
 * and injects CodeGraph's server instructions into pi's system prompt — the
 * "how to use this tool" playbook that pi's built-in MCP client cannot inject
 * in full.
 *
 * Tools are registered from the server's own `tools/list` response instead of
 * being hard-coded, so the extension always matches the installed CodeGraph
 * version:
 *
 *   - CodeGraph 1.0.x  → codegraph_search / callers / node / explore
 *   - CodeGraph 1.1.5+ → codegraph_explore alone (others via CODEGRAPH_MCP_TOOLS)
 *   - No `.codegraph/` index (1.0.x) → no tools at all; nothing is injected
 *   - No `.codegraph/` index (1.6+)  → tools + the per-project playbook
 *
 * Installation:
 *   Copy this file + mcp-client.ts into ~/.pi/agent/extensions/codegraph/
 *
 * Upgrade safety:
 *   `codegraph upgrade` replaces the global binary; the next pi restart
 *   spawns the new version and picks up whatever tools it lists.  No
 *   extension changes needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { McpClient, normalizeProjectPath, type McpTool } from "./mcp-client";

// ── Index detection ────────────────────────────────────────────────

/**
 * CodeGraph answers a project's queries from the nearest `.codegraph/` at or
 * above the session directory. Mirror that lookup so pi can say up front when
 * the current project has no index — otherwise a forgotten `codegraph init`
 * just silently falls back to plain file reads.
 */
function findIndexRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".codegraph", "codegraph.db"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── MCP tool call helper ───────────────────────────────────────────

type ToolContent = Array<{ type: "text"; text: string }>;

async function callMcpTool(
  client: McpClient | null,
  toolName: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: ToolContent; details: Record<string, unknown> }> {
  if (!client) {
    return {
      content: [{ type: "text", text: "CodeGraph: not connected." }],
      details: {},
    };
  }

  try {
    const result = (await client.call(
      "tools/call",
      { name: toolName, arguments: params },
      signal,
    )) as { content: ToolContent; isError?: boolean };

    return { content: result.content, details: {} };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text", text: `CodeGraph error: ${message}` }],
      details: {},
    };
  }
}

/** "codegraph_explore" → "CodeGraph Explore" */
function toolLabel(name: string): string {
  const words = name
    .replace(/^codegraph[_\s-]*/i, "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  const titled = words.join(" ") || name;
  return /^codegraph/i.test(name) ? `CodeGraph ${titled}` : titled;
}

// ── Entry point ────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  let client: McpClient | null = null;

  // ── Startup: connect, then register whatever tools the server lists ──

  pi.on("session_start", async (_event, ctx) => {
    // Nudge when this project has no index yet: the tools still load, but they
    // can only tell the model "no project is loaded" — a one-line hint here
    // saves a round-trip and reminds you to run `codegraph init`.
    if (!findIndexRoot(ctx.cwd)) {
      ctx.ui.setStatus("codegraph", "CodeGraph: 本项目未建索引 (codegraph init)");
    }

    try {
      client = new McpClient();
      await client.start(ctx.cwd);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.ui.notify(`CodeGraph: ${message}`, "warning");
      client?.dispose();
      client = null;
      return;
    }

    let tools: McpTool[];
    try {
      tools = await client.listTools();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.ui.notify(`CodeGraph: ${message}`, "warning");
      client.dispose();
      client = null;
      return;
    }

    // CodeGraph 1.0.x lists no tools when the workspace has no `.codegraph/`
    // index.  In that case keep the workspace quiet: no tools, no instructions.
    // CodeGraph 1.6+ always lists tools and describes `projectPath` instead.
    if (tools.length === 0) {
      client.dispose();
      client = null;
      return;
    }

    for (const tool of tools) {
      pi.registerTool({
        name: tool.name,
        label: toolLabel(tool.name),
        description: tool.description,
        // Pass the server's JSON Schema straight through, so future CodeGraph
        // versions can add or change parameters without touching this file.
        parameters: Type.Unsafe(
          (tool.inputSchema as object | undefined) ?? {
            type: "object",
            properties: {},
          },
        ),
        annotations: tool.annotations,
        async execute(_toolCallId, params, signal) {
          const args = { ...(params as Record<string, unknown>) };
          if (typeof args.projectPath === "string") {
            args.projectPath = normalizeProjectPath(args.projectPath);
          }
          return callMcpTool(client, tool.name, args, signal);
        },
      });
    }
  });

  // ── Inject server instructions as a system-prompt section ──────────
  // The MCP initialize response carries a detailed playbook for HOW to use
  // these tools (priority order, anti-patterns, etc.).  Without it the agent
  // gets the tools but not the strategy, and defaults to Read/Grep first —
  // defeating the purpose.  pi's built-in MCP client only surfaces the first
  // line, so we inject the full text here.
  //
  // Written through `systemPromptOptions.sections` rather than by returning a
  // whole `systemPrompt`: pi then records it as a named section and appends a
  // transcript delta instead of replacing the prompt each run, which keeps the
  // provider's prompt cache intact.
  pi.on("before_agent_start", async (event) => {
    const instructions = client?.serverInstructions;
    if (!instructions) return;

    event.systemPromptOptions.sections.codegraph = instructions;
  });

  // ── Shutdown ───────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    client?.dispose();
    client = null;
  });
}
