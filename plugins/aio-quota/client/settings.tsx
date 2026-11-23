import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DEFAULT_USAGE_URL, quotaSettings } from "../shared/settings";
import { SNAPSHOT_QUERY_KEY } from "./quota";

function QuotaSettingsForm({
  initialUrl,
  saving,
  saveError,
  saved,
  onDraftChange,
  onSave,
}: {
  initialUrl: string;
  saving: boolean;
  saveError: string | null;
  saved: boolean;
  onDraftChange: () => void;
  onSave: (url: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initialUrl);

  return (
    <SettingsSection title="AIO Coding Hub">
      <SettingsCard>
        <SettingsInput
          label="Usage 接口地址"
          hint={`默认地址：${DEFAULT_USAGE_URL}`}
          error={saveError}
          initialValue={initialUrl}
          placeholder={DEFAULT_USAGE_URL}
          disabled={saving}
          onChangeText={(text) => {
            setDraft(text);
            onDraftChange();
          }}
        />
        <SettingsAction
          label="保存配置"
          actionLabel={saving ? "保存中..." : saved ? "已保存" : "保存"}
          disabled={saving}
          onPress={() => {
            void onSave(draft.trim());
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

export function QuotaSettingsScreen() {
  const settings = useSettings(quotaSettings);
  const queryClient = useQueryClient();
  // 保存成功后表单会因 revision 变化而重建，成功状态放在这一层才能保留
  const [savedUrl, setSavedUrl] = useState<string | null>(null);

  const refreshSnapshot = async () => {
    // 查询尚无数据时 invalidateQueries 会复用进行中的旧地址请求，
    // 先取消它，确保下一轮请求使用刚保存的地址
    await queryClient.cancelQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
  };

  if (settings.status === "loading") {
    return (
      <SettingsSection title="AIO Coding Hub">
        <SettingsCard>
          <SettingsRow label="配置加载中..." />
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (settings.status === "error") {
    return (
      <SettingsSection title="AIO Coding Hub">
        <SettingsCard>
          <SettingsRow label="配置读取失败" hint={settings.error} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (settings.status === "invalid") {
    return (
      <SettingsSection title="AIO Coding Hub">
        <SettingsCard>
          <SettingsRow label="配置无效" hint={settings.error} />
          <SettingsAction
            label="恢复默认值"
            actionLabel={settings.saving ? "恢复中..." : "恢复"}
            error={settings.saveError}
            disabled={settings.saving}
            onPress={() => {
              void settings.reset().then(async (ok) => {
                if (ok) {
                  setSavedUrl(null);
                  await refreshSnapshot();
                }
              });
            }}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <QuotaSettingsForm
      // 其他客户端更新配置后 revision 会变化，重建表单避免用旧草稿覆盖新地址
      key={settings.revision}
      initialUrl={settings.values.usageUrl}
      saving={settings.saving}
      saveError={settings.saveError}
      saved={savedUrl === settings.values.usageUrl}
      onDraftChange={() => setSavedUrl(null)}
      onSave={async (usageUrl) => {
        const ok = await settings.save({ usageUrl }, settings.revision);
        if (ok) {
          setSavedUrl(usageUrl);
          await refreshSnapshot();
        }
      }}
    />
  );
}
