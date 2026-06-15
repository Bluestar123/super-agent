# Super Agent

一个基于 TypeScript / Node.js 实现的轻量级 AI Agent 框架，目标是模拟 Claude Code / Cursor 类 AI Coding Agent 的核心运行机制。

项目重点不在 UI，而在 Agent 底层能力：多轮 Agent Loop、工具调用、MCP 工具接入、Tool Registry、延迟工具加载、上下文管理、Memory、Session、Token Budget、循环检测与工具并发控制。

## Features

- **Agent Loop**
  - 支持多轮思考与工具调用
  - 支持流式输出
  - 支持最大 step 限制，避免无限执行
  - 支持工具调用重试与错误处理
- **Tool Registry**
  - 统一管理内置工具与 MCP 工具
  - 支持工具 schema 转换为 AI SDK 格式
  - 支持只读工具并发执行、写入工具串行执行
  - 支持工具返回结果截断，避免上下文爆炸
- **Deferred Tool Loading**
  - MCP 工具默认延迟加载
  - 通过 `tool_search` 获取工具完整定义
  - 减少 system prompt 中工具 schema 体积
  - 更适合大量工具场景下的 Context Engineering
- **MCP Integration**
  - 支持接入 GitHub MCP Server
  - 通过 `GITHUB_PERSONAL_ACCESS_TOKEN` 动态注册 GitHub MCP 工具
  - 未配置 token 时可降级为 mock 工具，便于本地调试
- **Context Engineering**
  - 支持 system prompt 分层构建
  - 支持 core rules、tool guide、deferred tools、memory context、session context 组合
  - 支持上下文压缩、token 估算与即时防线
- **Memory & Session**
  - 支持本地 Memory Store
  - 支持会话持久化
  - 支持 `--continue` 恢复历史会话
- **Loop Detection**
  - 检测重复工具调用
  - 对轻微循环进行系统提醒
  - 对严重循环风险主动停止执行

## Tech Stack

- TypeScript
- Node.js
- AI SDK
- MCP
- pnpm
- tsx

## Project Structure

```bash
src
├── agent
│   ├── loop.ts              # Agent 主循环
│   ├── loop-detection.ts    # 工具调用循环检测
│   └── retry.ts             # 重试策略
├── commands                 # CLI 命令系统
├── context
│   ├── prompt-builder.ts    # System Prompt 构建
│   ├── compressor.ts        # 上下文压缩与 token 估算
│   ├── defense.ts           # 即时上下文防线
│   └── view.ts              # Context / Usage 展示
├── memory
│   └── store.ts             # Memory 存储
├── session
│   └── store.ts             # Session 持久化
├── tools
│   ├── registry.ts          # 工具注册中心
│   ├── tool-search.ts       # 延迟工具搜索
│   ├── mcp-client.ts        # MCP Client
│   └── index.ts             # 内置工具集合
├── usage
│   └── tracker.ts           # Token / Cost 统计
└── index.ts                 # CLI 入口
```

## Getting Started

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

创建 `.env` 文件：

```bash
DASHSCOPE_API_KEY=your_dashscope_api_key
GITHUB_PERSONAL_ACCESS_TOKEN=your_github_token
```

说明：

- `DASHSCOPE_API_KEY`：用于调用 Qwen 模型。
- `GITHUB_PERSONAL_ACCESS_TOKEN`：用于连接 GitHub MCP Server。
- 如果不配置 `DASHSCOPE_API_KEY`，项目会使用 mock model。
- 如果不配置 `GITHUB_PERSONAL_ACCESS_TOKEN`，GitHub MCP 会降级为本地 mock 行为。

### 3. Start

```bash
pnpm start
```

或者开发模式：

```bash
pnpm dev
```

继续上一次会话：

```bash
pnpm start -- --continue
```

## How It Works

### 1. Agent Loop

Agent Loop 是项目核心流程：

```text
User Input
   ↓
Build System Prompt
   ↓
Call LLM
   ↓
Stream Text / Tool Call
   ↓
Execute Tool
   ↓
Append Tool Result
   ↓
Continue Loop
   ↓
Final Answer
```

在每一轮中，模型可以选择直接回答，也可以调用工具。如果调用工具，系统会执行工具并把结果追加回 messages，然后继续下一轮，直到没有工具调用或达到最大 step 限制。

核心能力包括：

- step 限制
- token budget
- tool call detection
- tool result recording
- retry
- loop detection

