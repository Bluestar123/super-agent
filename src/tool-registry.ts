import { jsonSchema } from "ai";
import { MCPClient } from "./tools/mcp-client";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  execute: (input: any) => Promise<unknown>;

  shouldDefer?: boolean; // 是否延迟加载
  //searchHint 是给 ToolSearch 用的匹配线索——一个 3-10 个词的短语，
  // 描述这个工具能做什么。比如浏览器导航工具的 hint 是 "browser navigate open url webpage"，
  // Supabase 查询工具的 hint 是 "supabase database sql query select"
  searchHint?: string; // 搜索提示词， 帮助 toolsearch 匹配
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  private mcpClients: Array<MCPClient> = [];

  // 三个状态变量构成一把读写锁
  private exclusiveLock = false; // 当前是否有独占锁持有者
  private concurrentCount = 0; // 当前共享锁持有数
  private waitQueue: Array<() => void> = []; // 阻塞等待中的 resolve 函数

  private discoveredTools = new Set<string>();

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  async registerMCPServer(
    serverName: string,
    client: MCPClient,
  ): Promise<string[]> {
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();
    const registered: string[] = [];

    for (const tool of tools) {
      // 命名空间
      const prefixedName = `mcp__${serverName}__${tool.name}`;
      if (this.tools.has(prefixedName)) continue;

      const toolClient = client;
      const originalName = tool.name;

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        execute: async (input: any) => {
          return toolClient.callTool(originalName, input);
        },
        shouldDefer: true, // MCP 工具默认延迟加载，等真正调用时才连接服务器获取工具列表
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
      });

      registered.push(prefixedName);
    }

    return registered;
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }
  // 异步加载
  searchTools(query: string): ToolDefinition[] {
    const q = query.trim();
    const results: ToolDefinition[] = [];

    const names = q.includes(",")
      ? q
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
      : [q];

    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool && tool.name !== "tool_search") {
        results.push(tool);
        this.discoveredTools.add(tool.name);
      }
    }
    return results;
  }

  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false;
      }
      return true;
    });
  }

  //getDeferredToolSummary 方法生成延迟工具的名字列表，附到 System prompt 里。
  // 模型看到这个列表就知道有哪些能力可用，需要时调 tool_search 搜索：
  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter((tool) => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name);
    });

    if (deferred.length === 0) return "";

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : "";
      return `  - ${t.name}${hint}`;
    });

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join("\n")}`;
  }
  //为了直观地看到延迟加载省了多少 token，再加一个估算方法：
  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0;
    let deferred = 0;

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length;
      const tokens = Math.ceil(schemaSize / 4);

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens;
      } else {
        active += tokens;
      }
    }

    return { active, deferred, total: active + deferred };
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  // 获取共享锁：只要没人独占就能拿，多个只读工具可以同时持有
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  // 获取独占锁：必须等所有共享锁释放、且没人持独占
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  // 锁释放时把等待队列全唤醒，让它们重新去抢锁
  private drainQueue(): void {
    // 清空返回被删除的元素
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }

  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    const activeTools = this.getActiveTools();
    for (const tool of activeTools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;

      const isSafe = tool.isConcurrencySafe === true;
      const registry = this;

      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          // 在真正执行前先按 isConcurrencySafe 获取锁
          if (isSafe) {
            await registry.acquireConcurrent();
            console.log(`并发执行 ${tool.name} 共享锁`);
          } else {
            await registry.acquireExclusive();
            console.log(`  [串行] ${tool.name} 获取独占锁，等待其他工具完成`);
          }
          try {
            const raw = await executeFn(input);
            const text =
              typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            // 不管成功还是抛异常，锁都要释放
            if (isSafe) {
              registry.releaseConcurrent();
            } else {
              registry.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }
}

export function truncateResult(
  text: string,
  maxChars: number = DEFAULT_MAX_RESULT_CHARS,
): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
