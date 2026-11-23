import { z } from "zod";
import type { QuotaSnapshot, QuotaWindowSnapshot } from "../shared/quota";

// 服务端缓存，多个客户端和自动刷新共用同一次请求；手动刷新绕过
const CACHE_TTL_MS = 60_000;
// 接口无响应时按失败处理，避免请求一直挂着
const REQUEST_TIMEOUT_MS = 10_000;

// React Native 的全局类型也声明了 AbortSignal，覆盖掉 Node 的静态 timeout；
// daemon 运行在 Node 上，这里按 Node 的运行时签名调用
const abortSignalWithTimeout = AbortSignal as typeof AbortSignal & {
  timeout(milliseconds: number): AbortSignal;
};

const rawWindowSchema = z.object({
  used_percent: z.number().finite(),
  limit_window_seconds: z.number().finite(),
  reset_after_seconds: z.number().finite(),
  reset_at: z.number().finite(),
});

// plan_type 会进入缓存并显示，只映射为本地标签；
// 无法识别的值显示固定文案，避免任意响应字符串（包括账号标识）进入快照
const PLAN_LABELS = new Map([
  ["free", "Free"],
  ["plus", "Plus"],
  ["pro", "Pro"],
  ["team", "Team"],
  ["enterprise", "Enterprise"],
  ["edu", "Edu"],
  ["business", "Business"],
]);
const UNKNOWN_PLAN_LABEL = "未知套餐";

// 只声明需要的额度字段；zod 默认丢弃未声明字段，账号标识不会进入快照
const usageResponseSchema = z.object({
  plan_type: z.string().min(1).max(64),
  rate_limit: z
    .object({
      limit_reached: z.boolean(),
      primary_window: rawWindowSchema.nullable(),
      secondary_window: rawWindowSchema.nullable(),
    })
    .nullable(),
});

interface CacheEntry {
  snapshot: QuotaSnapshot;
  expiresAt: number;
  usageUrl: string;
}

let cached: CacheEntry | null = null;
let inFlight: { usageUrl: string; promise: Promise<QuotaSnapshot> } | null = null;

function parseUsageResponse(body: unknown, fetchedAt: string): QuotaSnapshot {
  const result = usageResponseSchema.safeParse(body);
  if (!result.success) {
    // 只报告字段路径和错误类型，不把响应内容拼进错误消息
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    throw new Error(`AIO usage 响应字段不合法：${path}（${issue.code}）`);
  }

  const { plan_type: rawPlanType, rate_limit: rateLimit } = result.data;
  const planType = PLAN_LABELS.get(rawPlanType.toLowerCase()) ?? UNKNOWN_PLAN_LABEL;
  if (rateLimit === null) {
    return { fetchedAt, planType, rateLimit: null };
  }

  const windows: QuotaWindowSnapshot[] = [];
  const entries = [
    ["primary", rateLimit.primary_window],
    ["secondary", rateLimit.secondary_window],
  ] as const;
  for (const [kind, window] of entries) {
    if (window === null) continue;
    windows.push({
      kind,
      usedPercent: window.used_percent,
      limitWindowSeconds: window.limit_window_seconds,
      resetAt: window.reset_at,
      resetAfterSeconds: window.reset_after_seconds,
    });
  }

  return {
    fetchedAt,
    planType,
    rateLimit: { limitReached: rateLimit.limit_reached, windows },
  };
}

// 缓存里的 resetAfterSeconds 以抓取时刻为基准；返回前扣除缓存经过的时间，
// 客户端再用本地接收时间倒计时，避免依赖 daemon 和客户端的绝对时钟一致
function adjustResetAfterSeconds(snapshot: QuotaSnapshot, nowMs: number): QuotaSnapshot {
  const rateLimit = snapshot.rateLimit;
  if (rateLimit === null) return snapshot;
  const ageSeconds = Math.max(
    0,
    Math.floor((nowMs - Date.parse(snapshot.fetchedAt)) / 1000),
  );
  if (ageSeconds === 0) return snapshot;
  return {
    ...snapshot,
    rateLimit: {
      ...rateLimit,
      windows: rateLimit.windows.map((quotaWindow) => ({
        ...quotaWindow,
        resetAfterSeconds: Math.max(0, quotaWindow.resetAfterSeconds - ageSeconds),
      })),
    },
  };
}

async function fetchSnapshot(usageUrl: string): Promise<QuotaSnapshot> {
  let response: Response;
  try {
    response = await fetch(usageUrl, {
      signal: abortSignalWithTimeout.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error("请求 AIO usage 接口失败，请检查插件设置里的地址和 AIO Coding Hub 状态", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error(`AIO usage 接口返回 HTTP ${response.status}`);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new Error(`读取 AIO usage 响应失败或超时（HTTP ${response.status}）`, {
      cause: error,
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error("AIO usage 接口返回的不是合法 JSON", { cause: error });
  }

  const snapshot = parseUsageResponse(body, new Date().toISOString());
  cached = { snapshot, expiresAt: Date.now() + CACHE_TTL_MS, usageUrl };
  return snapshot;
}

export async function getQuotaSnapshot(
  usageUrl: string,
  forceRefresh = false,
): Promise<QuotaSnapshot> {
  if (
    !forceRefresh &&
    cached &&
    cached.usageUrl === usageUrl &&
    Date.now() < cached.expiresAt
  ) {
    return adjustResetAfterSeconds(cached.snapshot, Date.now());
  }
  // 自动刷新和手动刷新可能重叠，共享同一次请求
  if (inFlight && inFlight.usageUrl === usageUrl) return inFlight.promise;

  const promise = fetchSnapshot(usageUrl);
  inFlight = { usageUrl, promise };
  try {
    return await promise;
  } catch (error) {
    // 失败后不再返回旧快照，下一轮自动刷新会重新请求
    if (cached !== null && cached.usageUrl === usageUrl) cached = null;
    throw error;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}
