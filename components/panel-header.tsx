/**
 * @file 面板头部状态栏组件。
 *
 * 显示面板标题（可编辑）、SSE 连接状态、消息计数、
 * 以及"停止推理"/"清空消息"等操作按钮。
 */
"use client";

import { useEffect, useRef, useState } from "react";

import { getGroupTaskStateClassName, getGroupTaskStateLabel } from "@/lib/group-task";
import type { AgentView, GroupTaskState, PanelView } from "@/lib/types";

/**
 * PanelHeader 的 Props。
 */
interface PanelHeaderProps {
  title: string;
  panel: PanelView;
  currentAgent: AgentView | null;
  streamStatus: "connecting" | "connected" | "closed";
  isRunActive: boolean;
  isAborting: boolean;
  messagesCount: number;
  onOpenSidebar: () => void;
  onTitleChange: (value: string) => void;
  onTitleBlur: () => void;
  onAbortRun: () => void;
  onOpenClearDialog: () => void;
  onCollapse?: () => void;
  /** 群组专用：打开"添加角色"对话框 */
  onAddGroupRole?: () => void;
  /** 群组专用：打开"角色管理"对话框 */
  onManageGroupRoles?: () => void;
  /** 群组专用：查看 Plan */
  onOpenGroupPlan?: () => void;
  /** 群组专用：手动切换群任务状态 */
  onSelectTaskState?: (selection: GroupTaskState) => void;
}

/**
 * 面板头部状态栏。
 *
 * 渲染一行紧凑的状态标签：侧边栏切换按钮（移动端）、可编辑标题、
 * 停止推理/清空消息按钮、SSE 连接状态徽标、消息计数。
 *
 * @param props - 参见 PanelHeaderProps
 */
