import "dotenv/config";
import { generateText, stepCountIs, streamText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMockModel } from "./mock-model";
import { createInterface } from "node:readline";
import { agentLoop, type BudgetState } from "./agent/loop";
import { ToolRegistry } from "./tool-registry";
import { allTools } from "./tools/utility-tools";

const registry = new ToolRegistry();
registry.register(...allTools);

console.log(`已注册 ${registry.getAll().length} 个工具：`);
for (const tool of registry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? "可并发" : "串行",
    tool.isReadOnly ? "只读" : "读写",
  ].join(", ");
  console.log(`  - ${tool.name}（${flags}）`);
}

const qwen = createOpenAI({
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = process.env.DASHSCOPE_API_KEY
  ? qwen.chat("qwen-plus")
  : createMockModel();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

const messages: ModelMessage[] = [];

// 预算由调用方持有，跨轮持续累积， agentloop 只负责消费
const budget: BudgetState = {
  used: 0,
  limit: 15000,
};

function ask() {
  rl.question("\n You:", async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      console.log("Exiting...");
      rl.close();
      return;
    }

    messages.push({
      role: "user",
      content: trimmed,
    });

    await agentLoop(model, registry, messages, SYSTEM, budget);
    ask();
  });
}
console.log('Super Agent v0.3 — Fuses (type "exit" to quit)\n');
console.log('试试输入："测试死循环"、"测试重试"、"测试预算" 看三层防护效果\n');
ask();

// async function main() {
//   // const { text } = await generateText({
//   //   model,
//   //   prompt: "用一句话介绍你自己",
//   // });
//   const result = await streamText({
//     model,
//     prompt: "用一句话介绍你自己",
//   });

//   for await (const chunk of result.textStream) {
//     process.stdout.write(chunk);
//   }

//   console.log();
// }

// main();
