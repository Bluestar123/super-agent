import { ModelMessage, streamText } from "ai";

const MAX_STEPS = 10;

export interface BudgetState {
  used: number;
  limit: number;
}

export async function agentLoop(
  model: any,
  tools: any,
  messages: ModelMessage[],
  system: string,
) {
  let step = 0;

  while (step < MAX_STEPS) {
    step++;
    console.log("--- current Step", step, "---");

    const result = streamText({
      model,
      system,
      tools,
      messages,
    });

    let hasToolCall = false;
    let fullText = "";

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          process.stdout.write(part.text);
          fullText += part.text;
          break;

        case "tool-call":
          hasToolCall = true;
          console.log(
            `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
          );
          break;

        case "tool-result":
          console.log(`  [结果: ${JSON.stringify(part.output)}]`);
          break;
      }
    }
    // 这一步的完整结果
    const stepMessages = await result.response;
    messages.push(...stepMessages.messages);

    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }
    console.log("还有工具，继续执行");
  }
  if (step >= MAX_STEPS) {
    console.log("达到最大步骤限制，停止执行");
  }
}
