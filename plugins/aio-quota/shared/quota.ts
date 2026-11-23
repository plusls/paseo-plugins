import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const quotaWindowSnapshotSchema = z.object({
  // 接口里的窗口位置；展示时只用来区分主窗口和次窗口
  kind: z.enum(["primary", "secondary"]),
  usedPercent: z.number(),
  limitWindowSeconds: z.number(),
  // 重置时刻的 epoch 秒
  resetAt: z.number(),
  // 从本次响应发出时开始计算的剩余秒数；缓存命中时由 daemon 扣除缓存经过时间
  resetAfterSeconds: z.number(),
});

export const quotaRateLimitSnapshotSchema = z.object({
  limitReached: z.boolean(),
  windows: z.array(quotaWindowSnapshotSchema),
});

export const quotaSnapshotSchema = z.object({
  fetchedAt: z.string(),
  // 本地映射后的套餐标签，不是接口返回的原始 plan_type
  planType: z.string(),
  // rate_limit 为 null 表示接口没有返回额度窗口
  rateLimit: quotaRateLimitSnapshotSchema.nullable(),
});

export const quotaSnapshotRpc = defineRpc({
  name: "quota.snapshot",
  input: z.object({ forceRefresh: z.boolean().optional() }),
  output: quotaSnapshotSchema,
});

export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;
export type QuotaWindowSnapshot = z.infer<typeof quotaWindowSnapshotSchema>;

// 剩余百分比由已用百分比换算；超出 0 到 100 的值按边界显示
export function remainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}
