import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  coverageCompletedTokens,
  coverageReadTokens,
  emptyCoverage,
  mergeCoverage,
  reviewTokens,
} from "../shared/metrics";
import {
  BIN_COUNT,
  REVIEW_INFER_COVERAGE,
  SLOTS_PER_DAY,
  type Daily,
  type IngestInput,
  type SlotStats,
  type StatsOutput,
  type Totals,
} from "../shared/protocol";

/**
 * daemon 侧的 SQLite 存储。
 *
 * 设计要点：
 * - message_read 按 (message_id, version, session_id) 分行，保留每个客户端的累计覆盖
 * - 跨 session/设备合并时 coverage / review_coverage 逐 bin 取最大，事件计数按增量求和
 * - ingest 在一个事务里写消息、日统计和 batch id；重复 batch id 直接 ACK，不重复计数
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type HumanTokensDb = DatabaseSync;

export function openDatabase(): HumanTokensDb {
  const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const directory = join(paseoHome, "plugin-data", "human-tokens");
  mkdirSync(directory, { recursive: true });

  const db = new DatabaseSync(join(directory, "stats.sqlite"), {
    timeout: 5_000,
  });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS message_read (
      message_id TEXT NOT NULL,
      version TEXT NOT NULL,
      chars INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      agent_id TEXT,
      coverage BLOB NOT NULL,
      review_coverage BLOB NOT NULL,
      local_revisits INTEGER NOT NULL DEFAULT 0,
      inferred_revisit INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (message_id, version, session_id)
    );
    CREATE INDEX IF NOT EXISTS message_read_version
      ON message_read(message_id, version);

    CREATE TABLE IF NOT EXISTS day_stats (
      day TEXT NOT NULL,
      device_id TEXT NOT NULL,
      read_tokens REAL NOT NULL DEFAULT 0,
      miss_tokens REAL NOT NULL DEFAULT 0,
      typed_chars INTEGER NOT NULL DEFAULT 0,
      revisits INTEGER NOT NULL DEFAULT 0,
      active_read_ms INTEGER NOT NULL DEFAULT 0,
      active_review_ms INTEGER NOT NULL DEFAULT 0,
      active_typing_ms INTEGER NOT NULL DEFAULT 0,
      switches INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, device_id)
    );

    CREATE TABLE IF NOT EXISTS slot_stats (
      day TEXT NOT NULL,
      slot INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      read_tokens REAL NOT NULL DEFAULT 0,
      miss_tokens REAL NOT NULL DEFAULT 0,
      typed_chars INTEGER NOT NULL DEFAULT 0,
      active_read_ms INTEGER NOT NULL DEFAULT 0,
      active_review_ms INTEGER NOT NULL DEFAULT 0,
      active_typing_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, slot, device_id)
    );

    CREATE TABLE IF NOT EXISTS ingest_batch (
      batch_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  // 批次去重只需要覆盖客户端重试窗口；保留 30 天足够
  db.prepare("DELETE FROM ingest_batch WHERE applied_at < ?").run(
    new Date(Date.now() - 30 * DAY_MS).toISOString(),
  );

  // 5 分钟桶只用于当天曲线，保留 90 天；更早的删掉，日汇总仍由 day_stats 保存
  db.prepare("DELETE FROM slot_stats WHERE day < ?").run(
    new Date(Date.now() - 90 * DAY_MS).toISOString().slice(0, 10),
  );

  return db;
}

function toCoverage(value: unknown): Uint8Array {
  const coverage = new Uint8Array(BIN_COUNT);
  if (value instanceof Uint8Array) {
    const length = Math.min(BIN_COUNT, value.length);
    for (let index = 0; index < length; index += 1) {
      coverage[index] = value[index];
    }
  }
  return coverage;
}

function toInt(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function toNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function ingest(
  db: HumanTokensDb,
  input: IngestInput,
): { accepted: true } {
  const nowIso = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const alreadyApplied = db
      .prepare("SELECT 1 AS present FROM ingest_batch WHERE batch_id = ?")
      .get(input.batchId);
    if (alreadyApplied) {
      db.exec("COMMIT");
      return { accepted: true };
    }

    const selectSession = db.prepare(`
      SELECT coverage, review_coverage, local_revisits, inferred_revisit
      FROM message_read
      WHERE message_id = ? AND version = ? AND session_id = ?
    `);
    const selectVersionRows = db.prepare(`
      SELECT coverage, review_coverage
      FROM message_read
      WHERE message_id = ? AND version = ?
    `);
    const upsertMessage = db.prepare(`
      INSERT INTO message_read (
        message_id, version, chars, session_id, device_id, agent_id,
        coverage, review_coverage, local_revisits, inferred_revisit, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id, version, session_id) DO UPDATE SET
        device_id = excluded.device_id,
        agent_id = excluded.agent_id,
        coverage = excluded.coverage,
        review_coverage = excluded.review_coverage,
        local_revisits = excluded.local_revisits,
        inferred_revisit = excluded.inferred_revisit,
        updated_at = excluded.updated_at
    `);

    let dayReadTokens = 0;
    let dayMissTokens = 0;
    let dayRevisits = 0;

    for (const message of input.messages) {
      const sessionRow = selectSession.get(
        message.messageId,
        message.version,
        input.sessionId,
      );
      const oldCoverage = toCoverage(sessionRow?.coverage);
      const oldReview = toCoverage(sessionRow?.review_coverage);
      const oldLocalRevisits = toInt(sessionRow?.local_revisits);
      let inferredRevisit = toInt(sessionRow?.inferred_revisit) > 0;

      const versionRows = selectVersionRows.all(
        message.messageId,
        message.version,
      );
      const mergedBefore = emptyCoverage();
      const reviewBefore = emptyCoverage();
      for (const row of versionRows) {
        mergeCoverage(mergedBefore, toCoverage(row.coverage));
        mergeCoverage(reviewBefore, toCoverage(row.review_coverage));
      }

      const storedCoverage = new Uint8Array(BIN_COUNT);
      const storedReview = new Uint8Array(BIN_COUNT);
      for (let index = 0; index < BIN_COUNT; index += 1) {
        storedCoverage[index] = Math.max(
          oldCoverage[index],
          message.coverage[index],
        );
        storedReview[index] = Math.max(
          oldReview[index],
          message.reviewCoverage[index],
        );
      }

      // 新会话第一次读到别的会话已完成的内容：把首次阅读覆盖折算成回看覆盖。
      // 长消息可能跨多个批次读完，所以每个新 bin 都要推断覆盖；
      // revisit 每个 message/session 最多记一次，避免重复计数。
      let inferredCoverage = false;
      for (let index = 0; index < BIN_COUNT; index += 1) {
        if (
          mergedBefore[index] === 255 &&
          oldCoverage[index] < 255 &&
          storedReview[index] < message.coverage[index] &&
          message.coverage[index] >= REVIEW_INFER_COVERAGE
        ) {
          storedReview[index] = message.coverage[index];
          inferredCoverage = true;
        }
      }
      let inferredRevisitNow = false;
      if (inferredCoverage && !inferredRevisit) {
        inferredRevisit = true;
        inferredRevisitNow = true;
      }

      const mergedAfter = new Uint8Array(mergedBefore);
      const reviewAfter = new Uint8Array(reviewBefore);
      for (let index = 0; index < BIN_COUNT; index += 1) {
        mergedAfter[index] = Math.max(
          mergedAfter[index],
          storedCoverage[index],
        );
        reviewAfter[index] = Math.max(reviewAfter[index], storedReview[index]);
      }

      const beforeRead = coverageReadTokens(mergedBefore, message.chars);
      const afterRead = coverageReadTokens(mergedAfter, message.chars);
      const beforeMiss = reviewTokens(reviewBefore, message.chars);
      const afterMiss = reviewTokens(reviewAfter, message.chars);
      dayReadTokens += Math.max(0, afterRead - beforeRead);
      dayMissTokens += Math.max(0, afterMiss - beforeMiss);
      dayRevisits +=
        Math.max(0, message.revisits - oldLocalRevisits) +
        (inferredRevisitNow ? 1 : 0);

      upsertMessage.run(
        message.messageId,
        message.version,
        message.chars,
        input.sessionId,
        input.deviceId,
        message.agentId,
        storedCoverage,
        storedReview,
        Math.max(oldLocalRevisits, message.revisits),
        inferredRevisit ? 1 : 0,
        nowIso,
      );
    }

    db.prepare(`
      INSERT INTO day_stats (
        day, device_id, read_tokens, miss_tokens, typed_chars, revisits,
        active_read_ms, active_review_ms, active_typing_ms, switches
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, device_id) DO UPDATE SET
        read_tokens = day_stats.read_tokens + excluded.read_tokens,
        miss_tokens = day_stats.miss_tokens + excluded.miss_tokens,
        typed_chars = day_stats.typed_chars + excluded.typed_chars,
        revisits = day_stats.revisits + excluded.revisits,
        active_read_ms = day_stats.active_read_ms + excluded.active_read_ms,
        active_review_ms = day_stats.active_review_ms + excluded.active_review_ms,
        active_typing_ms = day_stats.active_typing_ms + excluded.active_typing_ms,
        switches = day_stats.switches + excluded.switches
    `).run(
      input.day,
      input.deviceId,
      dayReadTokens,
      dayMissTokens,
      input.typedChars,
      dayRevisits,
      input.activeReadMs,
      input.activeReviewMs,
      input.activeTypingMs,
      input.switches,
    );

    const slot = input.slot;
    if (slot !== undefined) {
      db.prepare(`
        INSERT INTO slot_stats (
          day, slot, device_id, read_tokens, miss_tokens, typed_chars,
          active_read_ms, active_review_ms, active_typing_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, slot, device_id) DO UPDATE SET
          read_tokens = slot_stats.read_tokens + excluded.read_tokens,
          miss_tokens = slot_stats.miss_tokens + excluded.miss_tokens,
          typed_chars = slot_stats.typed_chars + excluded.typed_chars,
          active_read_ms = slot_stats.active_read_ms + excluded.active_read_ms,
          active_review_ms = slot_stats.active_review_ms + excluded.active_review_ms,
          active_typing_ms = slot_stats.active_typing_ms + excluded.active_typing_ms
      `).run(
        input.day,
        slot,
        input.deviceId,
        dayReadTokens,
        dayMissTokens,
        input.typedChars,
        input.activeReadMs,
        input.activeReviewMs,
        input.activeTypingMs,
      );
    }

    db.prepare(
      "INSERT INTO ingest_batch (batch_id, applied_at) VALUES (?, ?)",
    ).run(input.batchId, nowIso);

    db.exec("COMMIT");
    return { accepted: true };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // BEGIN 本身失败时没有活动事务；保留原始错误
    }
    throw error;
  }
}

function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, date + delta));
  const nextYear = value.getUTCFullYear();
  const nextMonth = String(value.getUTCMonth() + 1).padStart(2, "0");
  const nextDate = String(value.getUTCDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDate}`;
}

export function queryStats(
  db: HumanTokensDb,
  input: { today: string; days: 7 | 30 },
): StatsOutput {
  const rows = db
    .prepare(
      "SELECT message_id, version, chars, coverage, review_coverage FROM message_read",
    )
    .all();

  const merged = new Map<
    string,
    { chars: number; coverage: Uint8Array; review: Uint8Array }
  >();
  for (const row of rows) {
    const messageId = String(row.message_id);
    const version = String(row.version);
    const chars = toInt(row.chars);
    const key = `${messageId}\u0000${version}`;
    const coverage = toCoverage(row.coverage);
    const review = toCoverage(row.review_coverage);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { chars, coverage, review });
    } else {
      current.chars = Math.max(current.chars, chars);
      mergeCoverage(current.coverage, coverage);
      mergeCoverage(current.review, review);
    }
  }

  let readTokens = 0;
  let completedTokens = 0;
  let missTokens = 0;
  let producedTokens = 0;
  for (const message of merged.values()) {
    readTokens += coverageReadTokens(message.coverage, message.chars);
    completedTokens += coverageCompletedTokens(
      message.coverage,
      message.chars,
    );
    missTokens += reviewTokens(message.review, message.chars);
    producedTokens += message.chars;
  }

  const activity = db
    .prepare(`
      SELECT
        COALESCE(SUM(typed_chars), 0) AS typed_chars,
        COALESCE(SUM(revisits), 0) AS revisits,
        COALESCE(SUM(active_read_ms), 0) AS active_read_ms,
        COALESCE(SUM(active_review_ms), 0) AS active_review_ms,
        COALESCE(SUM(active_typing_ms), 0) AS active_typing_ms,
        COALESCE(SUM(switches), 0) AS switches
      FROM day_stats
    `)
    .get();

  const lifetime: Totals = {
    readTokens,
    completedTokens,
    missTokens,
    producedTokens,
    typedChars: toInt(activity?.typed_chars),
    revisits: toInt(activity?.revisits),
    switches: toInt(activity?.switches),
    activeReadMs: toInt(activity?.active_read_ms),
    activeReviewMs: toInt(activity?.active_review_ms),
    activeTypingMs: toInt(activity?.active_typing_ms),
    messages: merged.size,
  };

  const todayRow = db
    .prepare(`
      SELECT
        COALESCE(SUM(read_tokens), 0) AS read_tokens,
        COALESCE(SUM(miss_tokens), 0) AS miss_tokens,
        COALESCE(SUM(typed_chars), 0) AS typed_chars,
        COALESCE(SUM(revisits), 0) AS revisits,
        COALESCE(SUM(active_read_ms), 0) AS active_read_ms,
        COALESCE(SUM(active_review_ms), 0) AS active_review_ms,
        COALESCE(SUM(active_typing_ms), 0) AS active_typing_ms,
        COALESCE(SUM(switches), 0) AS switches
      FROM day_stats
      WHERE day = ?
    `)
    .get(input.today);

  const today: Totals = {
    readTokens: toNumber(todayRow?.read_tokens),
    completedTokens: 0,
    missTokens: toNumber(todayRow?.miss_tokens),
    producedTokens: 0,
    typedChars: toInt(todayRow?.typed_chars),
    revisits: toInt(todayRow?.revisits),
    switches: toInt(todayRow?.switches),
    activeReadMs: toInt(todayRow?.active_read_ms),
    activeReviewMs: toInt(todayRow?.active_review_ms),
    activeTypingMs: toInt(todayRow?.active_typing_ms),
    messages: 0,
  };

  const firstDay = addDays(input.today, -(input.days - 1));
  const dailyRows = db
    .prepare(`
      SELECT
        day,
        SUM(read_tokens) AS read_tokens,
        SUM(miss_tokens) AS miss_tokens,
        SUM(typed_chars) AS typed_chars,
        SUM(revisits) AS revisits,
        SUM(switches) AS switches
      FROM day_stats
      WHERE day >= ? AND day <= ?
      GROUP BY day
    `)
    .all(firstDay, input.today);

  const dailyByDay = new Map<string, Daily>();
  for (const row of dailyRows) {
    dailyByDay.set(String(row.day), {
      day: String(row.day),
      readTokens: toNumber(row.read_tokens),
      missTokens: toNumber(row.miss_tokens),
      typedChars: toInt(row.typed_chars),
      revisits: toInt(row.revisits),
      switches: toInt(row.switches),
    });
  }

  const daily: Daily[] = [];
  for (let offset = 0; offset < input.days; offset += 1) {
    const day = addDays(firstDay, offset);
    daily.push(
      dailyByDay.get(day) ?? {
        day,
        readTokens: 0,
        missTokens: 0,
        typedChars: 0,
        revisits: 0,
        switches: 0,
      },
    );
  }

  const slotRows = db
    .prepare(`
      SELECT
        slot,
        SUM(read_tokens) AS read_tokens,
        SUM(miss_tokens) AS miss_tokens,
        SUM(typed_chars) AS typed_chars,
        SUM(active_read_ms) AS active_read_ms,
        SUM(active_review_ms) AS active_review_ms,
        SUM(active_typing_ms) AS active_typing_ms
      FROM slot_stats
      WHERE day = ?
      GROUP BY slot
    `)
    .all(input.today);

  const slotsBySlot = new Map<number, SlotStats>();
  for (const row of slotRows) {
    const slot = toInt(row.slot);
    slotsBySlot.set(slot, {
      slot,
      readTokens: toNumber(row.read_tokens),
      missTokens: toNumber(row.miss_tokens),
      typedChars: toInt(row.typed_chars),
      activeReadMs: toInt(row.active_read_ms),
      activeReviewMs: toInt(row.active_review_ms),
      activeTypingMs: toInt(row.active_typing_ms),
    });
  }

  const slots: SlotStats[] = [];
  for (let slot = 0; slot < SLOTS_PER_DAY; slot += 1) {
    slots.push(
      slotsBySlot.get(slot) ?? {
        slot,
        readTokens: 0,
        missTokens: 0,
        typedChars: 0,
        activeReadMs: 0,
        activeReviewMs: 0,
        activeTypingMs: 0,
      },
    );
  }

  return { lifetime, today, daily, slots };
}
