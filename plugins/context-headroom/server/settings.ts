import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

const AUTO_COMPACT_WINDOW_KEY = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
const AUTOCOMPACT_PCT_KEY = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";

export interface ThresholdSetting {
  value: number;
  // 用于展示的设置文件路径，用户目录缩写为 ~
  file: string;
}

export interface ThresholdSettings {
  autoWindow: ThresholdSetting | null;
  pct: ThresholdSetting | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * 读取一个 settings 文件的 env。文件不存在返回 null；存在但不是合法 settings 则抛错，
 * 让上层把错误展示出来，而不是静默退回默认阈值。
 */
async function readSettingsEnv(path: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new Error(`读取 ${displayPath(path)} 失败: ${errorMessage(error)}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${displayPath(path)} 不是合法 JSON: ${errorMessage(error)}`, { cause: error });
  }

  const root = asRecord(parsed);
  if (!root) throw new Error(`${displayPath(path)} 顶层必须是 JSON 对象`);

  const env = root.env;
  if (env === undefined) return {};
  const record = asRecord(env);
  if (!record) throw new Error(`${displayPath(path)} 的 env 必须是 JSON 对象`);
  return record;
}

function parseNumberSetting(value: unknown, path: string, key: string): number | null {
  // 空值在 shell 的 ${VAR:-默认} 里等同未设置，这里保持同样的语义
  if (value === null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${displayPath(path)} 的 ${key} 必须是字符串或数字`);
  }
  const raw = typeof value === "string" ? value.trim() : value;
  const number = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${displayPath(path)} 的 ${key} 必须是大于 0 的数字，实际为 ${JSON.stringify(value)}`);
  }
  return number;
}

/**
 * 按 user -> project -> local 的顺序读取两个压缩阈值设置。
 * 只读取这两个键，不保留 settings 的其余内容。
 */
export async function readThresholdSettings(cwd: string): Promise<ThresholdSettings> {
  if (!isAbsolute(cwd)) {
    throw new Error(`agent cwd 不是绝对路径: ${cwd}`);
  }

  const files = [
    join(homedir(), ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];

  let autoWindow: ThresholdSetting | null = null;
  let pct: ThresholdSetting | null = null;

  for (const path of files) {
    const env = await readSettingsEnv(path);
    if (!env) continue;

    if (AUTO_COMPACT_WINDOW_KEY in env) {
      const value = parseNumberSetting(env[AUTO_COMPACT_WINDOW_KEY], path, AUTO_COMPACT_WINDOW_KEY);
      autoWindow = value === null ? null : { value, file: displayPath(path) };
    }
    if (AUTOCOMPACT_PCT_KEY in env) {
      const value = parseNumberSetting(env[AUTOCOMPACT_PCT_KEY], path, AUTOCOMPACT_PCT_KEY);
      pct = value === null ? null : { value, file: displayPath(path) };
    }
  }

  return { autoWindow, pct };
}
