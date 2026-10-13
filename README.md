# codegraph-pi

[English](#english) · [中文](#中文)

---

## English

CodeGraph integration for the [pi coding agent](https://pi.dev).

Bridges pi's tool system to a pre-indexed [CodeGraph](https://github.com/colbymchenry/codegraph) knowledge graph, so pi answers structural questions — *how does X work, what calls Y, what breaks if I change Z* — in one call instead of a grep/read loop.

### Features

- **Dynamic tools** — tools are registered from the CodeGraph server's own `tools/list` response, never hard-coded. CodeGraph 1.6+ lists `codegraph_explore`; earlier versions list `search` / `callers` / `node` / `explore`; set `CODEGRAPH_MCP_TOOLS` to expose more. `codegraph upgrade` never breaks the extension.
- **Full server playbook** — injects CodeGraph's complete server instructions into pi's system prompt (as a named section), so the agent follows CodeGraph's own strategy: query syntax, anti-patterns, and staleness handling. pi's built-in MCP client only surfaces the first line.
- **Missing-index hint** — if the current project has no `.codegraph/` index, pi's status bar shows a reminder, instead of silently falling back to plain file reads.
- **Cache-friendly** — instructions are injected via `systemPromptOptions.sections`, so pi appends a transcript delta rather than replacing the whole prompt each run.
- **Cancellation aware** — pressing Esc forwards `notifications/cancelled` to CodeGraph so in-flight work is dropped.
- **Windows / Git Bash / WSL friendly** — resolves the `codegraph` shim through `where.exe` (npm, Scoop, pnpm) and normalizes `/c/...` and `/mnt/c/...` paths.

### Prerequisites

The CodeGraph CLI must be installed, and each project must be indexed:

```bash
# One-time install
npm install -g @colbymchenry/codegraph

# Index a project
cd your-project
codegraph init
```

### Install

As a pi package:

```bash
pi install github:nosuiyi/codegraph-pi
```

Or copy `index.ts` + `mcp-client.ts` into `~/.pi/agent/extensions/codegraph/`.

### Usage

Start pi inside an indexed project and ask structural questions:

```text
Use codegraph_explore. How does authentication reach the request handler?
What calls PlanBoostSession?
What would break if I change UserRepository?
```

When a `.codegraph/` index is present, pi loads the CodeGraph tools. When it is not, pi works normally with its built-in tools and the status bar reminds you to run `codegraph init` — a new index is picked up live, no restart needed.

### How it works

The extension spawns `codegraph serve --mcp` as a long-lived subprocess and bridges pi's tool system to CodeGraph's MCP server over stdio JSON-RPC 2.0. Each pi tool call is proxied to the MCP server, which queries the local SQLite knowledge graph. Tool schemas come from `tools/list`; the `initialize` response's `instructions` become a system-prompt section.

### Uninstall

```bash
pi remove github:nosuiyi/codegraph-pi
```

---

## 中文

在 [pi coding agent](https://pi.dev) 上使用 [CodeGraph](https://github.com/colbymchenry/codegraph)。

把 pi 的工具系统接上一张预建好的代码知识图谱，于是结构性问题——*这段代码怎么工作的、谁调用了 Y、改 Z 会影响什么*——一次调用就能回答，而不用 grep/read 一个个文件爬。

> 注意：这只是个扩展，使用前依然要安装原版 CodeGraph CLI 并给项目建索引。

### 特性

- **动态工具**：工具从 CodeGraph 服务端自己的 `tools/list` 响应里注册，绝不硬编码。CodeGraph 1.6+ 只列 `codegraph_explore`；更早的版本列 `search` / `callers` / `node` / `explore`；设 `CODEGRAPH_MCP_TOOLS` 可暴露更多。`codegraph upgrade` 升级后扩展不会失效。
- **完整 playbook 注入**：把 CodeGraph 官方的完整 server instructions 作为命名 section 注入 pi 的系统提示，让模型遵循 CodeGraph 自己的策略（查询语法、反模式、索引过期处理）。pi 内置的 MCP 客户端只会取第一行。
- **未建索引提示**：当前项目没有 `.codegraph/` 索引时，pi 状态栏会提醒一句，而不是静默退化成普通文件读取。
- **对缓存友好**：通过 `systemPromptOptions.sections` 注入，pi 只追加 transcript delta，不做整段替换，保护 provider 的 prompt 缓存。
- **支持取消**：按 Esc 会向 CodeGraph 发送 `notifications/cancelled`，中断正在进行的查询。
- **兼容 Windows / Git Bash / WSL**：用 `where.exe` 解析 `codegraph` 命令（支持 npm / Scoop / pnpm 安装），并将 `/c/...`、`/mnt/c/...` 路径规范化。

### 前置要求

需要安装 CodeGraph CLI，并且每个项目要先建索引：

```bash
# 一次性安装
npm install -g @colbymchenry/codegraph

# 给项目建索引
cd your-project
codegraph init
```

### 安装

作为 pi package 安装：

```bash
pi install github:nosuiyi/codegraph-pi
```

或手动把 `index.ts` + `mcp-client.ts` 复制到 `~/.pi/agent/extensions/codegraph/`。

### 使用

在已建索引的项目里启动 pi，然后问结构性问题：

```text
用 codegraph_explore 说明认证是怎么走到请求处理函数的
谁调用了 PlanBoostSession？
改 UserRepository 会影响什么？
```

项目有 `.codegraph/` 索引时，pi 会加载 CodeGraph 工具；没有时，pi 正常使用内置工具，同时状态栏提醒你跑 `codegraph init`——新建的索引会被运行时拾取，**无需重启 pi**。

### 工作原理

扩展以长驻子进程方式启动 `codegraph serve --mcp`，在 stdio 上以 JSON-RPC 2.0 把 pi 的工具系统桥接到 CodeGraph 的 MCP server。每次 pi 工具调用都会代理到该 MCP server，由它查询本地 SQLite 知识图谱。工具 schema 来自 `tools/list`；`initialize` 响应里的 `instructions` 会变成系统提示的一个 section。

### 卸载

```bash
pi remove github:nosuiyi/codegraph-pi
```

### 许可

MIT
