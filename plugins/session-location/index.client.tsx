import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeLocationPills } from "./client/location";

export default function contribute(client: PluginClientContext) {
  return contributeLocationPills(client);
}
