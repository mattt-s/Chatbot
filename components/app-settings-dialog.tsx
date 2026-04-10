"use client";

import { useEffect, useState } from "react";

import type { AppSettingsView } from "@/lib/types";

export type AppSettingsDialogConfig = {
  open: boolean;
};

const EMPTY_SETTINGS: AppSettingsView = {
  appDebugEnabled: false,
  groupRoleWatchdogIntervalMs: 30_000,
  groupRoleBusyInspectAfterMs: 300_000,
  groupRoleBusyAbortAfterMs: 600_000,
  groupRoleReInjectAfterReplies: 10,
};

export function AppSettingsDialog({
  config,
  onClose,
  onSaved,
}: {
  config: AppSettingsDialogConfig | null;
  onClose: () => void;
  onSaved: (settings: AppSettingsView) => void;
}) {
  const [settings, setSettings] = useState<AppSettingsView>(EMPTY_SETTINGS);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!config?.open) {
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);
    setErrorMessage(null);

    void fetch("/api/settings", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("设置读取失败。");
        }
        const payload = (await response.json()) as AppSettingsView;
        setSettings(payload);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : "设置读取失败。");
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => controller.abort();
  }, [config]);

  useEffect(() => {
    if (!config?.open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [config, isSubmitting, onClose]);

  if (!config?.open) {
    return null;
  }

  function updateNumberField(
    key:
      | "groupRoleWatchdogIntervalMs"
      | "groupRoleBusyInspectAfterMs"
      | "groupRoleBusyAbortAfterMs"
      | "groupRoleReInjectAfterReplies",
    value: string,
  ) {
    const parsed = Number.parseInt(value, 10);
    setSettings((current) => ({
      ...current,
      [key]: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
    }));
  }

  const hasInvalidNumber =
    settings.groupRoleWatchdogIntervalMs <= 0 ||
    settings.groupRoleBusyInspectAfterMs <= 0 ||
    settings.groupRoleBusyAbortAfterMs <= 0 ||
    settings.groupRoleReInjectAfterReplies <= 0;

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/30 px-4 backdrop-blur-[2px]">
      <div className="w-full max-w-lg rounded-[28px] border border-black/10 bg-[var(--paper)] p-5 shadow-[0_28px_90px_rgba(12,18,28,0.24)]">
        <div className="text-lg font-semibold text-[var(--ink)]">设置</div>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
          这里的配置只控制 app 自己的运行行为。保存后会立即更新 watchdog 和 app debug 开关。
        </p>

        {errorMessage ? (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage}
          </div>
        ) : null}

        <div className="mt-5 space-y-4">
          <label className="flex items-center justify-between gap-4 rounded-2xl border border-black/8 bg-white px-4 py-3">
            <div>
              <div className="text-sm font-medium text-[var(--ink)]">App Debug</div>
              <div className="mt-1 text-xs leading-5 text-[var(--ink-soft)]">
                页面设置优先于 `APP_DEBUG` 环境变量。
              </div>
            </div>
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--accent)]"
              checked={settings.appDebugEnabled}
              disabled={isLoading || isSubmitting}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  appDebugEnabled: event.target.checked,
                }))
              }
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink-soft)]">
              Watchdog 扫描周期（毫秒）
            </span>
            <input
              type="number"
              min={1}
              className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-base outline-none transition focus:border-[var(--accent)]"
              value={settings.groupRoleWatchdogIntervalMs}
              disabled={isLoading || isSubmitting}
              onChange={(event) =>
                updateNumberField("groupRoleWatchdogIntervalMs", event.target.value)
              }
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink-soft)]">
              忙碌多久后开始检查 session（毫秒）
            </span>
            <input
              type="number"
              min={1}
              className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-base outline-none transition focus:border-[var(--accent)]"
              value={settings.groupRoleBusyInspectAfterMs}
              disabled={isLoading || isSubmitting}
              onChange={(event) =>
                updateNumberField("groupRoleBusyInspectAfterMs", event.target.value)
              }
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink-soft)]">
              忙碌多久后主动 abort（毫秒）
            </span>
            <input
              type="number"
              min={1}
              className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-base outline-none transition focus:border-[var(--accent)]"
              value={settings.groupRoleBusyAbortAfterMs}
              disabled={isLoading || isSubmitting}
              onChange={(event) =>
                updateNumberField("groupRoleBusyAbortAfterMs", event.target.value)
              }
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink-soft)]">
              群成员提示词重注入间隔（每隔多少次回复）
            </span>
            <input
              type="number"
              min={1}
              className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-base outline-none transition focus:border-[var(--accent)]"
              value={settings.groupRoleReInjectAfterReplies}
              disabled={isLoading || isSubmitting}
              onChange={(event) =>
                updateNumberField("groupRoleReInjectAfterReplies", event.target.value)
              }
            />
          </label>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-full border border-black/10 px-4 py-2 text-sm font-medium text-[var(--ink-soft)] transition hover:border-[var(--accent)] disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            disabled={isLoading || isSubmitting || hasInvalidNumber}
            onClick={async () => {
              setIsSubmitting(true);
              setErrorMessage(null);
              try {
                const response = await fetch("/api/settings", {
                  method: "PUT",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(settings),
                });
                if (!response.ok) {
                  throw new Error("设置保存失败。");
                }
                const payload = (await response.json()) as AppSettingsView;
                setSettings(payload);
                onSaved(payload);
                setIsSubmitting(false);
                onClose();
              } catch (error) {
                setErrorMessage(error instanceof Error ? error.message : "设置保存失败。");
                setIsSubmitting(false);
              }
            }}
            className="rounded-full bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
          >
            {isSubmitting ? "保存中..." : "保存设置"}
          </button>
        </div>
      </div>
    </div>
  );
}
