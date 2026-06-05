import "dotenv/config";
import { type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMockModel } from "./mock-model";
import { createInterface } from "node:readline";
import { agentLoop, type BudgetState } from "./agent/loop";
import { ToolDefinition, ToolRegistry } from "./tools/registry";
import { allTools } from "./tools";
import { createToolSearchTool } from "./tools/tool-search";
import { createMemoryTool } from "./tools/memory-tools.js";
import { MCPClient } from "./tools/mcp-client";
import { SessionStore } from "./session/store";
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  sessionContext,
  toolGuide,
  type PromptContext,
} from "./context/prompt-builder";
import { estimateTokens, microcompact, summarize } from "./context/compressor";
import { applyDefense, estimateMessageTokens } from "./context/defense";
import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from "./context/view";
import { UsageTracker } from "./usage/tracker";
import { MemoryStore } from "./memory/store";
import { createDispatcher, type CommandContext } from "./commands/index";
import { debugCommands } from "./commands/debug";
import { contextCommands } from "./commands/context";
import { memoryCommands } from "./commands/memory";

// ── Registry ────────────────────────────────
const registry = new ToolRegistry();
registry.register(...allTools);
registry.register(createToolSearchTool(registry));

// ── Memory ────────────────────────────────
const memoryStore = new MemoryStore(".");
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

// 模拟额外的 MCP 工具（演示工具膨胀问题）
function registerSimulatedTools() {
  const simulatedTools: ToolDefinition[] = [
    // Notion MCP 模拟
    {
      name: "mcp__notion__search_pages",
      description: "[MCP:notion] 搜索 Notion 页面",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      shouldDefer: true,
      searchHint: "notion search pages documents",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ query }: any) =>
        JSON.stringify([{ title: `Mock: ${query}`, id: "page-001" }]),
    },
    {
      name: "mcp__notion__create_page",
      description: "[MCP:notion] 创建 Notion 页面",
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, content: { type: "string" } },
        required: ["title"],
      },
      shouldDefer: true,
      searchHint: "notion create page document write",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ title }: any) => `已创建页面: ${title}`,
    },
    {
      name: "mcp__notion__list_databases",
      description: "[MCP:notion] 列出 Notion 数据库",
      parameters: { type: "object", properties: {}, required: [] },
      shouldDefer: true,
      searchHint: "notion list databases tables",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async () =>
        JSON.stringify([
          { title: "项目追踪", id: "db-001" },
          { title: "知识库", id: "db-002" },
        ]),
    },

    // Playwright MCP 模拟
    {
      name: "mcp__browser__navigate",
      description: "[MCP:browser] 导航到指定 URL",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      shouldDefer: true,
      searchHint: "browser navigate open url webpage",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ url }: any) => `已导航到 ${url}`,
    },
    {
      name: "mcp__browser__screenshot",
      description: "[MCP:browser] 对当前页面截图",
      parameters: { type: "object", properties: {} },
      shouldDefer: true,
      searchHint: "browser screenshot capture page",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async () => "[screenshot data]",
    },
    {
      name: "mcp__browser__click",
      description: "[MCP:browser] 点击页面元素",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
      shouldDefer: true,
      searchHint: "browser click element button",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ selector }: any) => `已点击 ${selector}`,
    },
    {
      name: "mcp__browser__fill",
      description: "[MCP:browser] 在输入框中填写内容",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" }, value: { type: "string" } },
        required: ["selector", "value"],
      },
      shouldDefer: true,
      searchHint: "browser fill input form text",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ selector, value }: any) =>
        `已在 ${selector} 填写 ${value}`,
    },
    {
      name: "mcp__browser__get_text",
      description: "[MCP:browser] 获取页面文本内容",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
      shouldDefer: true,
      searchHint: "browser get text content extract",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ selector }: any) => `Mock text content of ${selector}`,
    },

    // Supabase MCP 模拟
    {
      name: "mcp__supabase__query",
      description: "[MCP:supabase] 执行 SQL 查询",
      parameters: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
      shouldDefer: true,
      searchHint: "database sql query select",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ sql }: any) =>
        JSON.stringify([{ id: 1, name: "mock_row", sql }]),
    },
    {
      name: "mcp__supabase__list_tables",
      description: "[MCP:supabase] 列出数据库所有表",
      parameters: { type: "object", properties: {} },
      shouldDefer: true,
      searchHint: "database list tables schema",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async () => JSON.stringify(["users", "orders", "products"]),
    },
    {
      name: "mcp__supabase__describe_table",
      description: "[MCP:supabase] 查看表结构",
      parameters: {
        type: "object",
        properties: { table: { type: "string" } },
        required: ["table"],
      },
      shouldDefer: true,
      searchHint: "database describe table columns schema",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ table }: any) =>
        JSON.stringify({
          table,
          columns: [
            { name: "id", type: "integer" },
            { name: "name", type: "text" },
          ],
        }),
    },
  ];

  registry.register(...simulatedTools);
  return simulatedTools.length;
}

