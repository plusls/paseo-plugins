import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { MeasurementHost } from "./driver";
import { formatTokens } from "./format";
import { useStats } from "./use-stats";

/** 侧边栏只显示今天的读入量，细节在插件页面 */
export function HumanTokensSidebarItem({
  theme,
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  const { data } = useStats(7);
  const active = currentScreen?.screenId === "main";
  const todayRead = data?.today.readTokens ?? 0;

  return (
    <>
      <SidebarRow
        icon="BookOpen"
        label="人类 token"
        active={active}
        onPress={() => openScreen({ screenId: "main" })}
        trailing={
          todayRead > 0 ? (
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontVariant: ["tabular-nums" as const],
              }}
            >
              {formatTokens(todayRead)}
            </Text>
          ) : undefined
        }
      />
      <MeasurementHost />
    </>
  );
}
