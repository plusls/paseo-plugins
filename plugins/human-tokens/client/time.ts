/** 客户端本地日期，格式 YYYY-MM-DD；批次和 today 都按这个归属 */
export function localDay(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 客户端本地 5 分钟桶 0-287；批次内没有逐事件时间，整批归到构建批次时的桶 */
export function localSlot(date = new Date()): number {
  return Math.floor((date.getHours() * 60 + date.getMinutes()) / 5);
}
