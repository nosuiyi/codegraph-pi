# codegraph-pi

[English](#english) · [中文](#中文)

---

## English

CodeGraph integration for the [pi coding agent](https://pi.dev).

CodeGraph indexes your project into a local knowledge graph; this extension hands that graph to pi. Ask *"how does this work"* or *"what breaks if I change this"*, and pi reads the answer out of the index instead of opening files one by one.

### What it gives you

- **One call returns the code.** `codegraph_explore` returns the source of the symbols you named — grouped by file, with the call paths between them and what depends on them attached.
- **It follows your CodeGraph version.** The extension asks CodeGraph which tools it has and registers exactly those. Upgrade CodeGraph and it keeps working; there is nothing to update by hand.
- **The agent knows how to use it.** CodeGraph ships a playbook for using it well — which tool for which question, what not to do. The extension puts the whole playbook into pi's system prompt.
- **You are told when there is nothing to read.** If a project has no index yet, pi's status bar says so, instead of quietly falling back to file reads.

### Before you start

Install the CodeGraph CLI once, then index each project you want to query:

```bash
npm install -g @colbymchenry/codegraph

cd your-project
codegraph init
```

### Install

```bash
pi install github:nosuiyi/codegraph-pi
```

Or copy `index.ts` and `mcp-client.ts` into `~/.pi/agent/extensions/codegraph/`.

### Usage

Start pi inside an indexed project and ask structural questions:

```text
Use codegraph_explore. How does authentication reach the request handler?
What calls PlanBoostSession?
What would break if I change UserRepository?
```

When a project has an index, pi loads the CodeGraph tools. When it does not, pi works with its built-in tools and the status bar reminds you to run `codegraph init` — a newly created index is picked up live, no restart needed.

### Technical notes

- Starts `codegraph serve --mcp` once per session and proxies each tool call over stdio JSON-RPC; tool schemas come from the server's `tools/list`.
- Injects CodeGraph's instructions as a named prompt section, so pi appends a delta instead of replacing the prompt and the provider cache stays warm.
- Pressing Esc cancels the running query.
- On Windows, finds the `codegraph` command with `where.exe` (npm, Scoop, and pnpm installs all work); `/c/...` (Git Bash) and `/mnt/c/...` (WSL) paths are normalized.

### Uninstall

```bash
pi remove github:nosuiyi/codegraph-pi
```

### License

MIT

---

## 中文

[pi coding agent](https://pi.dev) 上的 CodeGraph 集成。

CodeGraph 把项目索引成一张本地知识图谱，这个扩展把这张图交给 pi。当你问「这段怎么工作的」「改这里会影响什么」时，pi 从索引里直接读答案，而不是一个文件一个文件地翻。

### 它给你什么

- **一次调用就拿到代码。** `codegraph_explore` 返回你点名的那些符号的源码 —— 按文件分组，附带它们之间的调用链，以及依赖它们的东西。
- **跟着你的 CodeGraph 版本走。** 扩展先问 CodeGraph 有哪些工具，再照着注册。升级 CodeGraph 不用改任何东西，照样能用。
- **模型知道该怎么用它。** CodeGraph 自带一份使用说明 —— 什么问题该用哪个工具、哪些事别做。扩展把这份说明整份放进 pi 的系统提示。
- **没东西可读时会告诉你。** 项目还没建索引时，pi 状态栏会提醒你，而不是悄悄退回普通文件读取。

### 开始之前

先装一次 CodeGraph CLI，再给每个要查询的项目建索引：

```bash
npm install -g @colbymchenry/codegraph

cd your-project
codegraph init
```

### 安装

```bash
pi install github:nosuiyi/codegraph-pi
```

或把 `index.ts` 和 `mcp-client.ts` 复制到 `~/.pi/agent/extensions/codegraph/`。

### 使用

在已建索引的项目里启动 pi，然后问结构性问题：

```text
用 codegraph_explore 说明认证是怎么走到请求处理函数的
谁调用了 PlanBoostSession？
改 UserRepository 会影响什么？
```

项目有索引时，pi 会加载 CodeGraph 工具；没有时，pi 正常使用内置工具，状态栏提醒你跑 `codegraph init` —— 新建的索引会被运行时拾取，不用重启 pi。

### 技术细节

- 每个会话启动一次 `codegraph serve --mcp`，每次工具调用通过 stdio JSON-RPC 代理；工具 schema 来自服务端的 `tools/list`。
- CodeGraph 的使用说明以命名 section 注入，pi 只追加增量、不整段替换提示，provider 缓存不会失效。
- 按 Esc 会取消正在进行的查询。
- Windows 上用 `where.exe` 找 `codegraph` 命令（npm / Scoop / pnpm 都行）；`/c/...`（Git Bash）和 `/mnt/c/...`（WSL）路径会自动转换。

### 卸载

```bash
pi remove github:nosuiyi/codegraph-pi
```

### 许可

MIT
