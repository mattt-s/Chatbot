"use client";

import { useEffect } from "react";

import type { GroupPlan } from "@/lib/types";

function getItemStatusLabel(status: GroupPlan["items"][number]["status"]) {
  switch (status) {
    case "done":
      return "已完成";
    case "in_progress":
      return "进行中";
    case "blocked":
      return "阻塞";
    default:
      return "待开始";
  }
}

function getItemStatusClassName(status: GroupPlan["items"][number]["status"]) {
  switch (status) {
    case "done":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "in_progress":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "blocked":
      return "border-rose-200 bg-rose-50 text-rose-700";
    default:
      return "border-amber-200 bg-amber-50 text-amber-700";
  }
}

type GroupPlanDialogProps = {
  open: boolean;
  title: string;
  plan: GroupPlan | null | undefined;
  onClose: () => void;
};

export function GroupPlanDialog({
  open,
  title,
  plan,
  onClose,
}: GroupPlanDialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 px-4 backdrop-blur-[2px]">
      <div className="w-full max-w-lg rounded-[28px] border border-black/10 bg-[var(--paper)] p-5 shadow-[0_28px_90px_rgba(12,18,28,0.24)]">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold text-[var(--ink)]">群 Plan</div>
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

        {!plan ? (
          <div className="mt-4 rounded-2xl border border-dashed border-black/10 bg-white/70 px-4 py-8 text-center text-sm text-[var(--ink-soft)]">
            暂无 Plan。等组长开始维护后，这里会显示当前群进度。
          </div>
        ) : (
          <>
            <div className="mt-4 rounded-2xl border border-black/8 bg-white px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                Summary
              </div>
              <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--ink)]">
                {plan.summary || "暂无摘要"}
              </div>
              <div className="mt-3 text-[11px] text-[var(--ink-soft)]">
                最近更新：{new Date(plan.updatedAt).toLocaleString("zh-CN")}
                {plan.updatedByLabel ? ` · ${plan.updatedByLabel}` : ""}
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {plan.items.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-black/10 bg-white/70 px-4 py-6 text-center text-sm text-[var(--ink-soft)]">
                  当前没有细分条目。
                </div>
              ) : (
                plan.items.map((item, index) => (
                  <div
                    key={`${item.title}-${index}`}
                    className="flex items-start justify-between gap-3 rounded-2xl border border-black/8 bg-white px-4 py-3"
                  >
                    <div className="min-w-0 flex-1 text-sm leading-6 text-[var(--ink)]">
                      {item.title}
                    </div>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getItemStatusClassName(item.status)}`}
                    >
                      {getItemStatusLabel(item.status)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
