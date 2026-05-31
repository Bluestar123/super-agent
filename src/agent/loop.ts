import { ModelMessage, streamText } from "ai";
import {
  detect,
  recordCall,
  recordResult,
  resetHistory,
} from "./loop-detection";
import { calculateDelay, isRetryable, sleep } from "../retry";
import { ToolRegistry } from "../tools/tool-registry";
import { type UsageTracker, normalizeUsage } from "../usage/tracker.js";

const MAX_STEPS = 10;
const MAX_RETRIES = 3;
const TOKEN_BUDGET = 50000;
export interface BudgetState {
  used: number;
  limit: number;
}

export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  tracker?: UsageTracker,
) {
  let step = 0;
  let totalTokens = 0;
  resetHistory();

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

    // 把 usage 喂给 tracker；tracker 内部按四类 token 分别累加并算 cost
    const norm = normalizeUsage(stepUsage);
    const stepRecord = tracker?.record(model?.modelId || "mock-model", norm);
    totalTokens +=
      norm.inputTokens +
      norm.outputTokens +
      norm.cacheReadTokens +
      norm.cacheWriteTokens;

    // cache 命中时才打印一行简洁状态，让 cache hit 立刻可见
    if (stepRecord && (norm.cacheReadTokens > 0 || norm.cacheWriteTokens > 0)) {
      const tag =
        norm.cacheReadTokens > 0
          ? `\x1b[38;5;36m✓ cache hit\x1b[0m`
          : `\x1b[38;5;220m✎ cache write\x1b[0m`;
      const detail =
        norm.cacheReadTokens > 0
          ? `read ${norm.cacheReadTokens}`
          : `write ${norm.cacheWriteTokens}`;
      console.log(
        `  [${tag}] ${detail} tokens · 本步 $${stepRecord.cost.toFixed(5)}`,
      );
    }

    if (totalTokens > TOKEN_BUDGET * 0.9) {
      console.log(
        `  [Token] ${totalTokens}/${TOKEN_BUDGET} (${Math.round((totalTokens / TOKEN_BUDGET) * 100)}%)`,
      );
    }
    if (totalTokens > TOKEN_BUDGET) {
      console.log("\n[Token 预算耗尽]");
      break;
    }

    // Token 预算追踪：budget 由调用方持有，跨轮持续累计
    // const inp =
    //   typeof stepUsage?.inputTokens === "number"
    //     ? stepUsage.inputTokens
    //     : (stepUsage?.inputTokens?.total ?? 0);
    // const out =
    //   typeof stepUsage?.outputTokens === "number"
    //     ? stepUsage.outputTokens
    //     : (stepUsage?.outputTokens?.total ?? 0);
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
