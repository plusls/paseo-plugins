/**
 * 不需要加密强度，只要同一 daemon 下不撞。
 * RN 不保证 crypto.randomUUID 存在，所以用时间戳加随机串。
 */
export function randomId(prefix: string): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${time}_${random}`;
}
