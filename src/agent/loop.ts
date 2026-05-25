import { ModelMessage, streamText } from "ai";
import { detect, recordCall, recordResult } from "../loop-detection";
import { calculateDelay, isRetryable, sleep } from "../retry";
import { ToolRegistry } from "../tool-registry";

const MAX_STEPS = 10;
const MAX_RETRIES = 3;

export interface BudgetState {
  used: number;
  limit: number;
}

export async function agentLoop(
  model: any,
  registry: ToolRegistry,
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
      tools: registry.toAISDKFormat(),
      messages,
      maxRetries: 0, // 这里不使用内置重试，改由外层控制
      onError(error) {
        console.error("执行出错:", error);
        // 这里可以根据需要添加重试逻辑，比如调用外部的 retry 模块
      },
    });

    let hasToolCall = false;
    let fullText = "";
    let shouldBreak = false;
    let lastToolCall: { name: string; input: any } | null = null;

    let stepResponse: Awaited<ReturnType<typeof streamText>["response"]>;

    let stepUsage: Awaited<ReturnType<typeof streamText>["usage"]>;
    // 步骤级重试：包裹整个 stream 消费过程
    // 只是为了计数用，真正的重试逻辑在 onError 里
    for (let attempt = 1; ; attempt++) {
      try {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            case "tool-call":
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(
                `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
              );

              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(
                  `. ${detection.message} (检测器: ${detection.detector}, 级别: ${detection.level}, 已调用次数: ${detection.count})`,
                );

                if (detection.level === "critical") {
                  console.log("检测到严重循环风险，停止执行");
                  shouldBreak = true;
                } else {
                  messages.push({
                    role: "user",
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              recordCall(part.toolName, part.input);
              break;

            case "tool-result":
              console.log(`  [结果: ${JSON.stringify(part.output)}]`);
              if (lastToolCall) {
                recordResult(
                  lastToolCall.name,
                  lastToolCall.input,
                  part.output,
                );
              }
              break;
          }
        }
        stepResponse = await result.response;

        stepUsage = await result.usage;
        break;
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(
          `  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`,
        );
        await sleep(delay);
        hasToolCall = false;
        fullText = "";
        shouldBreak = false;
        lastToolCall = null;
      }
    }
    if (shouldBreak) {
      console.log("循环检测触发，停止执行");
      break;
    }
    messages.push(...stepResponse!.messages);

    // Token 预算追踪：budget 由调用方持有，跨轮持续累计
    const inp =
      typeof stepUsage?.inputTokens === "number"
        ? stepUsage.inputTokens
        : (stepUsage?.inputTokens?.total ?? 0);
    const out =
      typeof stepUsage?.outputTokens === "number"
        ? stepUsage.outputTokens
        : (stepUsage?.outputTokens?.total ?? 0);
    // budget.used += inp + out;
    // const pct = Math.round((budget.used / budget.limit) * 100);
    // console.log(`  [Token] ${budget.used}/${budget.limit} (${pct}%)`);
    // if (budget.used > budget.limit) {
    //   console.log("\n[Token 预算耗尽]");
    //   // break;
    // }

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
