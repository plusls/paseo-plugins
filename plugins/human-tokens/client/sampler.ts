import {
  BIN_COUNT,
  FLUSH_MS,
  MAX_MESSAGES_PER_BATCH,
  SAMPLE_MS,
  STATE_TTL_MS,
  type IngestInput,
} from "../shared/protocol";
import {
  isEmptyActivity,
  peekActivity,
  recordActiveRead,
  recordActiveReview,
  recordSwitch,
  takeActivity,
} from "./activity";
import { randomId } from "./ids";
import {
  allocateActiveBins,
  applyVisibility,
  attentionWeights,
  binFractions,
  charCount,
  collectActiveBins,
  createMessageState,
  snapshotCoverage,
  restoreMessageState,
  snapshotReviewCoverage,
  textVersion,
  visibleHeight,
  ZERO_FRACTIONS,
  type MessageState,
  type SavedCoverage,
  type ScanRow,
} from "./model";
import { localDay } from "./time";

/**
 * 采样器是插件级单例：多个 composer item 可能同时挂载，
 * 但时间线只有一份，不能每个 item 各测一遍。
 */

export interface SamplerDeps {
  deviceId: string;
  scan: () => readonly ScanRow[];
  isForeground: () => boolean;
}

interface PendingEntry {
  state: MessageState;
  coverage: number[];
  reviewCoverage: number[];
  revisits: number;
}

interface PendingBatch {
  input: IngestInput;
  entries: PendingEntry[];
}

interface RunningSampler {
  stop(): Promise<void>;
}

const SESSION_ID = randomId("s");
const roots = new Set<() => unknown>();
let ingestSender: ((input: IngestInput) => Promise<unknown>) | null = null;
let running: RunningSampler | null = null;

export function setIngestSender(
  sender: ((input: IngestInput) => Promise<unknown>) | null,
): void {
  ingestSender = sender;
}

/**
 * composer item 的隐藏 View 只用来拿 native fiber 根。
 * 多个 driver 都挂载时，用第一个还能拿到实例的根即可。
 */
export function addSamplerRoot(getRoot: () => unknown): () => void {
  roots.add(getRoot);
  return () => {
    roots.delete(getRoot);
  };
}

export function currentSamplerRoot(): unknown {
  for (const getRoot of roots) {
    try {
      const root = getRoot();
      if (root) return root;
    } catch {
      // View 正在卸载时 ref 可能抛错，换下一个
    }
  }
  return null;
}

export function startSampler(deps: SamplerDeps): void {
  if (running) return;
  const sender = ingestSender;
  if (!sender) {
    console.error("[human-tokens] ingest sender 未设置，采样未启动");
    return;
  }
  // 捕获本次 session 的 sender：停用 cleanup 里还要用，不能依赖模块变量
  running = runSampler(deps, sender);
}

export function stopSampler(): Promise<void> | void {
  const current = running;
  running = null;
  return current?.stop();
}

