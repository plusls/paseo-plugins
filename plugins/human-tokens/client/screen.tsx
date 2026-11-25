import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pressable, Text, View } from "react-native";
import { SLOTS_PER_DAY, type Daily, type SlotStats } from "../shared/protocol";
import {
  formatDayLabel,
  formatDuration,
  formatPercent,
  formatRate,
  formatTokens,
} from "./format";
import { localSlot } from "./time";
import { useStats } from "./use-stats";
import { addKeySelect, addWheelZoom } from "./web";

interface DailySeries {
  label: string;
  color: string;
  value: (day: Daily) => number;
}

interface ChartPoint {
  key: string;
  label: string;
  /** 无障碍标签和点选详情用的完整名称 */
  title: string;
}

interface RenderSeries {
  label: string;
  color: string;
  /** 按 points 下标取值；不同图表的量纲不同，每张图独立缩放 */
  value: (index: number) => number;
  format: (value: number) => string;
}

interface SmoothedSeries {
  label: string;
  color: string;
  /** 已按 5 分钟桶平滑的值，长度与 slots 一致 */
  values: readonly number[];
}

function shouldShowDay(index: number, count: number): boolean {
  if (count <= 7) return true;
  return index % 5 === 0 || index === count - 1;
}

const SLOTS_PER_HOUR = SLOTS_PER_DAY / 24;
/** 平滑窗口，3 个 5 分钟桶 = 15 分钟 */
const SMOOTH_SLOTS = 3;
/** 默认显示的时间范围，36 个桶 = 3 小时 */
const DEFAULT_SPAN = 36;
/** 缩放挡位，单位是 5 分钟桶 */
const ZOOM_SPANS: readonly number[] = [
  12,
  24,
  36,
  48,
  72,
  96,
  144,
  SLOTS_PER_DAY,
];

/** 鼠标移动节流，避免 5 分钟图在快速移动时频繁重渲染 */
const HOVER_THROTTLE_MS = 80;

