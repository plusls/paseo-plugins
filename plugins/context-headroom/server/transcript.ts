import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code 会按 session 写 JSONL transcript，最后一条主链 assistant 的
 * input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * 就是 statusline 的 total_input_tokens 口径。
 *
 * Paseo 的 lastUsage.outputTokens 在 turn_completed 后是结果消息里的累计值，
 * 不是最后一条消息的输出，不能直接拿来做减法。因此这里只读取 usage 字段，
 * 不读取、不记录消息正文。
 */
export interface TranscriptUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const INITIAL_TAIL_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

const pathCache = new Map<string, string>();
const usageCache = new Map<string, { size: number; usage: TranscriptUsage | null }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseAssistantUsage(line: string): TranscriptUsage | null {
  if (!line.includes('"assistant"')) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // 文件尾部可能正在写入半行，跳过即可
    return null;
  }
  if (!isRecord(entry) || entry.type !== "assistant" || entry.isSidechain === true) return null;
  if (!isRecord(entry.message)) return null;
  const usage = entry.message.usage;
  if (!isRecord(usage)) return null;

  const inputTokens = nonNegativeNumber(usage.input_tokens);
  const outputTokens = nonNegativeNumber(usage.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const cacheCreationInputTokens = nonNegativeNumber(usage.cache_creation_input_tokens) ?? 0;
  const cacheReadInputTokens = nonNegativeNumber(usage.cache_read_input_tokens) ?? 0;
  if (inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens <= 0) {
    return null;
  }
  return { inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens };
}

async function findTranscriptPath(sessionId: string): Promise<string | null> {
  const cached = pathCache.get(sessionId);
  if (cached) return cached;

  let entries;
  try {
    entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(PROJECTS_DIR, entry.name, `${sessionId}.jsonl`);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    pathCache.set(sessionId, candidate);
    return candidate;
  }
  return null;
}

interface TailRead {
  text: string;
  atStart: boolean;
}

async function readTail(filePath: string, bytes: number): Promise<TailRead> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - bytes);
    const length = info.size - start;
    if (length <= 0) return { text: "", atStart: true };

    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return { text: buffer.toString("utf8", 0, offset), atStart: start === 0 };
  } finally {
    await handle.close();
  }
}

function findUsageInTail(text: string, atStart: boolean): TranscriptUsage | null {
  const lines = text.split("\n");
  // 从文件中间开始读时，第一行可能是半行
  const firstIndex = atStart ? 0 : 1;
  for (let index = lines.length - 1; index >= firstIndex; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    const usage = parseAssistantUsage(line);
    if (usage) return usage;
  }
  return null;
}

async function scanFromEnd(filePath: string): Promise<TranscriptUsage | null> {
  let bytes = INITIAL_TAIL_BYTES;
  while (true) {
    const tail = await readTail(filePath, bytes);
    const usage = findUsageInTail(tail.text, tail.atStart);
    if (usage) return usage;
    if (tail.atStart || bytes >= MAX_TAIL_BYTES) return null;
    bytes = Math.min(bytes * 2, MAX_TAIL_BYTES);
  }
}

/**
 * 读取指定 session 最后一条主链 assistant 的 usage。
 * transcript 只是精确对齐 statusline 的辅助来源；读不到时返回 null，
 * 由调用方退回 Paseo usage，不影响主流程。
 */
export async function readLastAssistantUsage(sessionId: string | undefined): Promise<TranscriptUsage | null> {
  // sessionId 来自 provider，不能让它通过路径分隔符跳出 projects 目录
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\")) return null;
  try {
    const filePath = await findTranscriptPath(sessionId);
    if (!filePath) return null;

    const info = await stat(filePath);
    const cached = usageCache.get(filePath);
    if (cached && cached.size === info.size) return cached.usage;

    const usage = await scanFromEnd(filePath);
    usageCache.set(filePath, { size: info.size, usage });
    return usage;
  } catch {
    return null;
  }
}