async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import("node:child_process");
    execSync("echo test", { stdio: "ignore" });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    // console.log("\n连接 GitHub MCP Server...");
    try {
      const client = new MCPClient(
        "npx",
        ["-y", "@modelcontextprotocol/server-github"],
        { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
      );
      const tools = await registry.registerMCPServer("github", client);
      // console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (err) {
      console.log(
        `  MCP 连接失败: ${err instanceof Error ? err.message : err}`,
      );
      console.log("  降级为 Mock MCP...");
    }
  }

  if (!githubToken) {
    console.log("\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP");
  }

  // const mockClient = new MockMCPClient();
  // const tools = await registry.registerMCPServer("github", mockClient);
  // console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

// ── Commands ────────────────────────────────
const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
]);

// console.log(`已注册 ${registry.getAll().length} 个工具：`);
for (const tool of registry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? "可并发" : "串行",
    tool.isReadOnly ? "只读" : "读写",
  ].join(", ");
  // console.log(`  - ${tool.name}（${flags}）`);
}

const qwen = createOpenAI({
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = process.env.DASHSCOPE_API_KEY
  ? qwen.chat("qwen-plus")
  : createMockModel();

async function main() {
  await connectMCP();

  // Session 持久化
  const isContinue = process.argv.includes("--continue");
  const sessionId = "default";
  const store = new SessionStore(sessionId);

  let messages: ModelMessage[] = [];
  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(
      `\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条历史消息`,
    );
  } else {
    console.log(`\n[Session] 新会话 "${sessionId}"`);
  }
  console.log("messages------", messages);

  const timestamps = new Map<number, number>();
  const tracker = new UsageTracker(".usage/today.jsonl");

  // Apply three-layer defense
  const beforeTokens = estimateMessageTokens(messages);
  console.log(`\n=== 三层即时防线 ===`);
  console.log(`[防线前] ${messages.length} 条消息, ~${beforeTokens} tokens`);

  const defense = applyDefense(messages, timestamps);
  messages = defense.messages;

  // Clear injected history for chat — compression demo is done
  messages = [];
  timestamps.clear();

  const builder = new PromptBuilder()
    .pipe("coreRules", coreRules())
    .pipe("toolGuide", toolGuide())
    .pipe("deferredTools", deferredTools())
    .pipe("memoryContext", () => memoryStore.buildPromptSection())
    .pipe("sessionContext", sessionContext());

  // const messages: ModelMessage[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  function makePromptCtx(): PromptContext {
    return {
      toolCount: registry.getActiveTools().length,
      deferredToolSummary: registry.getDeferredToolSummary(),
      sessionMessageCount: messages.length,
      sessionId: "default",
    };
  }
  //   const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
  // 你有内置工具和 MCP 工具可用。MCP 工具以 mcp__ 开头，如 mcp__github__list_issues。
  // 需要查询 GitHub 信息时，使用 mcp__github__ 前缀的工具。
  // 需要操作本地文件时，使用内置工具。
  // 回答要简洁直接。 ${deferredSummary}`;

  function ask() {
    rl.question("\nYou: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit") {
        console.log("Bye!");
        await registry.closeAllMCP();
        rl.close();
        return;
      }

      const ctx: CommandContext = {
        messages,
        timestamps,
        registry,
        builder,
        tracker,
        sessionStore: store,
        model,
        makePromptCtx,
        ask,
        memoryStore,
      };
      const handled = dispatch(trimmed, ctx);
      if (handled === "async") return;
      if (handled) {
        ask();
        return;
      }

      const useMessage: ModelMessage = { role: "user", content: trimmed };
      messages.push(useMessage);
      timestamps.set(messages.length - 1, Date.now());
      store.append(useMessage);

      // 加了记忆，每次都构建下 system prompt，演示效果更明显
      const currentSystem = builder.build(makePromptCtx());
      const beforeLen = messages.length;
      await agentLoop(model, registry, messages, currentSystem, tracker);

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen);
      const now = Date.now();
      for (let i = beforeLen; i < messages.length; i++) timestamps.set(i, now);
      store.appendAll(newMessages);

      console.log(`  [Token] ~${estimateMessageTokens(messages)} tokens`);
      ask();
    });
  }

  console.log('Super Agent v0.11 — Memory System (type "exit" to quit)');
  console.log("快捷命令：");
  console.log("  /memory         — 查看所有记忆");
  console.log("  /memory search  — 搜索记忆");
  console.log("  /context        — 终端里看 context 占用矩阵");
  console.log("  /usage          — 累计 token 用量和成本");
  console.log("  status          — 当前消息数、token 和记忆数");
  console.log("");
  console.log(`  已加载 ${memoryStore.list().length} 条历史记忆`);
  console.log("");
  ask();
}

main().catch(console.error);