interface SlotViewport {
  /** 可见范围的起始桶下标 */
  start: number;
  /** 可见桶数 */
  span: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 以 center 为中心取 span 个桶，贴边时向内收 */
function centeredViewport(center: number, span: number): SlotViewport {
  return {
    start: clamp(Math.round(center - span / 2), 0, SLOTS_PER_DAY - span),
    span,
  };
}

function formatSpan(span: number): string {
  return `${span / SLOTS_PER_HOUR} 小时`;
}

/** 可见范围越窄，刻度越密 */
function tickStep(span: number): number {
  if (span <= 12) return 3;
  if (span <= 24) return 6;
  if (span <= 72) return 12;
  if (span <= 144) return 24;
  return 48;
}

/**
 * 以每个 5 分钟桶为终点，过去 15 分钟的滑动平均。
 *
 * 已完成的桶取当前桶和之前两个桶；当前桶只过去了一部分，按已过去的时间比例
 * 给当前桶和窗口最左端的桶加权，避免用还没发生的部分稀释最新点。每个点直接
 * 求和，不做滚动加减，空闲时段不会因为浮点残差画出彩色线。当前桶之后的桶还
 * 没发生，值固定为 0。
 */
function trailingAverage(
  values: readonly number[],
  currentIndex: number,
  progress: number,
): number[] {
  const length = values.length;
  const result = new Array<number>(length).fill(0);
  const last = Math.min(currentIndex, length - 1);

  for (let index = 0; index <= last; index += 1) {
    if (index < last) {
      // 已完成的桶：这个桶和之前两个桶
      let sum = 0;
      let count = 0;
      for (let offset = 0; offset < SMOOTH_SLOTS; offset += 1) {
        const source = index - offset;
        if (source < 0) break;
        sum += values[source];
        count += 1;
      }
      result[index] = count > 0 ? sum / count : 0;
      continue;
    }

    // 当前桶：过去 15 分钟跨 4 个桶，两端按已过去的时间比例加权
    let sum = 0;
    let weight = 0;
    for (let offset = 0; offset < SMOOTH_SLOTS + 1; offset += 1) {
      const source = index - offset;
      if (source < 0) continue;
      const bucketWeight =
        offset === 0 ? progress : offset === SMOOTH_SLOTS ? 1 - progress : 1;
      if (bucketWeight <= 0) continue;
      sum += values[source] * bucketWeight;
      weight += bucketWeight;
    }
    result[index] = weight > 0 ? sum / weight : 0;
  }

  return result;
}

function formatSlotStart(slot: number): string {
  const minutes = slot * 5;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatSlotRange(slot: number): string {
  return `${formatSlotStart(slot)} - ${formatSlotStart(slot + 1)}`;
}

function xForIndex(
  index: number,
  start: number,
  span: number,
  width: number,
): number {
  return span > 0 ? ((index - start + 0.5) / span) * width : 0;
}

/** 把值映射到图内高度；基线在 height - 2 */
function yForValue(value: number, max: number, height: number): number {
  const innerHeight = Math.max(1, height - 4);
  return height - 2 - (Math.max(0, value) / max) * innerHeight;
}

const segmentStyle = {
  position: "absolute" as const,
  height: 2,
  borderRadius: 1,
};

/**
 * 只画基线和折线。单独 memo，鼠标移动时只有竖线和读数更新，不用重算所有线段。
 */
const SlotCurve = memo(function SlotCurve({
  series,
  start,
  span,
  end,
  width,
  height,
  max,
  borderColor,
}: {
  series: readonly SmoothedSeries[];
  start: number;
  span: number;
  /** 排他上界；超过当前 5 分钟桶的部分不画 */
  end: number;
  width: number;
  height: number;
  max: number;
  borderColor: string;
}) {
  if (width <= 0) return null;
  const visibleEnd = Math.min(
    end,
    series[0]?.values.length ?? 0,
    start + span,
  );
  return (
    <>
      <View
        style={{
          position: "absolute",
          left: 0,
          top: height - 2,
          width,
          height: 1,
          backgroundColor: borderColor,
        }}
      />
      {visibleEnd - start > 1
        ? series.flatMap((item) =>
            Array.from({ length: visibleEnd - start - 1 }, (_, offset) => {
              const index = start + offset;
              const nextIndex = index + 1;
              const value1 = item.values[index] ?? 0;
              const value2 = item.values[nextIndex] ?? 0;
              // 0 值段不画，减少 View 数量；基线单独画一条
              if (value1 <= 0 && value2 <= 0) return null;
              const x1 = xForIndex(index, start, span, width);
              const x2 = xForIndex(nextIndex, start, span, width);
              const y1 = yForValue(value1, max, height);
              const y2 = yForValue(value2, max, height);
              const dx = x2 - x1;
              const dy = y2 - y1;
              const length = Math.sqrt(dx * dx + dy * dy);
              const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
              const midX = (x1 + x2) / 2;
              const midY = (y1 + y2) / 2;
              return (
                <View
                  key={`${item.label}-${index}`}
                  style={[
                    segmentStyle,
                    {
                      left: midX - length / 2,
                      top: midY - 1,
                      width: length,
                      backgroundColor: item.color,
                      transform: [{ rotate: `${angle}deg` }],
                    },
                  ]}
                />
              );
            }),
          )
        : null}
    </>
  );
});

function BarChart({
  points,
  series,
  theme,
  height,
  selectedKey,
  onSelect,
}: {
  points: readonly ChartPoint[];
  series: readonly RenderSeries[];
  theme: PluginTheme;
  height: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const max = Math.max(
    1,
    ...points.map((_, index) =>
      series.reduce((sum, item) => sum + item.value(index), 0),
    ),
  );

  const styles = useMemo(
    () => ({
      legendRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
      },
      legend: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
      },
      legendDot: { width: 8, height: 8, borderRadius: 2 },
      legendText: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
      },
      chartRow: {
        flexDirection: "row" as const,
        alignItems: "flex-end" as const,
        height,
        gap: 2,
      },
      chartColumn: {
        flex: 1,
        height,
        alignItems: "center" as const,
        justifyContent: "flex-end" as const,
        borderRadius: 2,
      },
      chartColumnSelected: { backgroundColor: theme.colors.surface2 },
      barGroup: { width: "70%" as const, justifyContent: "flex-end" as const },
      dayRow: { flexDirection: "row" as const, gap: 2 },
      dayLabel: {
        flex: 1,
        textAlign: "center" as const,
        color: theme.colors.foregroundMuted,
        fontSize: 9,
      },
      dayLabelActive: {
        color: theme.colors.foreground,
        fontWeight: "600" as const,
      },
    }),
    [theme, height],
  );

