import type { PluginClientContext } from "@getpaseo/plugin/client";
import { QuotaFooterItem } from "./client/quota";
import { QuotaSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSidebarFooterItem({
    id: "codex-quota",
    title: "Codex 额度",
    Component: QuotaFooterItem,
  });
  client.addSettingsScreen({
    id: "settings",
    title: "AIO 额度",
    icon: "Gauge",
    Component: QuotaSettingsScreen,
  });
  return () => {};
}
