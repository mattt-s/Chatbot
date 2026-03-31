/**
 * @file 新建群组对话框组件。
 *
 * 让用户输入群组名称来创建一个新的群组面板。
 */
"use client";

import { useEffect, useState } from "react";

/**
 * 新建群组对话框配置。
 */
export type CreateGroupDialogConfig = {
  open: boolean;
};

/**
 * 新建群组模态对话框。
 *
 * @param props.config - 对话框配置，为 null 或 open=false 时隐藏
 * @param props.isSubmitting - 是否正在提交中
 * @param props.onClose - 关闭回调
 * @param props.onCreate - 创建群组回调
 */
export function CreateGroupDialog({
  config,
  isSubmitting,
  onClose,
  onCreate,
}: {
  config: CreateGroupDialogConfig | null;
  isSubmitting: boolean;
  onClose: () => void;
  onCreate: (input: { title: string }) => Promise<void> | void;
}) {
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (config?.open) {
      setTitle("");
    }
  }, [config]);

  useEffect(() => {
    if (!config?.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [config, isSubmitting, onClose]);

  if (!config?.open) return null;

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 px-4 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-[28px] border border-black/10 bg-[var(--paper)] p-5 shadow-[0_28px_90px_rgba(12,18,28,0.24)]">
        <div className="text-lg font-semibold text-[var(--ink)]">新增群组</div>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
          创建一个新的群组，可以在其中添加多个角色并让它们互相协作。
        </p>

        <div className="mt-5">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink-soft)]">
              群组名称
            </span>
            <input
              className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-base outline-none transition focus:border-[var(--accent)]"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isSubmitting}
              placeholder="例如：项目策划组"
              autoFocus
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
            disabled={isSubmitting || !title.trim()}
            onClick={async () => {
              await onCreate({ title: title.trim() });
            }}
            className="rounded-full bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
          >
            {isSubmitting ? "创建中..." : "创建群组"}
          </button>
        </div>
      </div>
    </div>
  );
}
