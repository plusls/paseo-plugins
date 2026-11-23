import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_USAGE_URL = "http://127.0.0.1:37123/v1/usage";

// 请求由 daemon 发出，所以设置按 host 保存；缺省值使用本机 AIO 地址
export const quotaSettings = defineSettings({
  id: "quota",
  scope: "host",
  version: 1,
  schema: z.object({
    usageUrl: z
      .url()
      .refine((value) => /^https?:\/\//i.test(value), "必须是 http 或 https 地址")
      .default(DEFAULT_USAGE_URL),
  }),
});
