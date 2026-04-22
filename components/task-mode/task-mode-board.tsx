/**
 * @file 任务模式看板组件。
 *
 * 展示群组任务列表（状态卡片）及可展开的任务详情面板。
 * 完全独立于聊天模式，不与 message-list / panel-card 共享逻辑。
 */
"use client";

import { useState } from "react";

import type {
  GroupTaskModeState,
  GroupTaskStatus,
  GroupTaskView,
} from "@/lib/task-mode/types";

// ─────────────────────────────────────────────────────────────
// 状态显示配置
// ─────────────────────────────────────────────────────────────

const STATUS_CFG: Record<GroupTaskStatus, { label: string; cls: string }> = {
  created:          { label: "待分配", cls: "bg-gray-100 text-gray-500 border border-gray-200" },
  assigned:         { label: "已分配", cls: "bg-blue-50 text-blue-600 border border-blue-200" },
  in_progress:      { label: "执行中", cls: "bg-blue-100 text-blue-700 border border-blue-200" },
  blocked:          { label: "已阻塞", cls: "bg-red-100 text-red-700 border border-red-200" },
  submitted:        { label: "已提交", cls: "bg-purple-50 text-purple-600 border border-purple-200" },
  reviewing:        { label: "审核中", cls: "bg-purple-100 text-purple-700 border border-purple-200" },
  done:             { label: "已完成", cls: "bg-green-100 text-green-700 border border-green-200" },
  rejected:         { label: "已退回", cls: "bg-orange-100 text-orange-700 border border-orange-200" },
  needs_intervention: { label: "需介入", cls: "bg-red-500 text-white" },
  cancelled:        { label: "已取消", cls: "bg-gray-100 text-gray-400 border border-gray-200" },
};

const GROUP_STATE_CFG: Record<GroupTaskModeState, { label: string; cls: string }> = {
  needs_user:          { label: "⚠ 需要介入", cls: "bg-red-500 text-white" },
  blocked:             { label: "已阻塞", cls: "bg-orange-100 text-orange-700 border border-orange-200" },
  in_progress:         { label: "执行中", cls: "bg-blue-100 text-blue-700 border border-blue-200" },
  waiting_dependency:  { label: "等待前置", cls: "bg-gray-100 text-gray-500 border border-gray-200" },
  idle:                { label: "空闲", cls: "bg-gray-100 text-gray-400 border border-gray-200" },
};

// ─────────────────────────────────────────────────────────────
// 子组件
// ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: GroupTaskStatus }) {
  const cfg = STATUS_CFG[status];
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function TaskCard({
  task,
  selected,
  onSelect,
}: {
  task: GroupTaskView;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      className={[
        "w-full rounded-2xl border p-3 text-left transition",
        selected
          ? "border-[var(--accent)] bg-[var(--accent)]/5"
          : "border-black/8 bg-[var(--paper)] hover:border-[var(--accent)]/40",
      ].join(" ")}
    >
      <div className="flex items-start gap-2">
        <StatusBadge status={task.status} />
        <span className="min-w-0 flex-1 text-sm font-medium text-[var(--ink)] leading-snug">
          {task.title}
        </span>
      </div>

      {task.assigneeRoleTitle && (
        <div className="mt-1.5 pl-0.5 text-xs text-[var(--ink-soft)]">
          负责：{task.assigneeRoleTitle}
        </div>
      )}

      {task.dependsOnTaskIds.length > 0 && (
        <div className="mt-1 pl-0.5 text-[10px] text-[var(--ink-soft)]">
          前置 {task.dependsOnTaskIds.length} 项
        </div>
      )}

      {task.status === "needs_intervention" && task.watchdogRetryCount > 0 && (
        <div className="mt-1.5 rounded-xl bg-red-50 px-2 py-1 text-[11px] text-red-700">
          Watchdog 已重试 {task.watchdogRetryCount} 次，需人工介入
        </div>
      )}
    </button>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-soft)]">
      {label}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 任务详情面板
// ─────────────────────────────────────────────────────────────