## Tool Registry Design

所有工具都会注册到 `ToolRegistry` 中，统一转换为 AI SDK 可识别的工具格式。

工具定义示例：

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  execute: (input: any) => Promise<unknown>;
  shouldDefer?: boolean;
  searchHint?: string;
}
```

### Concurrency Control

工具分为两类：

- **只读 / 并发安全工具**
  - 可以并发执行
  - 例如搜索、读取文件、查询数据
- **写入 / 非并发安全工具**
  - 使用独占锁串行执行
  - 例如写文件、创建资源、修改状态

这样可以避免多个工具同时修改同一类资源导致状态冲突。

## Deferred Tool Loading

当 MCP 工具数量较多时，如果一次性把所有工具 schema 放入 system prompt，会快速消耗上下文。

因此项目设计了延迟工具机制：

```text
System Prompt 中只暴露工具摘要
   ↓
模型需要某类工具
   ↓
调用 tool_search
   ↓
获取目标工具完整 schema
   ↓
下一轮正式调用工具
```

优势：

- 减少 prompt token 消耗
- 降低模型选择工具的干扰
- 更适合 MCP 工具数量膨胀的场景
- 更贴近真实 AI Coding Agent 的工具调度方式

## MCP Support

项目支持通过 MCP 接入外部工具服务。

当前示例中支持 GitHub MCP Server：

```ts
const client = new MCPClient(
  "npx",
  ["-y", "@modelcontextprotocol/server-github"],
  { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
);
```

注册后的 MCP 工具会统一加上命名空间前缀：

```text
mcp__github__xxx
```

这样可以避免不同 MCP Server 之间的工具名冲突。

## Context Engineering

项目将 system prompt 拆成多个独立模块：

- `coreRules`
- `toolGuide`
- `deferredTools`
- `memoryContext`
- `sessionContext`

通过 `PromptBuilder` 组合：

```ts
const builder = new PromptBuilder()
  .pipe("coreRules", coreRules())
  .pipe("toolGuide", toolGuide())
  .pipe("deferredTools", deferredTools())
  .pipe("memoryContext", () => memoryStore.buildPromptSection())
  .pipe("sessionContext", sessionContext());
```

这样做的好处：

- prompt 结构清晰
- 方便调试每一段上下文
- 方便后续做压缩、裁剪、替换
- 更适合长期会话和复杂工具场景

## Memory & Session

项目支持两类状态：

### Session

Session 记录当前会话 messages，用于恢复历史对话。

```bash
pnpm start -- --continue
```

### Memory

Memory 用于保存长期信息，可以在后续对话中注入到 prompt。

适合保存：

- 用户偏好
- 项目背景
- 常用约束
- 长期任务信息

## Token & Usage Tracking

项目内置 usage tracker，用于记录模型调用消耗：

- input tokens
- output tokens
- cache read tokens
- cache write tokens
- estimated cost

当 token 使用接近预算时，会输出提示；超过预算时主动停止执行。

## Loop Detection

Agent 在执行工具时可能陷入重复调用，例如：

```text
search file
search same file
search same file
...
```

项目内置 loop detection：

- 记录工具名和输入参数
- 检测重复调用
- 轻度风险时向模型注入系统提醒
- 严重风险时主动停止 loop

## Why This Project

这个项目主要用于学习和实践 AI Agent 底层工程能力，包括：

- Agent Loop 如何实现
- LLM 如何调用工具
- MCP 工具如何接入
- 工具数量膨胀后如何做延迟加载
- 长上下文如何管理
- Memory 和 Session 如何设计
- 如何避免 Agent 无限循环
- 如何控制工具并发和写入风险

它不是简单调用大模型 API，而是尝试实现一个可扩展的 Agent Runtime。

## Roadmap

- [ ] 支持真实文件系统读写工具
- [ ] 支持 Git diff / patch apply
- [ ] 支持代码仓库索引与搜索
- [ ] 支持任务计划与 Todo 管理
- [ ] 支持多 MCP Server 配置
- [ ] 支持工具调用审批机制
- [ ] 支持更完整的上下文压缩策略
- [ ] 支持 Web UI 调试面板
- [ ] 支持自动生成执行报告

## Use Cases

- AI Coding Agent 原理学习
- Claude Code / Cursor 底层机制模拟
- MCP 工具调度实验
- Context Engineering 实践
- 多工具 Agent Runtime 设计
- 前端 Agent 工程师作品展示

## License

ISC
