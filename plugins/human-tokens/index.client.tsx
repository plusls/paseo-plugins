import type { PluginClientContext } from "@getpaseo/plugin/client";
import { HumanTokensScreen } from "./client/screen";
import { HumanTokensSidebarItem } from "./client/sidebar";
import { setIngestSender, stopSampler } from "./client/sampler";
import { installPasteListener } from "./client/web";
import { ingestRpc, type IngestInput } from "./shared/protocol";

export default function contribute(client: PluginClientContext) {
  // 采样器不是 React 组件，通过模块级 sender 调插件 RPC
  setIngestSender((input: IngestInput) => client.rpc(ingestRpc, input));

  const removeScreen = client.addScreen({
    id: "main",
    title: "人类 token",
    Component: HumanTokensScreen,
  });
  const removeSidebar = client.addSidebarFooterItem({
    id: "main",
    title: "人类 token",
    Component: HumanTokensSidebarItem,
  });
  const removePaste = installPasteListener();

  return async () => {
    removeSidebar();
    removeScreen();
    removePaste();
    // 先等最后一批上传完，再断开 sender
    await stopSampler();
    setIngestSender(null);
  };
}