export function PanelHeader({
  title,
  panel,
  currentAgent,
  streamStatus,
  isRunActive,
  isAborting,
  messagesCount,
  onOpenSidebar,
  onTitleChange,
  onTitleBlur,
  onAbortRun,
  onOpenClearDialog,
  onCollapse,
  onAddGroupRole,
  onManageGroupRoles,
  onOpenGroupPlan,
  onSelectTaskState,
}: PanelHeaderProps) {
  const isGroup = panel.kind === "group";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [taskStateMenuOpen, setTaskStateMenuOpen] = useState(false);
  const taskStateMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
      if (!taskStateMenuRef.current?.contains(event.target as Node)) {
        setTaskStateMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const statusDotClass =
    streamStatus === "connected"
      ? "bg-emerald-500"
      : streamStatus === "connecting"
        ? "bg-amber-500"
        : "bg-red-500";

  return (
    <header
      onClick={onCollapse}
      className="shrink-0 border-b border-black/8 bg-[var(--paper)] px-3 py-2 md:px-5 md:py-3"
    >
      <div className="relative flex items-center justify-center">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="打开列表"
          title="打开列表"
          className="absolute left-0 inline-flex h-8 w-8 items-center justify-center rounded-full border border-black/10 text-[var(--ink)] transition hover:border-[var(--accent)] lg:hidden"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14.5 5.5L8 12l6.5 6.5" />
          </svg>
        </button>

        <div className="inline-flex min-w-0 max-w-[70%] items-center gap-2 md:max-w-[50%]">
          <input
            className="h-7 min-w-[2ch] bg-transparent text-center text-sm font-semibold text-[var(--ink)] outline-none"
            style={{
              width: `${(() => {
                const text = title || "";
                const cjk = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uff00-\uffef\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g) || [];
                return Math.max(text.length + cjk.length, 1) + 0.5;
              })()}ch`,
            }}
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            onBlur={onTitleBlur}
          />
          {isGroup ? (
            <div ref={taskStateMenuRef} className="relative shrink-0">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setTaskStateMenuOpen((current) => !current);
                  setMenuOpen(false);
                }}
                className={`inline-flex h-6 items-center justify-center whitespace-nowrap rounded-full border px-2 text-[9px] font-medium md:h-7 md:px-2.5 md:text-[10px] ${getGroupTaskStateClassName(panel.taskState)}`}
                title="点击切换群任务状态"
              >
                <span>{getGroupTaskStateLabel(panel.taskState)}</span>
              </button>

              {taskStateMenuOpen ? (
                <div
                  className="absolute left-1/2 top-8 z-10 min-w-[140px] -translate-x-1/2 rounded-2xl border border-black/10 bg-white p-2 shadow-[0_20px_40px_rgba(15,23,36,0.12)]"
                  onClick={(event) => event.stopPropagation()}
                >
                  {[
                    { value: "in_progress", label: "执行中" },
                    { value: "waiting_input", label: "等待输入" },
                    { value: "blocked", label: "被阻塞" },
                    { value: "pending_review", label: "等待审核" },
                    { value: "completed", label: "已完成" },
                    { value: "idle", label: "空闲" },
                  ].map((option) => {
                    const selected = panel.taskState === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          setTaskStateMenuOpen(false);
                          onSelectTaskState?.(option.value as GroupTaskState);
                        }}
                        className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm transition ${
                          selected
                            ? "bg-[var(--paper-2)] font-semibold text-[var(--ink)]"
                            : "text-[var(--ink)] hover:bg-[var(--paper-2)]"
                        }`}
                      >
                        <span>{option.label}</span>
                        {selected ? <span className="text-[11px] text-[var(--ink-soft)]">当前</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
          {currentAgent?.emoji ? (
            <span className="shrink-0 text-sm leading-none">{currentAgent.emoji}</span>
          ) : null}
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusDotClass}`} />
        </div>

        <div className="absolute right-0 flex items-center gap-1.5 md:gap-2">
          {isGroup ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onManageGroupRoles?.();
              }}
              aria-label="角色管理"
              title="角色管理"
              className="inline-flex h-6 items-center justify-center whitespace-nowrap rounded-full border border-black/10 px-2 text-[9px] font-medium text-[var(--ink)] transition hover:border-[var(--accent)] md:h-7 md:px-2.5 md:text-[10px]"
            >
              角色管理
            </button>
          ) : null}

          <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen((current) => !current);
            }}
            aria-label="更多操作"
            title="更多操作"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-black/10 text-[var(--ink)] transition hover:border-[var(--accent)]"
          >
            <span className="inline-flex items-center justify-center gap-0.5 leading-none">
              <span className="h-1 w-1 rounded-full bg-current" />
              <span className="h-1 w-1 rounded-full bg-current" />
              <span className="h-1 w-1 rounded-full bg-current" />
            </span>
          </button>

          {menuOpen ? (
            <div
              className="absolute right-0 top-9 z-10 min-w-[180px] rounded-2xl border border-black/10 bg-white p-2 shadow-[0_20px_40px_rgba(15,23,36,0.12)]"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="rounded-xl bg-[var(--paper-2)] px-3 py-2 text-xs text-[var(--ink-soft)]">
                <div className="flex items-center justify-between gap-3">
                  <span>连接状态</span>
                  <span className="inline-flex items-center gap-2 text-[var(--ink)]">
                    <span className={`h-2 w-2 rounded-full ${statusDotClass}`} />
                    {streamStatus}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span>消息数</span>
                  <span className="text-[var(--ink)]">{messagesCount}</span>
                </div>
              </div>

              <div className="mt-2 space-y-1">
                {!isGroup && isRunActive ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onAbortRun();
                    }}
                    disabled={isAborting}
                    className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-red-700 transition hover:bg-red-50 disabled:opacity-60"
                  >
                    <span>{isAborting ? "正在终止..." : "停止推理"}</span>
                  </button>
                ) : null}

                {messagesCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenClearDialog();
                    }}
                    className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-[var(--ink)] transition hover:bg-[var(--paper-2)]"
                  >
                    <span>清空消息</span>
                  </button>
                ) : null}

                {isGroup ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        onOpenGroupPlan?.();
                      }}
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] text-[var(--ink)] transition hover:bg-[var(--paper-2)]"
                    >
                      <span>查看 Plan</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        onAddGroupRole?.();
                      }}
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] text-[var(--ink)] transition hover:bg-[var(--paper-2)]"
                    >
                      <span>添加角色</span>
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}
