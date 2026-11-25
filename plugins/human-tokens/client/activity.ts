import { SAMPLE_MS } from "../shared/protocol";

/**
 * 客户端累计增量。
 * 取出后挂在待上传批次上；上传失败时同一批继续重试，不会丢。
 */
export interface Activity {
  activeReadMs: number;
  activeReviewMs: number;
  typedChars: number;
  activeTypingMs: number;
  switches: number;
}

function empty(): Activity {
  return {
    activeReadMs: 0,
    activeReviewMs: 0,
    typedChars: 0,
    activeTypingMs: 0,
    switches: 0,
  };
}

let current = empty();

function addMs(target: "activeReadMs" | "activeReviewMs", ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  current[target] += Math.max(0, Math.round(ms));
}

export function recordActiveRead(ms: number): void {
  addMs("activeReadMs", ms);
}

export function recordActiveReview(ms: number): void {
  addMs("activeReviewMs", ms);
}

/** 每个出现正输入增量的采样计为 SAMPLE_MS 活跃打字时间 */
export function recordTyped(chars: number, ms = SAMPLE_MS): void {
  if (!Number.isFinite(chars) || chars <= 0) return;
  current.typedChars += Math.floor(chars);
  current.activeTypingMs += Math.max(0, Math.round(ms));
}

export function recordSwitch(): void {
  current.switches += 1;
}

export function peekActivity(): Activity {
  return { ...current };
}

export function takeActivity(): Activity {
  const taken = current;
  current = empty();
  return taken;
}

export function isEmptyActivity(activity: Activity): boolean {
  return (
    activity.activeReadMs === 0 &&
    activity.activeReviewMs === 0 &&
    activity.typedChars === 0 &&
    activity.activeTypingMs === 0 &&
    activity.switches === 0
  );
}

// web 的真实 paste 事件会在输入框更新前触发；记录长度，等采样时从正增量里扣掉
const PASTE_TTL_MS = 2_000;
let pendingPasteChars = 0;
let pendingPasteAt = 0;

export function notePaste(chars: number): void {
  if (!Number.isFinite(chars) || chars <= 0) return;
  pendingPasteChars += Math.floor(chars);
  pendingPasteAt = Date.now();
}

/** 返回本次增量里应视为粘贴的码点数 */
export function consumePaste(maxChars: number): number {
  if (Date.now() - pendingPasteAt > PASTE_TTL_MS) {
    clearPaste();
    return 0;
  }
  const used = Math.min(pendingPasteChars, Math.max(0, maxChars));
  // 一次采样后不让余额跨 tick：替换选中文本时净增量小于粘贴长度，
  // 剩下的额度如果留到下一次，会吞掉真正输入的字
  clearPaste();
  return used;
}

export function clearPaste(): void {
  pendingPasteChars = 0;
  pendingPasteAt = 0;
}