function sameArray(
  left: readonly number[],
  right: readonly number[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const HISTORY_LIMIT = 2_000;

function runSampler(
  deps: SamplerDeps,
  sender: (input: IngestInput) => Promise<unknown>,
): RunningSampler {
  const messages = new Map<string, MessageState>();
  // 文本版本变化时旧状态被移出 messages，但还没上传的覆盖仍要送出去。
  // 按 messageId + version 暂存，ACK 后删除；同一版本再次出现时由恢复逻辑接管。
  const detached = new Map<string, MessageState>();
  const detachedKey = (state: MessageState): string =>
    `${state.messageId}\u0000${state.version}`;
  // 超过 TTL 没出现被清理的 state，保留一份覆盖快照；再次出现时恢复成回看，
  // 否则同一 app 会话隔天回看会被当成首次阅读。按插入顺序淘汰最旧条目。
  const history = new Map<string, SavedCoverage>();
  let lastTickAt = Date.now();
  let lastAgentId: string | null = null;
  let pending: PendingBatch | null = null;
  let flushPromise: Promise<void> | null = null;
  let stopped = false;
  let scanErrorLogged = false;
  let lastFlushErrorAt = 0;

  const remember = (state: MessageState): void => {
    if (
      state.revisits === 0 &&
      !state.bins.some(
        (bin) => bin.dwellMs > 0 || bin.completed || bin.reviewCoverage > 0,
      )
    ) {
      return;
    }
    history.delete(state.key);
    history.set(state.key, {
      version: state.version,
      chars: state.chars,
      coverage: snapshotCoverage(state),
      reviewCoverage: snapshotReviewCoverage(state),
      revisits: state.revisits,
    });
    while (history.size > HISTORY_LIMIT) {
      const oldest = history.keys().next().value;
      if (oldest === undefined) break;
      history.delete(oldest);
    }
  };

  const logFlushError = (error: unknown): void => {
    const now = Date.now();
    if (now - lastFlushErrorAt < 60_000) return;
    lastFlushErrorAt = now;
    console.error("[human-tokens] 上传失败，保留本批次稍后重试", error);
  };

  const tick = (): void => {
    if (stopped) return;
    const now = Date.now();
    // 后台节流或 JS 卡顿后不要一次补记几十秒的「阅读」
    const dt = Math.min(Math.max(0, now - lastTickAt), SAMPLE_MS * 2);
    lastTickAt = now;

    let foreground = false;
    try {
      foreground = deps.isForeground();
    } catch {
      foreground = false;
    }

    if (!foreground) {
      for (const state of messages.values()) {
        applyVisibility(state, ZERO_FRACTIONS, now, false);
      }
      return;
    }

    let rows: readonly ScanRow[];
    try {
      rows = deps.scan();
    } catch (error) {
      if (!scanErrorLogged) {
        scanErrorLogged = true;
        console.error("[human-tokens] 读取时间线位置失败", error);
      }
      rows = [];
    }

    if (rows.length === 0) {
      for (const state of messages.values()) {
        applyVisibility(state, ZERO_FRACTIONS, now, true);
      }
      return;
    }

    const fractionsByKey = new Map<string, number[]>();
    const visibleAgentHeight = new Map<string, number>();

    for (const row of rows) {
      if (!row.visible) continue;
      let state = messages.get(row.key);
      // 文本没变时复用上次的码点数和 hash，避免每 500ms 扫描全文
      const known = state && state.textRef === row.text ? state : null;
      const chars = known ? known.chars : charCount(row.text);
      if (chars === 0) continue;
      const version = known ? known.version : textVersion(row.text);

      if (state && (state.version !== version || state.chars !== chars)) {
        // 同一 item 的文本版本变了：旧覆盖不再对应新文本，
        // daemon 侧按 (messageId, version) 区分版本，这里重新开始。
        // 还没上传的旧版本先留着，等下一次 flush 送出去。
        remember(state);
        messages.delete(row.key);
        if (state.dirty) detached.set(detachedKey(state), state);
        state = undefined;
      }
      if (!state) {
        state = createMessageState(row, chars, version, now);
        const saved = history.get(row.key);
        if (saved && saved.version === version && saved.chars === chars) {
          restoreMessageState(state, saved, now);
          history.delete(row.key);
          // 同一版本重新出现，后建的状态会带着同样的覆盖上传
          detached.delete(detachedKey(state));
        }
        messages.set(row.key, state);
      } else if (row.agentId && state.agentId !== row.agentId) {
        state.agentId = row.agentId;
        state.dirty = true;
      }

      const fractions = binFractions(row);
      const existing = fractionsByKey.get(row.key);
      if (existing) {
        for (let index = 0; index < BIN_COUNT; index += 1) {
          existing[index] = Math.max(existing[index], fractions[index]);
        }
      } else {
        fractionsByKey.set(row.key, fractions);
      }

      const height = visibleHeight(row);
      if (height > 0 && row.agentId) {
        visibleAgentHeight.set(
          row.agentId,
          (visibleAgentHeight.get(row.agentId) ?? 0) + height,
        );
      }
    }

    // 本轮没出现在 scan 结果里的消息视为不可见
    for (const state of messages.values()) {
      applyVisibility(
        state,
        fractionsByKey.get(state.key) ?? ZERO_FRACTIONS,
        now,
        true,
      );
    }

    const active = collectActiveBins(messages.values(), fractionsByKey);
    if (active.length > 0 && dt > 0) {
      const weights = attentionWeights(active);
      if (weights.total > 0) {
        if (weights.read > 0) {
          recordActiveRead((dt * weights.read) / weights.total);
        }
        if (weights.review > 0) {
          recordActiveReview((dt * weights.review) / weights.total);
        }
      }
      allocateActiveBins(active, dt, now);
    }

    // 取可见面积最大的 agent 作为当前上下文；null 不重置 lastAgentId，
    // 这样短暂滚动空白不会制造假切换，A -> 终端 -> B 仍会记一次切换。
    let topAgent: string | null = null;
    let topHeight = 0;
    for (const [agentId, height] of visibleAgentHeight) {
      if (height > topHeight) {
        topAgent = agentId;
        topHeight = height;
      }
    }
    if (topAgent) {
      if (lastAgentId && topAgent !== lastAgentId) recordSwitch();
      lastAgentId = topAgent;
    }
  };

  const buildBatch = (): PendingBatch | null => {
    const dirty = [...messages.values(), ...detached.values()].filter(
      (state) => state.dirty,
    );
    const activity = peekActivity();
    if (dirty.length === 0 && isEmptyActivity(activity)) return null;

    const chosen = dirty.slice(0, MAX_MESSAGES_PER_BATCH);
    const entries: PendingEntry[] = chosen.map((state) => ({
      state,
      coverage: snapshotCoverage(state),
      reviewCoverage: snapshotReviewCoverage(state),
      revisits: state.revisits,
    }));

    // 同步取出增量；上传期间新产生的数据进新的累加器，不会被这一批吞掉
    const taken = takeActivity();
    const input: IngestInput = {
      batchId: randomId("b"),
      sessionId: SESSION_ID,
      deviceId: deps.deviceId,
      day: localDay(),
      messages: entries.map((entry) => ({
        messageId: entry.state.messageId,
        version: entry.state.version,
        agentId: entry.state.agentId,
        chars: entry.state.chars,
        coverage: entry.coverage,
        reviewCoverage: entry.reviewCoverage,
        revisits: entry.revisits,
      })),
      activeReadMs: taken.activeReadMs,
      activeReviewMs: taken.activeReviewMs,
      typedChars: taken.typedChars,
      activeTypingMs: taken.activeTypingMs,
      switches: taken.switches,
    };

    return { input, entries };
  };

  const deliver = async (batch: PendingBatch): Promise<void> => {
    try {
      await sender(batch.input);
    } catch (error) {
      // 同一个 batchId 重试；daemon 事务提交后才 ACK，重复投递会被去重
      logFlushError(error);
      return;
    }

    pending = null;
    for (const entry of batch.entries) {
      const state = entry.state;
      // 上传等待期间可能又有新覆盖，只有完全一致才清 dirty
      if (
        sameArray(snapshotCoverage(state), entry.coverage) &&
        sameArray(snapshotReviewCoverage(state), entry.reviewCoverage) &&
        state.revisits === entry.revisits
      ) {
        state.dirty = false;
        // 已经不在 messages 里的旧版本，上传成功后从暂存区删除
        if (messages.get(state.key) !== state) {
          detached.delete(detachedKey(state));
        }
      }
    }
  };

  const sweepStaleStates = (): void => {
    const now = Date.now();
    for (const [key, state] of messages) {
      if (!state.dirty && now - state.lastVisibleAt > STATE_TTL_MS) {
        remember(state);
        messages.delete(key);
      }
    }
  };

  const flush = (): Promise<void> => {
    if (flushPromise) return flushPromise;
    // 空批次时 async 函数会同步跑完 finally；先让出一拍，保证 flushPromise
    // 已经指向本次任务，finally 才能把它清掉，否则之后永远不会再 flush。
    const current = Promise.resolve().then(async () => {
      try {
        if (!pending) pending = buildBatch();
        if (pending) await deliver(pending);
      } finally {
        // 没有待上传批次时也要清理过期状态，否则停在静态页面上会一直攒内存
        sweepStaleStates();
        if (flushPromise === current) flushPromise = null;
      }
    });
    flushPromise = current;
    return current;
  };

  const sampleTimer = setInterval(tick, SAMPLE_MS);
  const flushTimer = setInterval(() => {
    void flush();
  }, FLUSH_MS);

  // 先跑一次，建立当前可见状态；第一个 dt 为 0
  tick();
  lastTickAt = Date.now();

  const hasUnsent = (): boolean =>
    pending !== null ||
    [...messages.values(), ...detached.values()].some((state) => state.dirty) ||
    !isEmptyActivity(peekActivity());

  return {
    async stop() {
      stopped = true;
      clearInterval(sampleTimer);
      clearInterval(flushTimer);
      // 插件停用前尽量把积压批次送完；上传失败时保留 pending，不在这里硬重试
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await flush();
        if (!hasUnsent() || pending) break;
      }
    },
  };
}
