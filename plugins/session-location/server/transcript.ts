import type { PaseoAgent } from "@getpaseo/client";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Paseo 的 agent 快照 cwd 是创建/导入时的值，不随 provider 会话里的 cd 更新。
 * 会话位置必须从 provider 自己的记录里读：Claude Code 的 JSONL transcript
 * 每条主链记录都带顶层 cwd，最后一条就是会话当前目录。
 *
 * 这里只提取顶层 cwd 字段，不记录消息正文或其他字段。
 */
export interface SessionTranscript {
  /** 会话记录文件路径，文件追加时可以用来监听变化 */
  path: string;
  /** 读取会话当前 cwd；读不到时返回 null，由调用方回退到 agent 快照 */
  readCwd(): Promise<string | null>;
}

const PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const INITIAL_TAIL_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

const pathCache = new Map<string, string>();
const cwdCache = new Map<string, { size: number; cwd: string | null }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isClaudeProvider(provider: string | undefined): boolean {
  if (typeof provider !== "string") return false;
  const lower = provider.toLowerCase();
  return lower === "claude" || lower.startsWith("claude-");
}

/**
 * persistence.provider 存的是 Paseo profile ID（例如 claude-ds），
 * 底层 provider 类型在 persistence.metadata.provider 里（例如 claude）。
 */
function providerKindOf(agent: PaseoAgent): string | undefined {
  const persisted = agent.persistence?.metadata?.provider;
  if (typeof persisted === "string") return persisted;
  return agent.persistence?.provider ?? agent.runtimeInfo?.provider ?? agent.provider;
}

function parseCwd(line: string): string | null {
  if (!line.includes('"cwd"')) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // 文件尾部可能正在写入半行，跳过即可
    return null;
  }
  // 子代理侧链的 cwd 不代表主会话位置
  if (!isRecord(entry) || entry.isSidechain === true) return null;
  const cwd = entry.cwd;
  return typeof cwd === "string" && isAbsolutePath(cwd) ? cwd : null;
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

function findCwdInTail(text: string, atStart: boolean): string | null {
  const lines = text.split("\n");
  // 从文件中间开始读时，第一行可能是半行
  const firstIndex = atStart ? 0 : 1;
  for (let index = lines.length - 1; index >= firstIndex; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    const cwd = parseCwd(line);
    if (cwd) return cwd;
  }
  return null;
}

async function scanFromEnd(filePath: string): Promise<string | null> {
  let bytes = INITIAL_TAIL_BYTES;
  while (true) {
    const tail = await readTail(filePath, bytes);
    const cwd = findCwdInTail(tail.text, tail.atStart);
    if (cwd) return cwd;
    if (tail.atStart || bytes >= MAX_TAIL_BYTES) return null;
    bytes = Math.min(bytes * 2, MAX_TAIL_BYTES);
  }
}

async function readLastCwd(filePath: string): Promise<string | null> {
  const info = await stat(filePath);
  const cached = cwdCache.get(filePath);
  if (cached && cached.size === info.size) return cached.cwd;

  const cwd = await scanFromEnd(filePath);
  cwdCache.set(filePath, { size: info.size, cwd });
  return cwd;
}

/**
 * 找到 agent 对应的会话记录。目前只支持 Claude provider；
 * 其他 provider 返回 null，由调用方使用 agent 快照。
 */
export async function openSessionTranscript(agent: PaseoAgent): Promise<SessionTranscript | null> {
  if (!isClaudeProvider(providerKindOf(agent))) return null;

  const sessionId = agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId;
  // sessionId 来自 provider，不能让它通过路径分隔符跳出 projects 目录
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\")) return null;

  const path = await findTranscriptPath(sessionId);
  if (!path) return null;
  return { path, readCwd: () => readLastCwd(path) };
}
