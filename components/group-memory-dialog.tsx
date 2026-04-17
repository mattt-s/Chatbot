"use client";

import { useEffect } from "react";

import type { GroupRoleMemory } from "@/lib/types";

type GroupMemoryDialogProps = {
  open: boolean;
  title: string;
  memory: Record<string, GroupRoleMemory> | null | undefined;
  onClose: () => void;
};

export function GroupMemoryDialog({
  open,
  title,
  memory,
  onClose,
}: GroupMemoryDialogProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const entries = memory ? Object.values(memory) : [];

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 px-4 backdrop-blur-[2px]">
      <div className="w-full max-w-lg rounded-[28px] border border-black/10 bg-[var(--paper)] p-5 shadow-[0_28px_90px_rgba(12,18,28,0.24)]">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold text-[var(--ink)]">记忆板</div>
            <div className="mt-1 text-sm text-[var(--ink-soft)]">{title}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-black/10 text-sm text-[var(--ink-soft)] transition hover:border-[var(--accent)]"
          >
            ×
          </button>
        </div>

        {entries.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-black/10 bg-white/70 px-4 py-8 text-center text-sm text-[var(--ink-soft)]">
            暂无记忆。角色在任务执行过程中会陆续写入自己的进度和关键信息。
          </div>
        ) : (
          <div className="mt-4 space-y-3 max-h-[60vh] overflow-y-auto pr-1">
            {entries.map((entry) => (
              <div
                key={entry.roleTitle}
                className="rounded-2xl border border-black/8 bg-white px-4 py-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                    {entry.roleTitle}
                  </div>
                  <div className="shrink-0 text-[10px] text-[var(--ink-soft)]">
                    {new Date(entry.updatedAt).toLocaleString("zh-CN")}
                  </div>
                </div>
                <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--ink)]">
                  {entry.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
