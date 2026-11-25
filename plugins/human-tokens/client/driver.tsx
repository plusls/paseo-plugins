import {
  useComposers,
  useSettings,
  type PluginComposer,
} from "@getpaseo/plugin/client";
import { useEffect, useRef } from "react";
import { Platform, View } from "react-native";
import { PASTE_THRESHOLD, SAMPLE_MS, deviceSettings } from "../shared/protocol";
import {
  clearPaste,
  consumePaste,
  recordTyped,
} from "./activity";
import { randomId } from "./ids";
import { charCount } from "./model";
import { createNativeScanner } from "./native";
import {
  addSamplerRoot,
  currentSamplerRoot,
  startSampler,
} from "./sampler";
import { createWebScanner, webIsForeground } from "./web";

/**
 * 采样宿主挂在侧边栏 footer item 上：手机上侧边栏收起时 Paseo 仍保持它挂载，
 * 而 composer item 只在设置弹层里挂载，正常看会话时不会启动。
 *
 * 隐藏 View 只用来拿 native fiber 根；输入统计通过 useComposers 读取当前聚焦的
 * composer，不依赖 composer item。
 */
export function MeasurementHost() {
  const deviceId = useDeviceId();
  const viewRef = useRef<View | null>(null);
  const composers = useComposers({ focused: true });
  const composer = composers[0] ?? null;
  const composerRef = useRef<PluginComposer | null>(null);
  const lastPromptRef = useRef(composer?.prompt ?? "");

  useEffect(() => {
    return addSamplerRoot(() => viewRef.current);
  }, []);

  useEffect(() => {
    // 没有聚焦的 composer 时清空基线，避免切换 agent 时把新草稿算成输入
    if (!composer) {
      composerRef.current = null;
      lastPromptRef.current = "";
      return;
    }
    if (!composerRef.current) lastPromptRef.current = composer.prompt;
    composerRef.current = composer;
  }, [composer]);

  useEffect(() => {
    const timer = setInterval(() => {
      const current = composerRef.current?.prompt ?? "";
      const previous = lastPromptRef.current;
      const delta = charCount(current) - charCount(previous);
      if (delta > 0) {
        // web 的 paste 事件会先记下长度；native 没有事件，超过阈值按粘贴处理
        const pasted = consumePaste(delta);
        let typed = delta - pasted;
        if (typed >= PASTE_THRESHOLD) typed = 0;
        if (typed > 0) recordTyped(typed);
        lastPromptRef.current = current;
      } else {
        // 提交、清空、删除、等长替换粘贴：只更新基线，不产生负数；
        // 粘贴额度也随之作废，不能再扣后面的真实输入
        clearPaste();
        lastPromptRef.current = current;
      }
    }, SAMPLE_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    const scan =
      Platform.OS === "web"
        ? createWebScanner()
        : createNativeScanner(currentSamplerRoot);
    const isForeground =
      Platform.OS === "web" ? webIsForeground : () => true;
    startSampler({ deviceId, scan, isForeground });
  }, [deviceId]);

  return (
    <View
      ref={viewRef}
      pointerEvents="none"
      {...(Platform.OS === "web" ? {} : { collapsable: false })}
      style={hiddenStyle}
    />
  );
}

const hiddenStyle = {
  position: "absolute" as const,
  width: 1,
  height: 1,
  opacity: 0,
};

function useDeviceId(): string | null {
  const state = useSettings(deviceSettings);
  const savingRef = useRef(false);
  const attemptsRef = useRef(0);
  const invalidLoggedRef = useRef(false);

  useEffect(() => {
    if (state.status !== "invalid" || invalidLoggedRef.current) return;
    invalidLoggedRef.current = true;
    console.error("[human-tokens] 设备设置无效", state.error);
  }, [state]);

  useEffect(() => {
    if (state.status !== "ready") return;
    if (state.values.deviceId) return;
    if (state.saving || state.saveError || savingRef.current) return;
    if (attemptsRef.current >= 3) return;

    savingRef.current = true;
    attemptsRef.current += 1;
    const id = randomId("d");
    void state.save({ deviceId: id }, state.revision).then((ok) => {
      savingRef.current = false;
      // 另一个客户端可能先写入了；重新读取，拿它的值
      if (!ok) void state.reload();
    });
  }, [state]);

  return state.status === "ready" && state.values.deviceId
    ? state.values.deviceId
    : null;
}
