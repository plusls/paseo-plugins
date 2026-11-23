import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeHeadroomPills } from "./client/headroom";

export default function contribute(client: PluginClientContext) {
  return contributeHeadroomPills(client);
}
