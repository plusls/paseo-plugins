import {
  ASCII_CHARS_PER_SECOND,
  BIN_COUNT,
  MIN_MESSAGE_MS,
  NON_ASCII_CHARS_PER_SECOND,
  REVIEW_GAP_MS,
  REVIEW_MIN_MS,
  REVIEW_RATIO,
} from "../shared/protocol";

/**
 * 一个已完成的 assistant 消息在当前视口里的位置。
 *
 * top/bottom 与 viewportTop/viewportBottom 必须来自同一坐标系：
 * web 用 getBoundingClientRect，native 用 Fabric 的窗口坐标。
 * 只包含 phase === "complete" 的消息，流式消息不参与阅读估算。
 */
export interface ScanRow {
  /** assistant 消息的 occurrenceKey（agentId:itemId），全局唯一 */
  key: string;
  /** 与 key 相同；fallback 时是 web:<data-message-id> */
  messageId: string;
  agentId: string | null;
  text: string;
  top: number;
  bottom: number;
  viewportTop: number;
  viewportBottom: number;
  /** 平台层已经判断过元素有布局、没有被 display/opacity 隐藏 */
  visible: boolean;
}

export interface BinState {
  /** 这个 bin 的预计阅读时长，按字数估算 */
  estimateMs: number;
  /** 首次阅读累计停留，封顶 estimateMs */
  dwellMs: number;
  completed: boolean;
  /** 当前是否处于回看片段；只有已完成的 bin 会进入 */
  reviewActive: boolean;
  /** 本轮回看累计停留，进入回看时归零 */
  reviewDwellMs: number;
  /** 历史最大回看覆盖，0-255 */
  reviewCoverage: number;
  /** 上一次从可见变为不可见的时间；首次出现前是 null */
  lastVisibleAt: number | null;
  visible: boolean;
  /** 这个 bin 历史上在视口内出现过的最大比例；没完整出现过就不能算读完 */
  maxVisibleFraction: number;
  /** 上一个采样点也可见；新出现的 bin 本 tick 不分配时间，避免快速滚过计入 */
  accruable: boolean;
}

export interface SavedCoverage {
  /** 文本版本，和 chars 一起确认还是同一条消息 */
  version: string;
  chars: number;
  coverage: number[];
  reviewCoverage: number[];
  revisits: number;
}

export interface MessageState {
  key: string;
  messageId: string;
  /** 文本版本，和 chars 一起区分同一 item 的不同内容 */
  version: string;
  agentId: string | null;
  chars: number;
  /** 上一次扫描到的原文，只用于避免每 tick 重算 hash；不上传 */
  textRef: string;
  bins: BinState[];
  visible: boolean;
  lastVisibleAt: number;
  /** 最近一次回看活动时间，用来切分回看 episode */
  lastReviewActivityAt: number;
  /** 当前回看 episode 是否已经计过一次 revisit */
  reviewEpisodeCounted: boolean;
  /** 本 session 内累计的重读事件数，上传给 daemon 后由 daemon 算增量 */
  revisits: number;
  /** 有未上传的覆盖/回看/事件变化 */
  dirty: boolean;
}

export interface ActiveBin {
  state: MessageState;
  index: number;
  /** visibleFraction * estimateMs */
  weight: number;
  review: boolean;
}

export const ZERO_FRACTIONS: readonly number[] = Array.from(
  { length: BIN_COUNT },
  () => 0,
);

export function charCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // 代理对算一个码点
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

export function estimateDurationMs(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) <= 0x7f) ascii += 1;
    else other += 1;
  }
  const seconds =
    ascii / ASCII_CHARS_PER_SECOND + other / NON_ASCII_CHARS_PER_SECOND;
  return Math.max(MIN_MESSAGE_MS, seconds * 1000);
}

