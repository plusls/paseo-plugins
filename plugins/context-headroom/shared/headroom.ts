import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Paseo 的原始 usage。Claude provider 的 contextWindowUsedTokens 含 output tokens，
 * 与 Claude Code statusline 的 total_input_tokens 口径不同；outputTokens 保留用于
 * fallback 展示和排查。
 */
const usageSchema = z.object({
  contextWindowUsedTokens: z.number().nonnegative(),
  contextWindowMaxTokens: z.number().positive().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
});

// 出错时 usage 可能只拿到一部分字段，用于在 popover 里展示原始信息
const partialUsageSchema = z.object({
  contextWindowUsedTokens: z.number().nonnegative().nullable(),
  contextWindowMaxTokens: z.number().positive().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
});

const thresholdSchema = z.object({
  value: z.number().positive(),
  // 压缩窗口的原始值与来源：settings 文件里的值，或 context window 本身
  autoWindow: z.number().positive(),
  autoSource: z.enum(["settings", "window"]),
  autoFile: z.string().nullable(),
  pct: z.number().positive(),
  pctSource: z.enum(["settings", "default"]),
  pctFile: z.string().nullable(),
});

const baseShape = {
  agentId: z.string(),
  provider: z.string(),
  cwd: z.string(),
  observedAt: z.string(),
};

const claudeSnapshotSchema = z.object({
  ...baseShape,
  status: z.literal("claude"),
  usage: usageSchema.extend({ contextWindowMaxTokens: z.number().positive() }),
  // statusline 口径：input_tokens + cache_creation_input_tokens + cache_read_input_tokens
  used: z.number().nonnegative(),
  // transcript 不可用或与 Paseo usage 未对齐时，used 退化为包含输出的原始值
  includesOutput: z.boolean(),
  threshold: thresholdSchema,
  // 允许为负：超过压缩阈值时保留真实差额
  remaining: z.number(),
  usedPct: z.number().nonnegative(),
});

const rawSnapshotSchema = z.object({
  ...baseShape,
  status: z.literal("raw"),
  usage: usageSchema.extend({ contextWindowMaxTokens: z.number().positive() }),
  remaining: z.number(),
  usedPct: z.number().nonnegative(),
});

const noUsageSnapshotSchema = z.object({
  ...baseShape,
  status: z.literal("no_usage"),
});

const unavailableSnapshotSchema = z.object({
  ...baseShape,
  status: z.literal("unavailable"),
  usage: partialUsageSchema.nullable(),
  error: z.string(),
});

export const headroomSnapshotSchema = z.discriminatedUnion("status", [
  claudeSnapshotSchema,
  rawSnapshotSchema,
  noUsageSnapshotSchema,
  unavailableSnapshotSchema,
]);

export const headroomSubscription = defineSubscription({
  name: "context-headroom.watch",
  input: z.object({ agentId: z.string() }),
  event: headroomSnapshotSchema,
});

export type HeadroomSnapshot = z.infer<typeof headroomSnapshotSchema>;
export type ThresholdInfo = z.infer<typeof thresholdSchema>;

export function isClaudeProvider(provider: string): boolean {
  return provider === "claude" || provider.startsWith("claude-");
}
