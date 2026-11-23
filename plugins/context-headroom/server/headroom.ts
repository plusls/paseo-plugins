import type { PaseoAgent } from "@getpaseo/client";
import type { SubscriptionEvent, SubscriptionInput } from "@getpaseo/plugin";
import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import {
  headroomSubscription,
  isClaudeProvider,
  type HeadroomSnapshot,
  type ThresholdInfo,
} from "../shared/headroom";
import { readThresholdSettings } from "./settings";
import { readLastAssistantUsage } from "./transcript";

const DEFAULT_AUTOCOMPACT_PCT = 95;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonNegativeNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function unavailable(
  base: { agentId: string; provider: string; cwd: string; observedAt: string },
  usage: {
    contextWindowUsedTokens: number | null;
    contextWindowMaxTokens: number | null;
    outputTokens: number | null;
  },
  error: string,
): HeadroomSnapshot {
  return { ...base, status: "unavailable", usage, error };
}

/**
 * 计算一个 agent 的上下文余量快照。
 * Claude provider 精确对齐 ~/.claude/statusline-command.sh；其他 provider 只展示原始窗口。
 */
export async function buildSnapshot(agent: PaseoAgent): Promise<HeadroomSnapshot> {
  const base = {
    agentId: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    observedAt: new Date().toISOString(),
  };

  const lastUsage = agent.lastUsage;
  if (!lastUsage) return { ...base, status: "no_usage" };

  const usedRaw = nonNegativeNumber(lastUsage.contextWindowUsedTokens);
  const maxTokens = positiveNumber(lastUsage.contextWindowMaxTokens);
  const outputTokens = nonNegativeNumber(lastUsage.outputTokens);
  const rawUsage = {
    contextWindowUsedTokens: usedRaw,
    contextWindowMaxTokens: maxTokens,
    outputTokens,
  };

  if (usedRaw === null) {
    return unavailable(base, rawUsage, "Paseo 未提供有效的 contextWindowUsedTokens");
  }
  if (maxTokens === null) {
    return unavailable(base, rawUsage, "Paseo 未提供有效的 contextWindowMaxTokens");
  }
  const usage = {
    contextWindowUsedTokens: usedRaw,
    contextWindowMaxTokens: maxTokens,
    outputTokens,
  };

  if (!isClaudeProvider(agent.provider)) {
    // 非 Claude provider 不猜压缩阈值，只按 Paseo 的原始窗口口径展示
    return {
      ...base,
      status: "raw",
      usage: { ...usage, contextWindowMaxTokens: maxTokens },
      remaining: maxTokens - usedRaw,
      usedPct: (usedRaw * 100) / maxTokens,
    };
  }

  // statusline 的 total_input_tokens 是 input-only，Paseo 的 contextWindowUsedTokens 含 output。
  // 先尝试用 transcript 最后一条主链 assistant 的 usage 精确对齐：
  // 它的 input + cache_creation + cache_read + output 应正好等于 contextWindowUsedTokens。
  let used: number | null = null;
  let includesOutput = false;
  const transcriptUsage = await readLastAssistantUsage(agent.persistence?.sessionId);
  if (transcriptUsage) {
    const inputOnly =
      transcriptUsage.inputTokens +
      transcriptUsage.cacheCreationInputTokens +
      transcriptUsage.cacheReadInputTokens;
    const withOutput = inputOnly + transcriptUsage.outputTokens;
    if (withOutput === usedRaw) {
      used = inputOnly;
    }
  }

  if (used === null) {
    // transcript 还没写入当前消息或不可用时，Paseo 的 outputTokens 是结果消息里的累计值，
    // 无法可靠扣成 input-only。这里直接用原始值，宁可少报余量，也不静默低估已用。
    used = usedRaw;
    includesOutput = true;
  }

  let settings;
  try {
    settings = await readThresholdSettings(agent.cwd);
  } catch (error) {
    return unavailable(base, usage, errorMessage(error));
  }

  const autoWindow = settings.autoWindow?.value ?? maxTokens;
  const pct = settings.pct?.value ?? DEFAULT_AUTOCOMPACT_PCT;
  // 与 statusline 一致：min(压缩窗口, context window)，乘百分比后截断
  const thresholdValue = Math.floor((Math.min(autoWindow, maxTokens) * pct) / 100);
  if (thresholdValue <= 0) {
    return unavailable(base, usage, "压缩阈值计算结果为 0");
  }

  const threshold: ThresholdInfo = {
    value: thresholdValue,
    autoWindow,
    autoSource: settings.autoWindow ? "settings" : "window",
    autoFile: settings.autoWindow?.file ?? null,
    pct,
    pctSource: settings.pct ? "settings" : "default",
    pctFile: settings.pct?.file ?? null,
  };

  return {
    ...base,
    status: "claude",
    usage: { ...usage, contextWindowMaxTokens: maxTokens },
    used,
    includesOutput,
    threshold,
    remaining: thresholdValue - used,
    usedPct: (used * 100) / thresholdValue,
  };
}

type HeadroomSubscriptionInput = SubscriptionInput<typeof headroomSubscription>;
type HeadroomSubscriptionEvent = SubscriptionEvent<typeof headroomSubscription>;

function signatureOf(snapshot: HeadroomSnapshot): string {
  // observedAt 只表示推送时间，不参与内容是否变化的判断
  const copy: Record<string, unknown> = { ...snapshot };
  delete copy.observedAt;
  return JSON.stringify(copy);
}

/**
 * 订阅一个 agent 的 usage 更新。先用 agents.list 的订阅快照拿到当前值，
 * 之后只在该 agent 的 agent_update 到达时重新计算并推送。
 */
export async function watchAgentHeadroom(
  { agentId }: HeadroomSubscriptionInput,
  { paseo, push, signal }: PluginSubscriptionContext<HeadroomSubscriptionEvent>,
): Promise<void> {
  let lastSignature: string | null = null;
  // 串行处理更新，避免异步读 settings 后乱序推送旧值
  let chain = Promise.resolve();

  const publish = (agent: PaseoAgent): void => {
    chain = chain
      .then(async () => {
        if (signal.aborted) return;
        const snapshot = await buildSnapshot(agent);
        const signature = signatureOf(snapshot);
        if (signature === lastSignature) return;
        lastSignature = signature;
        await push(snapshot);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) console.error("[context-headroom] 推送上下文余量失败", error);
      });
  };

  const findAgent = (entries: readonly { agent: PaseoAgent }[]): PaseoAgent | null =>
    entries.find((entry) => entry.agent.id === agentId)?.agent ?? null;

  const observation = await paseo.agents.list({ subscribe: {}, signal });
  const initial = findAgent(observation.entries);
  if (initial) {
    publish(initial);
  } else {
    try {
      const refreshed = await paseo.agents.ref(agentId).refresh();
      if (refreshed?.agent) publish(refreshed.agent);
    } catch (error) {
      if (!signal.aborted) {
        console.error(`[context-headroom] 读取 agent ${agentId} 快照失败`, errorMessage(error));
      }
    }
  }

  observation.subscription.subscribe({
    snapshot: ({ entries }) => {
      const agent = findAgent(entries);
      if (agent) publish(agent);
    },
    update: (message) => {
      if (message.type !== "agent_update") return;
      const update = message.payload;
      if (update.kind === "upsert" && update.agent.id === agentId) publish(update.agent);
    },
    error: (error) => {
      if (!signal.aborted) {
        console.error(`[context-headroom] agent ${agentId} 更新订阅失败`, errorMessage(error));
      }
    },
  });

  // 订阅要保持在 signal abort 之前不结束；handler 的 promise resolve 会关闭订阅
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
