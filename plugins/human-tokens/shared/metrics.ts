import { BIN_COUNT } from "./protocol";

/**
 * 覆盖数组的折算。per-bin 字符数按 chars / BIN_COUNT 均分，
 * 不要求 chars 能被 BIN_COUNT 整除：各段加起来仍是 chars。
 */

function clampByte(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, value ?? 0));
}

/** 首次阅读 token：每个 bin 按覆盖率折算 */
export function coverageReadTokens(
  coverage: ArrayLike<number>,
  chars: number,
): number {
  const perBin = chars / BIN_COUNT;
  let total = 0;
  for (let index = 0; index < BIN_COUNT; index += 1) {
    total += (perBin * clampByte(coverage[index])) / 255;
  }
  return total;
}

/** 已读完 token：只有 255 的 bin 计入 */
export function coverageCompletedTokens(
  coverage: ArrayLike<number>,
  chars: number,
): number {
  const perBin = chars / BIN_COUNT;
  let count = 0;
  for (let index = 0; index < BIN_COUNT; index += 1) {
    if (clampByte(coverage[index]) === 255) count += 1;
  }
  return perBin * count;
}

/** 重读 token：回看覆盖率单独折算，不能用 coverage 代替 */
export function reviewTokens(
  reviewCoverage: ArrayLike<number>,
  chars: number,
): number {
  const perBin = chars / BIN_COUNT;
  let total = 0;
  for (let index = 0; index < BIN_COUNT; index += 1) {
    total += (perBin * clampByte(reviewCoverage[index])) / 255;
  }
  return total;
}

/** 两个覆盖数组逐 bin 取最大；用于跨 session/设备合并 */
export function mergeCoverage(
  target: Uint8Array,
  source: ArrayLike<number>,
): void {
  for (let index = 0; index < BIN_COUNT; index += 1) {
    const next = clampByte(source[index]);
    if (next > target[index]) target[index] = next;
  }
}

export function emptyCoverage(): Uint8Array {
  return new Uint8Array(BIN_COUNT);
}
