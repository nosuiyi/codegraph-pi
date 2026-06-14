# codegraph-pi

CodeGraph integration for the [pi coding agent](https://pi.dev).

Gives pi four tools powered by a pre-indexed code knowledge graph:

- **`codegraph_explore`** — Primary tool. Answer "how does X work" or trace a flow in one call. Returns verbatim source grouped by file, plus the call path (including dynamic dispatch: callbacks, React re-render, JSX children).
- **`codegraph_node`** — Read a file (like the built-in Read tool but from the index, with blast radius) or inspect one symbol's full source + caller/callee trail.
- **`codegraph_search`** — Find symbols by name across the codebase.
- **`codegraph_callers`** — Every call site, including where a function is registered as a callback.

## Prerequisites

[CodeGraph](https://github.com/colbymchenry/codegraph) must be installed and the project must be indexed:

```bash
# Install CodeGraph (one-time)
npm install -g @colbymchenry/codegraph

# Index your project
cd your-project
codegraph init
```

## Install

```bash
pi install github:colbymchenry/codegraph-pi
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["github:colbymchenry/codegraph-pi"]
}
```

## Usage

Start pi in a project that has been indexed (`codegraph init`):

```bash
cd your-project
pi
```

When a `.codegraph/` directory is present, pi automatically loads the four CodeGraph tools. If the project isn't indexed, no CodeGraph tools are registered — pi works normally with its built-in tools.

Upgrade CodeGraph with `codegraph upgrade` — the extension picks up the new version on the next pi restart with zero changes needed.

## How it works

The extension spawns `codegraph serve --mcp` as a long-lived subprocess and bridges pi's tool system to CodeGraph's MCP server over stdio JSON-RPC 2.0. Each pi tool call is proxied to the MCP server, which queries the local SQLite knowledge graph.

## Uninstall

```bash
pi remove github:colbymchenry/codegraph-pi
```
