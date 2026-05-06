"use client";

import type { TaskModePlan } from "@/lib/task-mode/types";

interface Props {
  plan: TaskModePlan;
  isConfirming: boolean;
  onConfirm: () => void;
}

function PlanSection({
  label,
  value,
}: {
  label: string;
  value: string | string[];
}) {
  const isEmpty =
    typeof value === "string" ? !value.trim() : value.length === 0;

  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold text-[var(--ink-soft)] uppercase tracking-wide">
        {label}
      </div>
      {isEmpty ? (
        <div className="text-xs text-[var(--ink-soft)] italic">待填写…</div>
      ) : typeof value === "string" ? (
        <div className="text-sm text-[var(--ink)] leading-relaxed">{value}</div>
      ) : (
        <ul className="space-y-0.5">
          {value.map((item, i) => (
            <li key={i} className="text-sm text-[var(--ink)] leading-relaxed flex gap-2">
              <span className="text-[var(--ink-soft)] shrink-0">·</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function filledFieldCount(plan: TaskModePlan): number {
  let count = 0;
  if (plan.goal.trim()) count++;
  if (plan.constraints.length > 0) count++;
  if (plan.deliverables.length > 0) count++;
  if (plan.acceptanceCriteria.length > 0) count++;
  if (plan.taskOutline.length > 0) count++;
  return count;
}

export function TaskModePlanView({ plan, isConfirming, onConfirm }: Props) {
  const filled = filledFieldCount(plan);
  const total = 5;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-black/8 px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-[var(--ink)]">规划方案</span>
          <span className="text-xs text-[var(--ink-soft)]">
            {filled} / {total} 已填写
          </span>
        </div>
        {/* Progress bar */}
        <div className="mt-1.5 h-1 rounded-full bg-black/8 overflow-hidden">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
            style={{ width: `${(filled / total) * 100}%` }}
          />
        </div>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        <PlanSection label="目标" value={plan.goal} />
        <PlanSection label="约束条件" value={plan.constraints} />
        <PlanSection label="交付物" value={plan.deliverables} />
        <PlanSection label="验收标准" value={plan.acceptanceCriteria} />
        <PlanSection label="任务草稿" value={plan.taskOutline} />
      </div>

      {/* Confirm button */}
      <div className="shrink-0 border-t border-black/8 p-3">
        <p className="mb-2 text-[11px] text-[var(--ink-soft)] text-center">
          与 Leader 完成规划对话后即可确认
        </p>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isConfirming}
          className="w-full rounded-xl bg-[var(--ink)] py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isConfirming ? "确认中…" : "确认计划，进入执行阶段"}
        </button>
      </div>
    </div>
  );
}