export function textVersion(text: string): string {
  // 不引入 crypto；两个 32 位滚动 hash 足以区分同一 messageId 的文本版本
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${text.length}:${first.toString(36)}${second.toString(36)}`;
}

export function createMessageState(
  row: ScanRow,
  chars: number,
  version: string,
  now: number,
): MessageState {
  const estimateMs = estimateDurationMs(row.text) / BIN_COUNT;
  return {
    key: row.key,
    messageId: row.messageId,
    version,
    agentId: row.agentId,
    chars,
    textRef: row.text,
    bins: Array.from({ length: BIN_COUNT }, () => ({
      estimateMs,
      dwellMs: 0,
      completed: false,
      reviewActive: false,
      reviewDwellMs: 0,
      reviewCoverage: 0,
      lastVisibleAt: null,
      visible: false,
      maxVisibleFraction: 0,
      accruable: false,
    })),
    visible: false,
    lastVisibleAt: now,
    lastReviewActivityAt: 0,
    reviewEpisodeCounted: false,
    revisits: 0,
    // 单次采样就滚过去的消息没有 dwell 增量，也要把「见过」上传，
    // 否则它会在没有第二批数据时被整个丢掉
    dirty: true,
  };
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * 用之前保存的覆盖恢复一个被清理掉的 state。
 *
 * 恢复的 bin 当作早就看过：首次出现时如果已 complete，会直接进入回看片段，
 * 这样同一 app 会话里隔很久再回来看仍能记成 cache miss。
 */
export function restoreMessageState(
  state: MessageState,
  saved: SavedCoverage,
  now: number,
): void {
  for (let index = 0; index < BIN_COUNT; index += 1) {
    const bin = state.bins[index];
    const coverage = Math.max(0, Math.min(255, saved.coverage[index] ?? 0));
    const review = Math.max(0, Math.min(255, saved.reviewCoverage[index] ?? 0));
    bin.reviewCoverage = review;
    // 旧数据里已经读到的比例，至少说明历史上看到过这么多
    bin.maxVisibleFraction = Math.max(bin.maxVisibleFraction, coverage / 255);
    if (coverage === 255) {
      bin.completed = true;
      bin.dwellMs = bin.estimateMs;
      // 已离开至少一个 TTL，再出现时按回看处理
      bin.lastVisibleAt = now - REVIEW_GAP_MS - 1;
    } else {
      bin.dwellMs = (coverage / 255) * bin.estimateMs;
    }
  }
  state.revisits = saved.revisits;
  // 恢复的覆盖可能来自没送达的旧批次；标脏让服务端再合并一次，重复覆盖不会重复计数
  state.dirty = true;
}

/** 每行按高度均分 BIN_COUNT 段，返回每段在视口内的可见比例 */
export function binFractions(row: ScanRow): number[] {
  if (
    !finite(row.top) ||
    !finite(row.bottom) ||
    !finite(row.viewportTop) ||
    !finite(row.viewportBottom)
  ) {
    return ZERO_FRACTIONS.slice();
  }
  const height = row.bottom - row.top;
  const visibleTop = Math.max(row.top, row.viewportTop);
  const visibleBottom = Math.min(row.bottom, row.viewportBottom);
  if (height <= 0 || visibleBottom <= visibleTop) return ZERO_FRACTIONS.slice();

  const binHeight = height / BIN_COUNT;
  const fractions = new Array<number>(BIN_COUNT);
  for (let index = 0; index < BIN_COUNT; index += 1) {
    const binTop = row.top + index * binHeight;
    const binBottom = binTop + binHeight;
    const overlap =
      Math.min(binBottom, visibleBottom) - Math.max(binTop, visibleTop);
    fractions[index] =
      overlap > 0 ? Math.min(1, overlap / binHeight) : 0;
  }
  return fractions;
}

export function visibleHeight(row: ScanRow): number {
  if (
    !finite(row.top) ||
    !finite(row.bottom) ||
    !finite(row.viewportTop) ||
    !finite(row.viewportBottom)
  ) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(row.bottom, row.viewportBottom) -
      Math.max(row.top, row.viewportTop),
  );
}

/**
 * 更新一个消息的可见状态和回看片段。
 *
 * 回看片段在 bin 从不可见变为可见且距离上次隐藏 >= REVIEW_GAP_MS 时开始。
 * 片段开始时冻结 episode 计数，避免同一次返回过程中刚读完的 bin
 * 立刻被当成重读。
 */
export function applyVisibility(
  state: MessageState,
  fractions: readonly number[],
  now: number,
  foreground: boolean,
): void {
  let anyVisible = false;
  for (let index = 0; index < BIN_COUNT; index += 1) {
    const fraction = foreground ? (fractions[index] ?? 0) : 0;
    const nowVisible = fraction > 0;
    if (nowVisible) anyVisible = true;
    const bin = state.bins[index];
    // 视口边界和 bin 边界可能差一个浮点误差，接近全可见就按 1 算
    const visibleFraction = fraction >= 0.999 ? 1 : fraction;
    if (visibleFraction > bin.maxVisibleFraction) {
      bin.maxVisibleFraction = visibleFraction;
    }

    if (!bin.visible && nowVisible) {
      if (
        bin.completed &&
        bin.lastVisibleAt !== null &&
        now - bin.lastVisibleAt >= REVIEW_GAP_MS
      ) {
        bin.reviewActive = true;
        bin.reviewDwellMs = 0;
        if (now - state.lastReviewActivityAt >= REVIEW_GAP_MS) {
          state.reviewEpisodeCounted = false;
        }
      }
    } else if (bin.visible && !nowVisible) {
      bin.reviewActive = false;
      bin.lastVisibleAt = now;
      if (bin.completed) state.lastReviewActivityAt = now;
    }
    // dt 覆盖的是上一个采样点到现在的区间；只有两端都可见才确定整段可见
    bin.accruable = bin.visible && nowVisible;
    bin.visible = nowVisible;
  }

  state.visible = anyVisible;
  if (anyVisible) state.lastVisibleAt = now;
}

/** 收集所有可见且仍需要阅读/回看注意力的 bin */
export function collectActiveBins(
  states: Iterable<MessageState>,
  fractionsByKey: ReadonlyMap<string, readonly number[]>,
): ActiveBin[] {
  const active: ActiveBin[] = [];
  for (const state of states) {
    const fractions = fractionsByKey.get(state.key);
    if (!fractions) continue;
    for (let index = 0; index < BIN_COUNT; index += 1) {
      const fraction = Math.min(1, Math.max(0, fractions[index] ?? 0));
      if (fraction <= 0) continue;
      const bin = state.bins[index];
      if (!bin.visible || !bin.accruable) continue;
      if (!bin.completed) {
        // 只露出一点的 bin 不能按全可见速度读完；上限随最大可见比例增长
        if (bin.dwellMs < bin.estimateMs * bin.maxVisibleFraction) {
          active.push({
            state,
            index,
            weight: bin.estimateMs * fraction,
            review: false,
          });
        }
      } else if (
        bin.reviewActive &&
        // 一次回看 episode 最多累计到读完这段内容所需的时长；
        // 不封顶会让停留时间无限抬高 activeReviewMs、压低回读速度
        bin.reviewDwellMs < Math.max(bin.estimateMs, REVIEW_MIN_MS)
      ) {
        active.push({
          state,
          index,
          weight: bin.estimateMs * fraction,
          review: true,
        });
      }
    }
  }
  return active;
}

/**
 * 一个 dt 时间片按权重分给所有活跃 bin。
 *
 * 关键点：所有 bin 共享同一个 dt，不是每个 bin 各自累加 dt。
 * 否则所有 bin 同时可见时阅读时间会被放大到 bin 数量倍。
 */
export function allocateActiveBins(
  active: readonly ActiveBin[],
  dtMs: number,
  now: number,
): void {
  if (active.length === 0 || dtMs <= 0) return;
  let totalWeight = 0;
  for (const item of active) totalWeight += item.weight;
  if (totalWeight <= 0) return;

  for (const item of active) {
    const share = (dtMs * item.weight) / totalWeight;
    const bin = item.state.bins[item.index];

    if (item.review) {
      if (!bin.completed) continue;
      bin.reviewDwellMs += share;
      item.state.lastReviewActivityAt = now;
      const coverage = Math.min(
        255,
        Math.floor((bin.reviewDwellMs / bin.estimateMs) * 255),
      );
      if (coverage > bin.reviewCoverage) {
        bin.reviewCoverage = coverage;
        item.state.dirty = true;
      }
      const threshold = Math.max(
        REVIEW_MIN_MS,
        bin.estimateMs * REVIEW_RATIO,
      );
      if (
        bin.reviewDwellMs >= threshold &&
        !item.state.reviewEpisodeCounted
      ) {
        item.state.reviewEpisodeCounted = true;
        item.state.revisits += 1;
        item.state.dirty = true;
      }
      continue;
    }

    if (bin.completed) continue;
    const readableMs = bin.estimateMs * bin.maxVisibleFraction;
    bin.dwellMs = Math.min(readableMs, bin.dwellMs + share);
    if (bin.maxVisibleFraction >= 1 && bin.dwellMs >= bin.estimateMs) {
      bin.completed = true;
      bin.dwellMs = bin.estimateMs;
    }
    item.state.dirty = true;
  }
}

export function snapshotCoverage(state: MessageState): number[] {
  return state.bins.map((bin) => {
    if (bin.completed) return 255;
    return Math.min(
      254,
      Math.max(0, Math.floor((bin.dwellMs / bin.estimateMs) * 255)),
    );
  });
}

export function snapshotReviewCoverage(state: MessageState): number[] {
  return state.bins.map((bin) => Math.max(0, Math.min(255, bin.reviewCoverage)));
}

/** 当前是否需要首次阅读/回看注意力；用于 activeReadMs / activeReviewMs */
export function attentionWeights(active: readonly ActiveBin[]): {
  read: number;
  review: number;
  total: number;
} {
  let read = 0;
  let review = 0;
  for (const item of active) {
    if (item.review) review += item.weight;
    else read += item.weight;
  }
  return { read, review, total: read + review };
}
