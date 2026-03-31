/**
 * @file 通用确认对话框组件。
 *
 * 提供一个模态弹窗，用于在执行危险或不可撤销操作前向用户二次确认。
 * 支持 "danger"（红色）和 "default" 两种视觉风格，按 Escape 可关闭。
 */
"use client";

import { useState } from "react";

/**
 * 确认对话框的配置对象。
 *
 * @property title - 对话框标题
 * @property description - 描述/说明文字
 * @property confirmLabel - 确认按钮上的文案
 * @property tone - 视觉风格，"danger" 为红色警告，"default" 为普通
 * @property onConfirm - 用户点击确认后执行的回调（支持异步）
 */
export type ConfirmDialogConfig = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "default";
  onConfirm: () => Promise<void> | void;
};

import { useEffect } from "react";

/**
 * 通用确认对话框。
 *
 * 渲染一个全屏遮罩 + 居中卡片，包含标题、描述、取消和确认按钮。
 * 当 `config` 为 `null` 时不渲染任何内容。
 *
 * @param props.config - 对话框配置，为 null 时隐藏
 * @param props.onClose - 关闭（取消）回调
 */
export function ConfirmDialog({
  config,
  onClose,
}: {
  config: ConfirmDialogConfig | null;
  onClose: () => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!config) {
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

  if (!config) {
    return null;
  }

  const isDanger = config.tone !== "default";

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 px-4 backdrop-blur-[2px]">
      <div className="w-full max-w-sm rounded-[28px] border border-black/10 bg-[var(--paper)] p-5 shadow-[0_28px_90px_rgba(12,18,28,0.24)]">
        <div className="text-lg font-semibold text-[var(--ink)]">{config.title}</div>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
          {config.description}
        </p>

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
            disabled={isSubmitting}
            onClick={async () => {
              setIsSubmitting(true);
              try {
                await config.onConfirm();
                setIsSubmitting(false);
                onClose();
              } catch {
                setIsSubmitting(false);
              }
            }}
            className={`rounded-full px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-60 ${
              isDanger
                ? "bg-[#b42318] hover:opacity-90"
                : "bg-[var(--ink)] hover:opacity-90"
            }`}
          >
            {isSubmitting ? "处理中..." : config.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