  return (
    <View style={{ gap: 6 }}>
      {series.length > 1 ? (
        <View style={styles.legendRow}>
          {series.map((item) => (
            <View key={item.label} style={styles.legend}>
              <View style={[styles.legendDot, { backgroundColor: item.color }]} />
              <Text style={styles.legendText}>{item.label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.chartRow}>
        {points.map((point, index) => {
          const values = series.map((item) => item.value(index));
          return (
            <Pressable
              key={point.key}
              onPress={() => onSelect(point.key)}
              accessibilityRole="button"
              accessibilityLabel={`${point.title} ${series
                .map(
                  (item, seriesIndex) =>
                    `${item.label} ${item.format(values[seriesIndex])}`,
                )
                .join("，")}`}
              style={[
                styles.chartColumn,
                selectedKey === point.key && styles.chartColumnSelected,
              ]}
            >
              <View style={styles.barGroup}>
                {/* 反序渲染，让 series[0] 在底部 */}
                {series
                  .map((item, seriesIndex) => ({ item, seriesIndex }))
                  .reverse()
                  .map(({ seriesIndex }) => {
                    const barHeight = Math.max(
                      0,
                      Math.round((values[seriesIndex] / max) * height),
                    );
                    return (
                      <View
                        key={series[seriesIndex].label}
                        style={{
                          height: barHeight,
                          backgroundColor: series[seriesIndex].color,
                          borderRadius: 1,
                        }}
                      />
                    );
                  })}
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.dayRow}>
        {points.map((point) => (
          <Text
            key={point.key}
            style={[
              styles.dayLabel,
              selectedKey === point.key && styles.dayLabelActive,
            ]}
            numberOfLines={1}
          >
            {point.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

function SlotLineChart({
  label,
  slots,
  series,
  theme,
  height,
  start,
  span,
  dataEnd,
  selectedSlot,
  onSelect,
  onWheelZoom,
  accessibilityDescription,
}: {
  label: string;
  slots: readonly SlotStats[];
  series: readonly SmoothedSeries[];
  theme: PluginTheme;
  height: number;
  start: number;
  span: number;
  /** 已发生的桶的排他上界，曲线、纵轴和选点都不越过它 */
  dataEnd: number;
  selectedSlot: number | null;
  onSelect: (slot: number) => void;
  onWheelZoom: (steps: number, ratio: number) => boolean;
  accessibilityDescription: string;
}) {
  const [width, setWidth] = useState(0);
  const lastHoverAt = useRef(0);
  const pendingHoverX = useRef<number | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectAtRef = useRef<(x: number) => void>(() => {});
  const wheelAccum = useRef(0);
  const chartRef = useRef<View | null>(null);
  const overlayRef = useRef<View | null>(null);
  const selectedIndex = selectedSlot ?? -1;
  const visibleEnd = Math.min(
    dataEnd,
    start + span,
    series[0]?.values.length ?? 0,
  );
  const visible = selectedIndex >= start && selectedIndex < visibleEnd;
  const max = useMemo(() => {
    let result = 1;
    for (const item of series) {
      for (let index = start; index < visibleEnd; index += 1) {
        const value = item.values[index] ?? 0;
        if (value > result) result = value;
      }
    }
    return result;
  }, [series, start, visibleEnd]);

  useEffect(() => {
    if (width <= 0) return;
    return addWheelZoom(chartRef.current, (deltaY, offsetX) => {
      // 触控板一次手势会发很多 wheel 事件，累积到阈值再走一档，避免一滑跳到底
      wheelAccum.current += deltaY;
      if (Math.abs(wheelAccum.current) < 40) return false;
      const steps = wheelAccum.current > 0 ? 1 : -1;
      wheelAccum.current = 0;
      return onWheelZoom(steps, clamp(offsetX / width, 0, 1));
    });
  }, [width, onWheelZoom]);

  const styles = useMemo(
    () => ({
      legendRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
      },
      legend: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
      },
      legendDot: { width: 8, height: 8, borderRadius: 2 },
      legendText: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
      },
      chart: {
        height,
        position: "relative" as const,
        overflow: "hidden" as const,
      },
      guide: {
        position: "absolute" as const,
        top: 0,
        width: 1,
        backgroundColor: theme.colors.foregroundMuted,
      },
      timeTag: {
        position: "absolute" as const,
        top: 0,
        width: 76,
        paddingVertical: 1,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        alignItems: "center" as const,
      },
      timeTagText: {
        color: theme.colors.foreground,
        fontSize: 9,
        fontVariant: ["tabular-nums" as const],
      },
      overlay: {
        position: "absolute" as const,
        left: 0,
        right: 0,
        top: 0,
      },
      labelRow: { position: "relative" as const, height: 12 },
      label: {
        position: "absolute" as const,
        width: 40,
        textAlign: "center" as const,
        color: theme.colors.foregroundMuted,
        fontSize: 9,
      },
      labelActive: {
        color: theme.colors.foreground,
        fontWeight: "600" as const,
      },
    }),
    [theme, height],
  );

  const guideX =
    width > 0 && visible
      ? xForIndex(selectedIndex, start, span, width)
      : null;
  const selectedHour = visible
    ? Math.floor(selectedIndex / SLOTS_PER_HOUR)
    : null;
  const tagLeft =
    guideX !== null && width > 0
      ? Math.max(0, Math.min(width - 76, guideX - 38))
      : 0;
  const ticks = useMemo(() => {
    const step = tickStep(span);
    const first = Math.ceil(start / step) * step;
    const result: Array<{ slot: number; label: string }> = [];
    for (let slot = first; slot < start + span; slot += step) {
      result.push({ slot, label: formatSlotStart(slot) });
    }
    return result;
  }, [start, span]);

  const selectAt = (x: number): void => {
    if (width <= 0 || span <= 0 || !Number.isFinite(x)) return;
    const last = Math.min(start + span - 1, visibleEnd - 1);
    if (last < start) return;
    const offset = Math.floor((x / width) * span);
    const index = clamp(start + offset, start, last);
    const slot = slots[index]?.slot;
    if (slot !== undefined && slot !== selectedSlot) onSelect(slot);
  };

  useEffect(() => {
    selectAtRef.current = selectAt;
  });

  useEffect(() => {
    return addKeySelect(overlayRef.current, (delta) => {
      if (selectedIndex < 0) return false;
      const last = Math.min(start + span - 1, visibleEnd - 1);
      if (last < start) return false;
      const next = clamp(selectedIndex + delta, start, last);
      const slot = slots[next]?.slot;
      if (slot === undefined) return false;
      onSelect(slot);
      return true;
    });
  }, [selectedIndex, start, span, visibleEnd, slots, onSelect]);

  useEffect(
    () => () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    },
    [],
  );

  return (
    <View style={{ gap: 6 }}>
      {series.length > 1 ? (
        <View style={styles.legendRow}>
          {series.map((item) => (
            <View key={item.label} style={styles.legend}>
              <View style={[styles.legendDot, { backgroundColor: item.color }]} />
              <Text style={styles.legendText}>{item.label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View
        ref={chartRef}
        style={styles.chart}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        <SlotCurve
          series={series}
          start={start}
          span={span}
          end={visibleEnd}
          width={width}
          height={height}
          max={max}
          borderColor={theme.colors.border}
        />

        {guideX !== null ? (
          <View style={[styles.guide, { left: guideX, height }]} />
        ) : null}

        {guideX !== null && selectedSlot !== null ? (
          <View style={[styles.timeTag, { left: tagLeft }]}>
            <Text style={styles.timeTagText}>
              {formatSlotRange(selectedSlot)}
            </Text>
          </View>
        ) : null}

        <Pressable
          ref={overlayRef}
          tabIndex={0}
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          // RN Web 只转发 aria-* 形式，对象形式的 accessibilityValue 会被过滤
          aria-valuemin={start}
          aria-valuemax={Math.max(start, visibleEnd - 1)}
          aria-valuenow={selectedIndex >= 0 ? selectedIndex : undefined}
          aria-valuetext={accessibilityDescription}
          accessibilityActions={[
            { name: "increment", label: "后 5 分钟" },
            { name: "decrement", label: "前 5 分钟" },
          ]}
          onAccessibilityAction={(event) => {
            if (selectedIndex < 0) return;
            const last = Math.min(start + span - 1, visibleEnd - 1);
            if (last < start) return;
            const delta =
              event.nativeEvent.actionName === "increment" ? 1 : -1;
            const next = clamp(selectedIndex + delta, start, last);
            const slot = slots[next]?.slot;
            if (slot !== undefined) onSelect(slot);
          }}
          onPointerMove={(event) => {
            // 只在鼠标上跟随；触摸拖动交给 onPress，避免滚动时误选
            if (event.nativeEvent.pointerType !== "mouse") return;
            const x = event.nativeEvent.offsetX;
            const now = Date.now();
            const elapsed = now - lastHoverAt.current;
            if (elapsed >= HOVER_THROTTLE_MS) {
              if (hoverTimer.current !== null) {
                clearTimeout(hoverTimer.current);
                hoverTimer.current = null;
              }
              pendingHoverX.current = null;
              lastHoverAt.current = now;
              selectAt(x);
              return;
            }
            // 节流窗口内只记最后位置，等窗口结束补一次，
            // 否则鼠标快速移动后停下，读数会停在中途的桶
            pendingHoverX.current = x;
            if (hoverTimer.current !== null) return;
            hoverTimer.current = setTimeout(() => {
              hoverTimer.current = null;
              const pending = pendingHoverX.current;
              pendingHoverX.current = null;
              if (pending === null) return;
              lastHoverAt.current = Date.now();
              selectAtRef.current(pending);
            }, HOVER_THROTTLE_MS - elapsed);
          }}
          onPress={(event) => selectAt(event.nativeEvent.locationX)}
          style={[styles.overlay, { height }]}
        />
      </View>

      <View style={styles.labelRow}>
        {width > 0
          ? ticks.map((tick) => {
              const x = xForIndex(tick.slot, start, span, width);
              const left = clamp(x - 20, 0, Math.max(0, width - 40));
              const active =
                selectedHour !== null &&
                tick.slot % SLOTS_PER_HOUR === 0 &&
                Math.floor(tick.slot / SLOTS_PER_HOUR) === selectedHour;
              return (
                <Text
                  key={tick.slot}
                  style={[styles.label, active && styles.labelActive, { left }]}
                  numberOfLines={1}
                >
                  {tick.label}
                </Text>
              );
            })
          : null}
      </View>
    </View>
  );
}

function DailyChart({
  days,
  series,
  theme,
  compact,
}: {
  days: readonly Daily[];
  series: readonly DailySeries[];
  theme: PluginTheme;
  compact: boolean;
}) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const selected =
    days.find((day) => day.day === selectedDay) ?? days[days.length - 1] ?? null;
  const points: ChartPoint[] = days.map((day, index) => ({
    key: day.day,
    label: shouldShowDay(index, days.length) ? formatDayLabel(day.day) : "",
    title: day.day,
  }));
  const chartSeries: RenderSeries[] = series.map((item) => ({
    label: item.label,
    color: item.color,
    value: (index) => item.value(days[index]),
    format: formatTokens,
  }));

  return (
    <View style={{ gap: 6 }}>
      <BarChart
        points={points}
        series={chartSeries}
        theme={theme}
        height={compact ? 56 : 80}
        selectedKey={selected?.day ?? null}
        onSelect={setSelectedDay}
      />
      {selected ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {formatDayLabel(selected.day)}{" / "}
          {series
            .map(
              (item) => `${item.label} ${formatTokens(item.value(selected))}`,
            )
            .join(" / ")}
        </Text>
      ) : null}
    </View>
  );
}

function SlotSection({
  slots,
  theme,
  compact,
}: {
  slots: readonly SlotStats[];
  theme: PluginTheme;
  compact: boolean;
}) {
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [pinnedViewport, setPinnedViewport] = useState<SlotViewport | null>(
    null,
  );
  const now = new Date();
  const currentSlot = localSlot(now);
  // 当前 5 分钟桶已经过去的比例，用于加权，避免最新点被未来时间稀释
  const slotProgress = (now.getMinutes() % 5) / 5;
  // 默认看今天最后一个有活动的桶；一整天都没活动才退回当前时间
  const lastActiveSlot = useMemo(() => {
    for (let index = slots.length - 1; index >= 0; index -= 1) {
      const item = slots[index];
      if (
        item.activeReadMs > 0 ||
        item.activeReviewMs > 0 ||
        item.activeTypingMs > 0 ||
        item.readTokens > 0 ||
        item.missTokens > 0 ||
        item.typedChars > 0
      ) {
        return item.slot;
      }
    }
    return null;
  }, [slots]);
  const defaultViewport = useMemo(
    () => centeredViewport(lastActiveSlot ?? currentSlot, DEFAULT_SPAN),
    [lastActiveSlot, currentSlot],
  );
  const viewport = pinnedViewport ?? defaultViewport;
  // 只允许选到已经发生的桶；视口可能向未来延伸，但读数不能落到未来
  const activeSlot = clamp(
    selectedSlot ?? lastActiveSlot ?? currentSlot,
    viewport.start,
    Math.min(viewport.start + viewport.span - 1, currentSlot),
  );
  const selected =
    slots.find((item) => item.slot === activeSlot) ?? slots[0] ?? null;
  const selectedIndex = selected
    ? Math.max(
        0,
        slots.findIndex((item) => item.slot === selected.slot),
      )
    : -1;
  const valueAt = (values: readonly number[]): number =>
    selectedIndex >= 0 ? values[selectedIndex] ?? 0 : 0;
  const height = compact ? 56 : 72;

  const smoothed = useMemo(() => {
    const read = trailingAverage(
      slots.map((item) => item.readTokens),
      currentSlot,
      slotProgress,
    );
    const miss = trailingAverage(
      slots.map((item) => item.missTokens),
      currentSlot,
      slotProgress,
    );
    const typed = trailingAverage(
      slots.map((item) => item.typedChars),
      currentSlot,
      slotProgress,
    );
    return { read, miss, typed };
  }, [slots, currentSlot, slotProgress]);

  const seriesRead = useMemo<SmoothedSeries[]>(
    () => [
      { label: "首次阅读", color: theme.colors.accent, values: smoothed.read },
      {
        label: "回读",
        color: theme.colors.statusWarning,
        values: smoothed.miss,
      },
    ],
    [smoothed, theme.colors.accent, theme.colors.statusWarning],
  );
  const seriesTyped = useMemo<SmoothedSeries[]>(
    () => [
      {
        label: "人类输入",
        color: theme.colors.statusSuccess,
        values: smoothed.typed,
      },
    ],
    [smoothed, theme.colors.statusSuccess],
  );

  const zoomBy = useCallback(
    (steps: number, ratio: number): boolean => {
      const found = ZOOM_SPANS.indexOf(viewport.span);
      const currentIndex =
        found >= 0 ? found : ZOOM_SPANS.indexOf(DEFAULT_SPAN);
      const nextIndex = clamp(
        currentIndex + steps,
        0,
        ZOOM_SPANS.length - 1,
      );
      const nextSpan = ZOOM_SPANS[nextIndex] ?? viewport.span;
      if (nextSpan === viewport.span) return false;
      const clampedRatio = clamp(ratio, 0, 1);
      const anchor = viewport.start + clampedRatio * viewport.span;
      // 起点不越过当前桶，保证视口始终包含已发生的数据
      const nextStart = clamp(
        Math.round(anchor - clampedRatio * nextSpan),
        0,
        Math.max(0, Math.min(SLOTS_PER_DAY - nextSpan, currentSlot)),
      );
      setPinnedViewport({ start: nextStart, span: nextSpan });
      setSelectedSlot(
        clamp(
          Math.floor(anchor),
          nextStart,
          Math.min(nextStart + nextSpan - 1, currentSlot),
        ),
      );
      return true;
    },
    [viewport, currentSlot],
  );
  const handleSelect = useCallback(
    (slot: number) => {
      setSelectedSlot(slot);
      setPinnedViewport((current) => current ?? viewport);
    },
    [viewport],
  );
  const zoomStep = (steps: number): void => {
    zoomBy(steps, (activeSlot - viewport.start + 0.5) / viewport.span);
  };

  const styles = useMemo(
    () => ({
      header: {
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        justifyContent: "space-between" as const,
        gap: 8,
        flexWrap: "wrap" as const,
      },
      hint: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 10 : 11,
      },
      zoomRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
      },
      zoomButton: {
        paddingHorizontal: compact ? 10 : 8,
        paddingVertical: compact ? 6 : 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      zoomButtonText: {
        color: theme.colors.foreground,
        fontSize: compact ? 10 : 11,
        fontWeight: "600" as const,
      },
      zoomLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 10 : 11,
        fontVariant: ["tabular-nums" as const],
        minWidth: 44,
        textAlign: "center" as const,
      },
      zoomHint: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 10 : 11,
      },
      headerTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 13 : 14,
        fontWeight: "600" as const,
      },
      range: {
        color: theme.colors.foreground,
        fontSize: compact ? 12 : 13,
        fontWeight: "600" as const,
        fontVariant: ["tabular-nums" as const],
      },
      grid: {
        width: "100%" as const,
        flexDirection: (compact ? "column" : "row") as "column" | "row",
        flexWrap: (compact ? "nowrap" : "wrap") as "nowrap" | "wrap",
        alignItems: "stretch" as const,
        gap: compact ? 16 : 20,
      },
      item: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: compact ? undefined : 280,
        gap: 2,
      },
      titleRow: {
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        justifyContent: "space-between" as const,
        gap: 6,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: compact ? 12 : 13,
        fontWeight: "600" as const,
      },
      value: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 10 : 11,
        textAlign: "right" as const,
        flexShrink: 1,
      },
    }),
    [theme, compact],
  );

  const selectedDescription = selected
    ? `${formatSlotRange(selected.slot)} · 过去 15 分钟平滑值 · 读入 ${formatTokens(
        valueAt(smoothed.read),
      )} huk · 回读 ${formatTokens(valueAt(smoothed.miss))} huk · 输入 ${formatTokens(
        valueAt(smoothed.typed),
      )} huk`
    : "";

  const chart = (title: string, value: string, series: SmoothedSeries[]) => (
    <View key={title} style={styles.item}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <SlotLineChart
        label={title}
        slots={slots}
        series={series}
        theme={theme}
        height={height}
        start={viewport.start}
        span={viewport.span}
        dataEnd={Math.min(slots.length, currentSlot + 1)}
        selectedSlot={selected?.slot ?? null}
        onSelect={handleSelect}
        onWheelZoom={zoomBy}
        accessibilityDescription={selectedDescription}
      />
    </View>
  );

  return (
    <View style={{ gap: 10 }}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>今天按 5 分钟</Text>
        <Text style={styles.range}>
          {selected ? formatSlotRange(selected.slot) : "--"}
        </Text>
      </View>
      <Text style={styles.hint}>
        曲线和读数都是过去 15 分钟的平均值，不是原始 5
        分钟桶；两张图的纵轴各自缩放，移动鼠标或点图查看
      </Text>
      <View style={styles.zoomRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="扩大时间范围"
          hitSlop={8}
          onPress={() => zoomStep(1)}
          style={styles.zoomButton}
        >
          <Text style={styles.zoomButtonText}>缩小</Text>
        </Pressable>
        <Text style={styles.zoomLabel}>{formatSpan(viewport.span)}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="缩小时间范围"
          hitSlop={8}
          onPress={() => zoomStep(-1)}
          style={styles.zoomButton}
        >
          <Text style={styles.zoomButtonText}>放大</Text>
        </Pressable>
        {compact ? null : <Text style={styles.zoomHint}>滚轮缩放</Text>}
      </View>
      <View style={styles.grid}>
        {chart(
          "读入",
          selected
            ? `首次 ${formatTokens(
                valueAt(smoothed.read),
              )} · 回读 ${formatTokens(valueAt(smoothed.miss))} huk`
            : "-",
          seriesRead,
        )}
        {chart(
          "输入",
          selected ? `${formatTokens(valueAt(smoothed.typed))} huk` : "-",
          seriesTyped,
        )}
      </View>
    </View>
  );
}

export function HumanTokensScreen({ theme, layout }: PluginScreenProps) {
  const compact = layout.compact;
  const [period, setPeriod] = useState<7 | 30>(7);
  // 30 天有 30 根柱子，双列时每列太窄会把日期截断，改为上下排
  const stackDaily = compact || period === 30;
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, error, loading } = useStats(period, refreshKey);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: {
        padding: compact ? 16 : 24,
        alignItems: "center" as const,
      },
      contentInner: {
        width: "100%" as const,
        maxWidth: 1200,
        gap: compact ? 12 : 16,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: compact ? 20 : 24,
        fontWeight: "600" as const,
      },
      subtitle: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 11 : 12,
      },
      legend: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        marginTop: 2,
      },
      card: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        padding: compact ? 12 : 16,
        gap: compact ? 8 : 10,
      },
      statGrid: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: compact ? 8 : 12,
      },
      statTile: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: compact ? 140 : 180,
        backgroundColor: theme.colors.surface1,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        padding: compact ? 12 : 16,
        gap: 2,
      },
      statLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 11 : 12,
      },
      statValue: {
        color: theme.colors.foreground,
        fontSize: compact ? 20 : 26,
        fontWeight: "600" as const,
        fontVariant: ["tabular-nums" as const],
      },
      statHint: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 10 : 11,
        lineHeight: compact ? 14 : 16,
      },
      detailGrid: {
        // 竖排 + wrap 时 Yoga 会把容器宽度收缩到内容宽度，这里给一个确定的整行宽度
        width: "100%" as const,
        flexDirection: (compact ? "column" : "row") as "column" | "row",
        flexWrap: (compact ? "nowrap" : "wrap") as "nowrap" | "wrap",
        alignItems: "stretch" as const,
        gap: compact ? 12 : 16,
      },
      detailCard: {
        flex: compact ? undefined : 1,
        minWidth: compact ? undefined : 300,
      },
      chartGrid: {
        width: "100%" as const,
        flexDirection: (stackDaily ? "column" : "row") as "column" | "row",
        flexWrap: (stackDaily ? "nowrap" : "wrap") as "nowrap" | "wrap",
        alignItems: "stretch" as const,
        gap: compact ? 12 : 16,
      },
      chartCard: {
        flex: stackDaily ? undefined : 1,
        minWidth: stackDaily ? undefined : 360,
      },
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 13 : 14,
        fontWeight: "600" as const,
      },
      muted: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 11 : 12,
      },
      empty: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 12 : 13,
        lineHeight: compact ? 18 : 20,
      },
      errorCard: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.statusDanger,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 4,
      },
      errorText: {
        color: theme.colors.statusDanger,
        fontSize: 11,
      },
      refresh: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      refreshText: {
        color: theme.colors.foreground,
        fontSize: 11,
      },
      toggle: {
        flexDirection: "row" as const,
        gap: 6,
        backgroundColor: theme.colors.surface1,
        padding: 3,
        borderRadius: 9,
        alignSelf: "flex-start" as const,
      },
      toggleItem: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 7,
      },
      toggleActive: { backgroundColor: theme.colors.accent },
      toggleText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      toggleTextActive: {
        color: theme.colors.accentForeground,
        fontWeight: "600" as const,
      },
      metricRow: { gap: 1 },
      metricLine: {
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      metricLabel: {
        color: theme.colors.foreground,
        fontSize: compact ? 12 : 13,
      },
      metricHint: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 10 : 11,
      },
      metricValue: {
        color: theme.colors.foreground,
        fontSize: compact ? 13 : 14,
        fontWeight: "600" as const,
        fontVariant: ["tabular-nums" as const],
      },
      todayRow: {
        flexDirection: "row" as const,
        gap: 12,
        flexWrap: "wrap" as const,
      },
      todayItem: {
        flexGrow: 1,
        flexBasis: compact ? 80 : 0,
        minWidth: 64,
        gap: 2,
      },
      todayValue: {
        color: theme.colors.foreground,
        fontSize: compact ? 16 : 20,
        fontWeight: "600" as const,
        fontVariant: ["tabular-nums" as const],
      },
      note: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        lineHeight: 15,
      },
    }),
    [theme, compact, stackDaily],
  );

  const lifetime = data?.lifetime;
  const today = data?.today;
  const daily = data?.daily ?? [];
  const slots = data?.slots ?? [];
  // daily 最后一项是查询当天；跨午夜时用它重置 5 分钟图的视口和选中点
  const todayKey = daily[daily.length - 1]?.day ?? "";
  const hasData =
    !!lifetime &&
    (lifetime.producedTokens > 0 ||
      lifetime.typedChars > 0 ||
      lifetime.readTokens > 0);

  const metric = (label: string, value: string, hint?: string) => (
    <View key={label} style={styles.metricRow}>
      <View style={styles.metricLine}>
        <Text style={styles.metricLabel}>{label}</Text>
        <Text style={styles.metricValue}>{value}</Text>
      </View>
      {hint ? <Text style={styles.metricHint}>{hint}</Text> : null}
    </View>
  );

  const statTile = (label: string, value: string, hint: string) => (
    <View key={label} style={styles.statTile}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statHint}>{hint}</Text>
    </View>
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.contentInner}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>huken</Text>
            <Text style={styles.subtitle}>AI 吃 token，人类烧 huken</Text>
            <Text style={styles.legend}>↓ AI 输出读入 · ↑ 人类输入</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => setRefreshKey((value) => value + 1)}
            style={styles.refresh}
          >
            <Text style={styles.refreshText}>{loading ? "刷新中" : "刷新"}</Text>
          </Pressable>
        </View>

        <View style={styles.toggle}>
          {([7, 30] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              onPress={() => setPeriod(value)}
              style={[
                styles.toggleItem,
                period === value && styles.toggleActive,
              ]}
            >
              <Text
                style={[
                  styles.toggleText,
                  period === value && styles.toggleTextActive,
                ]}
              >
                {value} 天
              </Text>
            </Pressable>
          ))}
        </View>

        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {!data && loading ? (
          <Text style={styles.muted}>加载中...</Text>
        ) : null}

        {!hasData && !loading ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>还没有数据</Text>
            <Text style={styles.empty}>
              打开一个 agent，等 AI 回复完成并在屏幕上停留一会儿，读过的内容
              才会记入；不会补算历史。
            </Text>
          </View>
        ) : null}

        {lifetime ? (
          <View style={styles.statGrid}>
            {statTile(
              "人类输入",
              `${formatTokens(lifetime.typedChars)} huk`,
              "只算真实输入，粘贴不算",
            )}
            {statTile(
              "实际读入",
              `${formatTokens(lifetime.readTokens)} huk`,
              `已读比例 ${formatPercent(lifetime.readTokens, lifetime.producedTokens)}`,
            )}
            {statTile(
              "AI 产出",
              `${formatTokens(lifetime.producedTokens)} tok`,
              "插件见过的 AI 回复",
            )}
            {statTile(
              "回读占比",
              formatPercent(lifetime.missTokens, lifetime.completedTokens),
              "回读内容占已读完内容的比例",
            )}
          </View>
        ) : null}

        {lifetime ? (
          <View style={styles.detailGrid}>
            <View style={[styles.card, styles.detailCard]}>
              <Text style={styles.sectionTitle}>效率</Text>
              {metric(
                "读速",
                formatRate(lifetime.readTokens, lifetime.activeReadMs),
                `首次阅读时间 ${formatDuration(lifetime.activeReadMs)}`,
              )}
              {metric(
                "回读速度",
                formatRate(lifetime.missTokens, lifetime.activeReviewMs),
                `本地回看 ${formatDuration(lifetime.activeReviewMs)}，跨会话回读未计时`,
              )}
              {metric(
                "输出速度",
                formatRate(lifetime.typedChars, lifetime.activeTypingMs),
                `人类输入 / 活跃输入时间 ${formatDuration(lifetime.activeTypingMs)}`,
              )}
            </View>
            <View style={[styles.card, styles.detailCard]}>
              <Text style={styles.sectionTitle}>行为</Text>
              {metric(
                "重读次数",
                String(lifetime.revisits),
                "同一段内容隔一会儿再回来看，算一次重读",
              )}
              {metric("切换 agent", String(lifetime.switches))}
              {metric("消息数", String(lifetime.messages))}
            </View>
          </View>
        ) : null}

        {today ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>今天</Text>
            <View style={styles.todayRow}>
              <View style={styles.todayItem}>
                <Text style={styles.todayValue}>
                  {formatTokens(today.typedChars)}
                </Text>
                <Text style={styles.muted}>输入 huk</Text>
              </View>
              <View style={styles.todayItem}>
                <Text style={styles.todayValue}>
                  {formatTokens(today.readTokens)}
                </Text>
                <Text style={styles.muted}>读入 huk</Text>
              </View>
              <View style={styles.todayItem}>
                <Text style={styles.todayValue}>
                  {formatTokens(today.missTokens)}
                </Text>
                <Text style={styles.muted}>回读 huk</Text>
              </View>
              <View style={styles.todayItem}>
                <Text style={styles.todayValue}>
                  {formatDuration(today.activeReadMs + today.activeReviewMs)}
                </Text>
                <Text style={styles.muted}>阅读时间</Text>
              </View>
              <View style={styles.todayItem}>
                <Text style={styles.todayValue}>{String(today.revisits)}</Text>
                <Text style={styles.muted}>重读</Text>
              </View>
              <View style={styles.todayItem}>
                <Text style={styles.todayValue}>{String(today.switches)}</Text>
                <Text style={styles.muted}>切换</Text>
              </View>
            </View>
          </View>
        ) : null}

        {hasData ? (
          <View style={styles.card}>
            <SlotSection
              key={todayKey}
              slots={slots}
              theme={theme}
              compact={compact}
            />
          </View>
        ) : null}

        {hasData ? (
          <View style={styles.chartGrid}>
            <View style={[styles.card, styles.chartCard]}>
              <Text style={styles.sectionTitle}>每日阅读 huken</Text>
              <DailyChart
                days={daily}
                theme={theme}
                compact={compact}
                series={[
                  {
                    label: "首次阅读",
                    color: theme.colors.accent,
                    value: (day) => day.readTokens,
                  },
                  {
                    label: "回读",
                    color: theme.colors.statusWarning,
                    value: (day) => day.missTokens,
                  },
                ]}
              />
            </View>
            <View style={[styles.card, styles.chartCard]}>
              <Text style={styles.sectionTitle}>每日输入 huken</Text>
              <DailyChart
                days={daily}
                theme={theme}
                compact={compact}
                series={[
                  {
                    label: "人类输入",
                    color: theme.colors.statusSuccess,
                    value: (day) => day.typedChars,
                  },
                ]}
              />
            </View>
          </View>
        ) : null}

        {lifetime ? (
          <Text style={styles.note}>
            huk 是 huken 的缩写，1 huk = 1 个字符，用于比较趋势，不是模型的计费
            token。阅读时间按停留时间估算，不判断是否真的在看。
          </Text>
        ) : null}
        <Text style={styles.note}>
          统计数据只保存在 Paseo 的插件数据里，聊天正文不会上传或保存。
        </Text>
      </View>
    </ScrollView>
  );
}
