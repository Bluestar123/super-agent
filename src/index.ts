import "dotenv/config";
import { generateText, stepCountIs, streamText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMockModel } from "./mock-model";
import { createInterface } from "node:readline";
import { weatherTool, calculatorTool } from "./tools/utility-tools";

const tools = {
  get_weather: weatherTool,
  calculator: calculatorTool,
};

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

const messages: ModelMessage[] = [];

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

    const result = streamText({
      model,
      //       system: `你是 Super Agent，一个专注于软件开发的 AI 助手。
      // 你说话简洁直接，喜欢用代码示例来解释问题。
      // 如果用户的问题不够清晰，你会反问而不是瞎猜。`,
      system:
        "你是 Super Agent，一个有工具调用能力的 AI 助手。需要时主动使用工具获取信息，不要编造数据。",
      messages,
      tools,
      stopWhen: stepCountIs(5), // 5步后无论如何都停止，避免死循环
    });
    process.stdout.write("assistant: ");

    let fullResponse = "";
    // 如果调用工具而不是返回文本textStream就没数据， 需要fullStream 代替
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          process.stdout.write(part.text);
          fullResponse += part.text;
          break;
        case "tool-call":
          console.log(
            `\n  [调用工具: ${part.toolName}(${JSON.stringify(part.input)})]`,
          );
          break;
        case "tool-result":
          console.log(`  [工具返回: ${JSON.stringify(part.output)}]`);
          break;
      }
    }
    console.log();

    messages.push({
      role: "assistant",
      content: fullResponse,
    });

    ask();
  });
}
console.log('Super Agent v0.2 — Agent Loop (type "exit" to quit)\n');
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