function TaskDetail({
  task,
  allTasks,
  panelId,
  onClose,
  onTaskUpdated,
}: {
  task: GroupTaskView;
  allTasks: GroupTaskView[];
  panelId: string;
  onClose: () => void;
  onTaskUpdated: () => void;
}) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function fmtTime(iso: string) {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function doAction(action: string) {
    if (actionLoading) return;
    setActionLoading(action);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/panels/${panelId}/group-tasks/${task.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      onTaskUpdated();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setActionLoading(null);
    }
  }

  // Whether user intervention actions are available
  const canRedispatch = task.status === "needs_intervention" || task.status === "assigned";
  const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
  const canCancel = !TERMINAL_STATUSES.has(task.status);

  return (
    <div className="flex h-full flex-col">
      {/* Detail header */}
      <div className="shrink-0 flex items-start justify-between gap-3 border-b border-black/8 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={task.status} />
            <span className="text-sm font-semibold text-[var(--ink)]">{task.title}</span>
          </div>
          {task.assigneeRoleTitle && (
            <div className="mt-1 text-xs text-[var(--ink-soft)]">负责：{task.assigneeRoleTitle}</div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭详情"
          className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-full border border-black/10 text-sm text-[var(--ink-soft)] transition hover:border-[var(--accent)]"
        >
          ✕
        </button>
      </div>

      {/* Detail body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        {/* Description */}
        {task.description && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
              任务描述
            </div>
            <p className="text-sm leading-relaxed text-[var(--ink)] whitespace-pre-wrap">
              {task.description}
            </p>
          </div>
        )}

        {/* Dependencies */}
        {task.dependsOnTaskIds.length > 0 && (
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
              前置依赖（{task.dependsOnTaskIds.length}）
            </div>
            <div className="space-y-1.5">
              {task.dependsOnTaskIds.map((depId) => {
                const dep = allTasks.find((t) => t.id === depId);
                return (
                  <div
                    key={depId}
                    className="flex items-center gap-2 rounded-xl border border-black/8 bg-[var(--paper-2)] px-3 py-1.5"
                  >
                    {dep ? (
                      <>
                        <StatusBadge status={dep.status} />
                        <span className="text-xs text-[var(--ink)]">{dep.title}</span>
                        {dep.assigneeRoleTitle && (
                          <span className="ml-auto text-[10px] text-[var(--ink-soft)]">
                            {dep.assigneeRoleTitle}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-xs text-[var(--ink-soft)]">{depId}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Submission note */}
        {task.submissionNote && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
              提交说明
            </div>
            <div className="rounded-2xl border border-black/8 bg-[var(--paper-2)] px-3 py-2">
              <p className="text-sm leading-relaxed text-[var(--ink)] whitespace-pre-wrap">
                {task.submissionNote}
              </p>
            </div>
          </div>
        )}

        {/* Review note */}
        {task.reviewNote && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
              审核意见
            </div>
            <div className="rounded-2xl border border-orange-200 bg-orange-50 px-3 py-2">
              <p className="text-sm leading-relaxed text-orange-800 whitespace-pre-wrap">
                {task.reviewNote}
              </p>
            </div>
          </div>
        )}

        {/* User intervention */}
        {(canRedispatch || canCancel) && (
          <div>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
              用户介入
            </div>
            <div className="flex flex-wrap gap-2">
              {canRedispatch && (
                <button
                  type="button"
                  disabled={!!actionLoading}
                  onClick={() => doAction("redispatch")}
                  className="inline-flex items-center gap-1 rounded-xl border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 transition hover:bg-blue-100 disabled:opacity-50"
                >
                  {actionLoading === "redispatch" ? "…" : "↺ 重新分配"}
                </button>
              )}
              {canCancel && (
                <button
                  type="button"
                  disabled={!!actionLoading}
                  onClick={() => doAction("cancel")}
                  className="inline-flex items-center gap-1 rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50"
                >
                  {actionLoading === "cancel" ? "…" : "✕ 取消任务"}
                </button>
              )}
            </div>
            {actionError && (
              <p className="mt-2 text-xs text-red-600">{actionError}</p>
            )}
          </div>
        )}

        {/* Text outputs */}
        {(task.textOutputs.length > 0 || ["in_progress", "assigned", "submitted", "reviewing"].includes(task.status)) && (
          <div>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
              执行输出{task.textOutputs.length > 0 ? `（${task.textOutputs.length} 条）` : ""}
            </div>
            <div className="space-y-3">
              {task.textOutputs.length === 0 ? (
                <p className="text-xs text-[var(--ink-soft)] italic">执行中，暂无输出…</p>
              ) : (
                task.textOutputs.map((output) => (
                  <div
                    key={output.id}
                    className="rounded-2xl border border-black/8 bg-[var(--paper-2)] p-3"
                  >
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-[var(--ink)]">{output.roleTitle}</span>
                      <span className="text-[10px] text-[var(--ink-soft)]">{fmtTime(output.ts)}</span>
                    </div>
                    <p className="text-xs leading-relaxed text-[var(--ink-soft)] whitespace-pre-wrap line-clamp-8">
                      {output.text}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Event log */}
        {task.events.length > 0 && (
          <div>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
              事件日志
            </div>
            <div className="space-y-2">
              {task.events
                .slice()
                .reverse()
                .map((ev) => (
                  <div key={ev.id} className="flex items-start gap-2.5">
                    <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ink-soft)] opacity-60" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1 flex-wrap">
                        <span className="text-xs font-medium text-[var(--ink)]">
                          {ev.actorRoleTitle}
                        </span>
                        <span className="text-[11px] text-[var(--ink-soft)]">·</span>
                        <span className="text-[11px] text-[var(--ink-soft)]">{ev.type}</span>
                      </div>
                      {ev.note && (
                        <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--ink-soft)]">
                          {ev.note}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-[10px] text-[var(--ink-soft)]">
                      {fmtTime(ev.ts)}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────

export interface TaskModeBoardProps {
  tasks: GroupTaskView[];
  groupState: GroupTaskModeState;
  isLoading: boolean;
  panelId: string;
  onRefresh: () => void;
}

/**
 * 任务看板。
 * 左侧为按状态分组的任务卡片列表，点击后右侧展开任务详情。
 */
export function TaskModeBoard({
  tasks,
  groupState,
  isLoading,
  panelId,
  onRefresh,
}: TaskModeBoardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedTask = selectedId ? (tasks.find((t) => t.id === selectedId) ?? null) : null;

  const doneCount = tasks.filter((t) => t.status === "done").length;
  const totalCount = tasks.filter((t) => t.status !== "cancelled").length;
  const groupStateCfg = GROUP_STATE_CFG[groupState];

  // Group tasks by "urgency / status category"
  const urgentTasks = tasks.filter((t) => t.status === "needs_intervention");
  const activeTasks = tasks.filter((t) =>
    ["assigned", "in_progress", "submitted", "reviewing", "blocked"].includes(t.status),
  );
  const pendingTasks = tasks.filter((t) =>
    ["created", "rejected"].includes(t.status),
  );
  const doneTasks = tasks.filter((t) => t.status === "done" || t.status === "cancelled");

  function handleSelect(id: string) {
    setSelectedId((current) => (current === id ? null : id));
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* ── Task list column ── */}
      <div
        className={[
          "flex flex-col overflow-hidden",
          selectedTask ? "w-[260px] shrink-0 border-r border-black/8" : "flex-1",
        ].join(" ")}
      >
        {/* Board header */}
        <div className="shrink-0 flex items-center justify-between gap-2 border-b border-black/8 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${groupStateCfg.cls}`}>
              {groupStateCfg.label}
            </span>
            {totalCount > 0 && (
              <span className="text-xs text-[var(--ink-soft)]">
                {doneCount} / {totalCount} 完成
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            title="刷新任务"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-black/10 text-[var(--ink-soft)] transition hover:border-[var(--accent)] disabled:opacity-40"
          >
            <svg
              viewBox="0 0 24 24"
              className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
              <path d="M12 6v6l4 2" />
            </svg>
          </button>
        </div>

        {/* Task groups */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
          {isLoading && tasks.length === 0 && (
            <div className="flex items-center justify-center py-16 text-sm text-[var(--ink-soft)]">
              加载中…
            </div>
          )}

          {!isLoading && tasks.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-2.5 text-[var(--ink-soft)]">
              <span className="text-3xl">📋</span>
              <span className="text-sm font-medium">暂无任务</span>
              <span className="text-xs opacity-60 text-center leading-relaxed">
                Leader 将在对话中创建<br />并分配任务
              </span>
            </div>
          )}

          {urgentTasks.length > 0 && (
            <div>
              <SectionLabel label="需要介入" />
              <div className="space-y-2">
                {urgentTasks.map((t) => (
                  <TaskCard key={t.id} task={t} selected={t.id === selectedId} onSelect={handleSelect} />
                ))}
              </div>
            </div>
          )}

          {activeTasks.length > 0 && (
            <div>
              <SectionLabel label="进行中" />
              <div className="space-y-2">
                {activeTasks.map((t) => (
                  <TaskCard key={t.id} task={t} selected={t.id === selectedId} onSelect={handleSelect} />
                ))}
              </div>
            </div>
          )}

          {pendingTasks.length > 0 && (
            <div>
              <SectionLabel label="待处理" />
              <div className="space-y-2">
                {pendingTasks.map((t) => (
                  <TaskCard key={t.id} task={t} selected={t.id === selectedId} onSelect={handleSelect} />
                ))}
              </div>
            </div>
          )}

          {doneTasks.length > 0 && (
            <div>
              <SectionLabel label="已结束" />
              <div className="space-y-2">
                {doneTasks.map((t) => (
                  <TaskCard key={t.id} task={t} selected={t.id === selectedId} onSelect={handleSelect} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Task detail column ── */}
      {selectedTask && (
        <div className="min-w-0 flex-1 overflow-hidden">
          <TaskDetail
            task={selectedTask}
            allTasks={tasks}
            panelId={panelId}
            onClose={() => setSelectedId(null)}
            onTaskUpdated={onRefresh}
          />
        </div>
      )}
    </div>
  );
}
