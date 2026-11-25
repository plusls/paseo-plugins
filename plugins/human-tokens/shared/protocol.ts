import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 人类 token 的采集契约。
 *
 * token 在这里等同于 Unicode 码点，不接 tokenizer；所以所有 tok 数字都是估算，
 * 用于比较趋势，不代表模型的 billing token。
 */

export const BIN_COUNT = 64;
/** 客户端采样间隔；一个时间片在所有可见 bin 之间按权重分摊 */
export const SAMPLE_MS = 500;
/** 上传间隔；待上传批次失败时保留并在下次重试 */
export const FLUSH_MS = 30_000;
/** 一个 bin 消失多久后再次出现算一次回看，避免滚动抖动误判 */
export const REVIEW_GAP_MS = 5_000;
/** 回看某个 bin 达到它阅读时长的这个比例，才记一次重读事件 */
export const REVIEW_RATIO = 0.2;
/** 回看阈值下限；短消息的 bin 只有几十毫秒，不能一律套 100ms */
export const REVIEW_MIN_MS = 30;
/** 新会话重读已完成内容时，bin 覆盖达到这个值才推断为回看 */
export const REVIEW_INFER_COVERAGE = 51;
/** 输入变化达到这个码点数按粘贴/草稿恢复处理；web 另有真实 paste 事件 */
export const PASTE_THRESHOLD = 20;
export const ASCII_CHARS_PER_SECOND = 18;
export const NON_ASCII_CHARS_PER_SECOND = 6;
/** 再短的消息也至少按 1 秒阅读估算 */
export const MIN_MESSAGE_MS = 1_000;
/** 单个批次最多携带的消息数；更多的留在下一批 */
export const MAX_MESSAGES_PER_BATCH = 200;
/** 30 分钟内没再出现、也没有待上传变化的消息状态可以丢掉 */
export const STATE_TTL_MS = 30 * 60_000;

export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** 时间桶粒度；图表按这个粒度采集和显示 */
export const SLOT_MS = 5 * 60_000;
export const SLOTS_PER_DAY = (24 * 60 * 60_000) / SLOT_MS;
export const slotSchema = z.number().int().min(0).max(SLOTS_PER_DAY - 1);

/** 0-255 的 BIN_COUNT 段覆盖/回看覆盖率 */
export const coverageSchema = z.array(z.number().int().min(0).max(255)).length(BIN_COUNT);

export const deviceSettings = defineSettings({
  id: "human-tokens-device",
  scope: "device",
  version: 1,
  schema: z.object({
    // 首次使用时由客户端生成；只用于区分同一 daemon 下的不同客户端
    deviceId: z.string().default(""),
  }),
});

export const messageReadingSchema = z.object({
  /** occurrenceKey（agentId:itemId）；itemId 只在 agent 内唯一 */
  messageId: z.string().min(1),
  /** messageId 相同但文本变了的版本标识，避免同长度新文本混进旧覆盖 */
  version: z.string().min(1),
  agentId: z.string().nullable(),
  chars: z.number().int().min(1),
  /** 首次阅读覆盖，255 表示这个 bin 已读完 */
  coverage: coverageSchema,
  /** 回看覆盖，和 coverage 分开存储；重读长度按这个数组算 */
  reviewCoverage: coverageSchema,
  /** 本 session 内这个 message 已发生的重读事件数，累计值 */
  revisits: z.number().int().min(0),
});

export const ingestInputSchema = z.object({
  batchId: z.string().min(1),
  sessionId: z.string().min(1),
  deviceId: z.string().min(1),
  /**
   * 客户端本地日期，按批次归属。正常上传时跨午夜的误差最多一个上传间隔；
   * 上传失败或长时间离线时，积压的活动会记到恢复当天。
   */
  day: daySchema,
  /**
   * 客户端本地 5 分钟桶，批次构建时取；同一天内按这个桶归属增量。
   * 旧客户端没有这个字段；收到时只写日汇总和消息覆盖，不写 5 分钟桶。
   */
  slot: slotSchema.optional(),
  messages: z.array(messageReadingSchema).max(MAX_MESSAGES_PER_BATCH),
  /** 以下都是本批次增量 */
  activeReadMs: z.number().int().min(0),
  activeReviewMs: z.number().int().min(0),
  typedChars: z.number().int().min(0),
  activeTypingMs: z.number().int().min(0),
  switches: z.number().int().min(0),
});

export const ingestOutputSchema = z.object({ accepted: z.literal(true) });

export const ingestRpc = defineRpc({
  name: "human-tokens.ingest",
  input: ingestInputSchema,
  output: ingestOutputSchema,
});

export const statsInputSchema = z.object({
  /** 客户端本地今天，用来决定 daily 的右边界和 today 汇总 */
  today: daySchema,
  days: z.union([z.literal(7), z.literal(30)]),
});

export const totalsSchema = z.object({
  /** 去重后的首次阅读 token；跨 session 取每 bin 最大覆盖 */
  readTokens: z.number(),
  /** 已读完的 token；cache miss 的分母 */
  completedTokens: z.number(),
  /** 重读覆盖折算出的 token；cache miss 的分子 */
  missTokens: z.number(),
  /** 插件实际见过的 AI 消息总码点数，不含没挂载过的历史消息 */
  producedTokens: z.number(),
  typedChars: z.number(),
  revisits: z.number(),
  switches: z.number(),
  activeReadMs: z.number(),
  activeReviewMs: z.number(),
  activeTypingMs: z.number(),
  messages: z.number(),
});

export const dailySchema = z.object({
  day: daySchema,
  readTokens: z.number(),
  missTokens: z.number(),
  typedChars: z.number(),
  revisits: z.number(),
  switches: z.number(),
});

/** 一个 5 分钟桶；没有活动的 slot 也会补 0，方便直接画全天曲线 */
export const slotStatsSchema = z.object({
  slot: slotSchema,
  readTokens: z.number(),
  missTokens: z.number(),
  typedChars: z.number(),
  activeReadMs: z.number(),
  activeReviewMs: z.number(),
  activeTypingMs: z.number(),
});

export const statsOutputSchema = z.object({
  lifetime: totalsSchema,
  today: totalsSchema,
  daily: z.array(dailySchema),
  slots: z.array(slotStatsSchema),
});

export const statsRpc = defineRpc({
  name: "human-tokens.stats",
  input: statsInputSchema,
  output: statsOutputSchema,
});

export type IngestInput = z.infer<typeof ingestInputSchema>;
export type MessageReading = z.infer<typeof messageReadingSchema>;
export type Totals = z.infer<typeof totalsSchema>;
export type Daily = z.infer<typeof dailySchema>;
export type SlotStats = z.infer<typeof slotStatsSchema>;
export type StatsOutput = z.infer<typeof statsOutputSchema>;
