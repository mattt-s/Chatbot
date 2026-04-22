/**
 * @module task-mode/task-mode-panel-card
 * 任务模式顶层面板组件。
 *
 * 完全独立于聊天模式的 panel-card.tsx。
 * 自行管理 SSE 订阅、消息过滤、任务列表加载、角色管理和双栏布局。
 *
 * 布局：
 *   Desktop：左（对话区 380px）| 右（任务看板 flex-1）
 *   Mobile：顶部 Tab 切换 对话 / 看板
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CreateGroupRoleDialog } from "@/components/create-group-role-dialog";
import type { CreateGroupRoleDialogConfig } from "@/components/create-group-role-dialog";
import { ManageGroupRolesDialog } from "@/components/manage-group-roles-dialog";
import type { ManageGroupRolesDialogConfig } from "@/components/manage-group-roles-dialog";
import type { GroupTaskModeState, GroupTaskStatus, GroupTaskView } from "@/lib/task-mode/types";
import type { AgentView, ChatEventPayload, MessageView, PanelView } from "@/lib/types";
import type { GroupRoleView } from "@/lib/types";
import { applyChatEventToMessages } from "@/lib/utils";
import {
  buildOptimisticUserMessage,
  matchesPanelSession,
} from "@/components/chat-helpers";

import { TaskModeBoard } from "./task-mode-board";
import { TaskModeConversation } from "./task-mode-conversation";

// ─────────────────────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────────────────────

function randomId() {
  return Math.random().toString(36).substring(2, 15);
}

const TERMINAL_STATUSES = new Set<GroupTaskStatus>(["done", "cancelled"]);

function computeGroupState(tasks: GroupTaskView[]): GroupTaskModeState {
  const active = tasks.filter((t) => !TERMINAL_STATUSES.has(t.status));
  if (active.some((t) => t.status === "needs_intervention")) return "needs_user";
  if (
    active.some((t) => t.status === "blocked") &&
    !active.some((t) => t.status === "in_progress")
  )
    return "blocked";
  if (
    active.some((t) =>
      ["assigned", "in_progress", "submitted", "reviewing"].includes(t.status),
    )
  )
    return "in_progress";
  if (active.some((t) => t.status === "created")) return "waiting_dependency";
  return "idle";
}

// ─────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────

interface TaskModePanelCardProps {
  panel: PanelView;
  agents: AgentView[];
  onOpenSidebar?: () => void;
  onPanelReplaced?: (panel: PanelView) => void;
}

// ─────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────

export function TaskModePanelCard({
  panel,
  agents,
  onOpenSidebar,
  onPanelReplaced,
}: TaskModePanelCardProps) {
  const [messages, setMessages] = useState<MessageView[]>(panel.messages ?? []);
  const [tasks, setTasks] = useState<GroupTaskView[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(true);
  const [activeRunId, setActiveRunId] = useState<string | null>(panel.activeRunId ?? null);
  const [streamStatus, setStreamStatus] = useState<"connecting" | "connected" | "closed">(
    "connecting",
  );
  const [groupRoles, setGroupRoles] = useState<GroupRoleView[]>(panel.groupRoles ?? []);
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"chat" | "board">("chat");

  // ── 角色管理对话框 ──
  const [createGroupRoleDialog, setCreateGroupRoleDialog] =
    useState<CreateGroupRoleDialogConfig | null>(null);
  const [manageGroupRolesDialog, setManageGroupRolesDialog] =
    useState<ManageGroupRolesDialogConfig | null>(null);
  const [isCreatingRole, setIsCreatingRole] = useState(false);
  const [createGroupRoleResetToken, setCreateGroupRoleResetToken] = useState(0);

  // ── 菜单 ──
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Stable refs to avoid stale closures in SSE handler
  const activeRunIdRef = useRef<string | null>(activeRunId);
  const messagesRef = useRef<MessageView[]>(messages);
  const leaderRoleIdRef = useRef<string | null>(null);

  useEffect(() => { activeRunIdRef.current = activeRunId; }, [activeRunId]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { setGroupRoles(panel.groupRoles ?? []); }, [panel.groupRoles]);

  // ── 菜单 outside-click 关闭 ──
  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  // Derive leader role from current groupRoles
  const leaderRole = groupRoles.find((r) => r.isLeader && r.enabled) ?? null;
  const leaderRoleId = leaderRole?.id ?? null;
  useEffect(() => { leaderRoleIdRef.current = leaderRoleId; }, [leaderRoleId]);

  // ── Message hydration（初始加载不含消息，mount 后补全）──

  useEffect(() => {
    const shouldHydrate =
      !panel.messagesLoaded && panel.messageCount > 0 && messages.length === 0;
    console.log('[HYDRATION]', { shouldHydrate, messagesLoaded: panel.messagesLoaded, messageCount: panel.messageCount, messagesLen: messages.length, panelId: panel.id });
    if (!shouldHydrate) return;
    let cancelled = false;
    const hydrate = async () => {
      const resp = await fetch(`/api/panels/${panel.id}`, { cache: "no-store" }).catch(() => null);
      console.log('[HYDRATION] fetch resp ok=', resp?.ok, 'cancelled=', cancelled);
      if (!resp?.ok || cancelled) return;
      const payload = (await resp.json().catch(() => null)) as PanelView | null;
      console.log('[HYDRATION] payload messages=', payload?.messages?.length ?? 'null');
      if (!payload || cancelled) return;
      setMessages(payload.messages ?? []);
      if (payload.activeRunId !== undefined) setActiveRunId(payload.activeRunId);
      if (Array.isArray(payload.groupRoles)) setGroupRoles(payload.groupRoles);
    };
    void hydrate();
    return () => { cancelled = true; };
  // 仅在面板 ID 或 messageCount 变化时重新触发，避免循环
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.id, panel.messageCount, panel.messagesLoaded]);

  // ── Task fetch ──

  const fetchTasks = useCallback(async () => {
    setIsLoadingTasks(true);
    try {
      const resp = await fetch(`/api/panels/${panel.id}/group-tasks`, { cache: "no-store" });
      if (!resp.ok) return;
      const data = (await resp.json().catch(() => null)) as { tasks?: GroupTaskView[] } | null;
      if (Array.isArray(data?.tasks)) {
        setTasks(data.tasks);
      }
    } finally {
      setIsLoadingTasks(false);
    }
  }, [panel.id]);

  useEffect(() => { void fetchTasks(); }, [fetchTasks]);

  // ── 角色管理 ──

  const refreshGroupRoles = useCallback(async (): Promise<GroupRoleView[] | null> => {
    const verify = manageGroupRolesDialog?.open ? "?verify=1" : "";
    const resp = await fetch(`/api/panels/${panel.id}/group-roles${verify}`, {
      cache: "no-store",
    }).catch(() => null);
    if (!resp?.ok) return null;
    const payload = (await resp.json().catch(() => null)) as
      | { roles?: GroupRoleView[] }
      | null;
    const roles = Array.isArray(payload?.roles) ? payload.roles : null;
    if (roles) {
      setGroupRoles(roles);
      setManageGroupRolesDialog((prev) => (prev ? { ...prev, roles } : prev));
    }
    return roles ?? null;
  }, [manageGroupRolesDialog?.open, panel.id]);

  // 角色管理对话框打开时轮询角色状态
  useEffect(() => {
    if (!manageGroupRolesDialog?.open) return;
    void refreshGroupRoles();
    const timer = window.setInterval(() => void refreshGroupRoles(), 2_000);
    return () => window.clearInterval(timer);
  }, [manageGroupRolesDialog?.open, refreshGroupRoles]);

  async function handleCreateGroupRole(input: {
    panelId: string;
    title: string;
    agentId: string;
  }) {
    setIsCreatingRole(true);
    const resp = await fetch(`/api/panels/${input.panelId}/group-roles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: input.title, agentId: input.agentId }),
    });
    if (resp.ok) {
      await refreshGroupRoles();
      setCreateGroupRoleResetToken((n) => n + 1);
    }
    setIsCreatingRole(false);
  }

  async function handleDeleteGroupRole(panelId: string, roleId: string) {
    const resp = await fetch(`/api/panels/${panelId}/group-roles/${roleId}`, {
      method: "DELETE",
    });
    if (resp.ok) {
      await refreshGroupRoles();
      setManageGroupRolesDialog((prev) =>
        prev ? { ...prev, roles: groupRoles.filter((r) => r.id !== roleId) } : null,
      );
    }
  }

  async function handleToggleLeader(
    panelId: string,
    roleId: string,
    currentlyLeader: boolean,
  ) {
    const method = currentlyLeader ? "DELETE" : "PUT";
    const resp = await fetch(`/api/panels/${panelId}/group-roles/${roleId}/leader`, {
      method,
    });
    if (resp.ok) {
      const freshRoles = await refreshGroupRoles();
      if (freshRoles) {
        setManageGroupRolesDialog((prev) =>
          prev ? { ...prev, roles: freshRoles } : null,
        );
      }
    }
  }

  async function handleAbortGroupRole(panelId: string, roleId: string) {
    const markAborting = (roles: GroupRoleView[]) =>
      roles.map((r) =>
        r.id === roleId ? { ...r, runtimeStatus: "aborting" as const } : r,
      );
    setGroupRoles((cur) => markAborting(cur));
    setManageGroupRolesDialog((prev) =>
      prev ? { ...prev, roles: markAborting(prev.roles) } : prev,
    );

    const resp = await fetch(`/api/panels/${panelId}/group-roles/${roleId}/abort`, {
      method: "POST",
    });
    if (!resp.ok && resp.status !== 202) {
      const p = (await resp.json().catch(() => null)) as { error?: string } | null;
      setErrorMessage(p?.error ?? "终止角色推理失败。");
    }
    const freshRoles = await refreshGroupRoles();
    if (freshRoles) {
      setManageGroupRolesDialog((prev) => (prev ? { ...prev, roles: freshRoles } : null));
    }
  }

  // ── Chat SSE subscription（对话区：用户 ↔ leader）──

  useEffect(() => {
    const source = new EventSource(`/api/panels/${panel.id}/stream`);
    setStreamStatus("connecting");

    source.addEventListener("hello", () => setStreamStatus("connected"));

    source.addEventListener("chat", (e: MessageEvent<string>) => {
      const payload = JSON.parse(e.data) as ChatEventPayload;

      if (
        !matchesPanelSession(
          payload.sessionKey,
          panel.sessionKey,
          panel.kind,
          panel.id,
        )
      ) {
        return;
      }

      const { groupRoleId } = payload;
      const currentLeaderRoleId = leaderRoleIdRef.current;

      // 只展示用户消息和 leader 消息
      const isConversationVisible = !groupRoleId || groupRoleId === currentLeaderRoleId;

      // 过滤空壳占位消息
      const msgText =
        typeof payload.message === "object" &&
        payload.message !== null &&
        "text" in payload.message &&
        typeof (payload.message as Record<string, unknown>).text === "string"
          ? ((payload.message as Record<string, unknown>).text as string)
          : "";
      const isPlaceholder =
        payload.state !== "delta" &&
        !msgText.trim() &&
        !payload.errorMessage &&
        isConversationVisible;

      if (isConversationVisible && !isPlaceholder) {
        setMessages((current) => applyChatEventToMessages(current, payload));
      }

      if (payload.state === "delta") {
        setActiveRunId(payload.runId);
      } else if (
        payload.state === "final" ||
        payload.state === "aborted" ||
        payload.state === "error"
      ) {
        setActiveRunId(null);
      }
    });

    const onError = () => setStreamStatus("closed");
    source.addEventListener("error", onError);
    source.onerror = onError;

    return () => source.close();
  }, [panel.id, panel.kind, panel.sessionKey]);

  // ── Tasks SSE subscription（看板：任意任务变更即推送）──

  useEffect(() => {
    const source = new EventSource(`/api/panels/${panel.id}/group-tasks/stream`);

    source.addEventListener("tasks_updated", () => {
      void fetchTasks();
    });

    // 连接断开后自动重连（浏览器 EventSource 默认会重连，此处仅标记状态）
    source.onerror = () => {
      // 不改变 streamStatus（那是 chat SSE 的状态），静默重连即可
    };

    return () => source.close();
  }, [panel.id, fetchTasks]);

  // ── Send message ──

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isSending) return;

      const messageId = randomId();
      const optimistic = buildOptimisticUserMessage({
        id: messageId,
        text: trimmed,
        files: [],
      });

      setMessages((current) => [...current, optimistic]);
      setIsSending(true);
      setErrorMessage(null);

      const body = new FormData();
      body.append("panelId", panel.id);
      body.append("messageId", messageId);
      body.append("message", trimmed);

      const resp = await fetch("/api/customchat/webhook", {
        method: "POST",
        body,
      }).catch((err) => {
        const e = err instanceof Error ? err.message : "发送失败";
        return { ok: false, json: async () => ({ error: e }) } as unknown as Response;
      });

      const data = await resp.json().catch(() => null);

      if (!resp.ok) {
        setMessages((current) => current.filter((m) => m.id !== messageId));
        setErrorMessage(data?.error ?? "发送失败。");
      } else if (data?.userMessage) {
        setMessages((current) =>
          current.map((m) =>
            m.id === messageId ? (data.userMessage as MessageView) : m,
          ),
        );
      }

      if (data?.runId) setActiveRunId((data.runId as string).trim() || null);
      setIsSending(false);
    },
    [isSending, panel.id],
  );

  // ── Notify parent ──

  const onPanelReplacedRef = useRef(onPanelReplaced);
  const panelRef = useRef(panel);
  useEffect(() => { onPanelReplacedRef.current = onPanelReplaced; }, [onPanelReplaced]);
  useEffect(() => { panelRef.current = panel; }, [panel]);

  useEffect(() => {
    onPanelReplacedRef.current?.({
      ...panelRef.current,
      activeRunId,
      messageCount: messages.length,
      latestMessagePreview:
        messages.length > 0
          ? (messages[messages.length - 1]?.text?.slice(0, 60) ?? null)
          : null,
      messages,
      groupRoles,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, messages, groupRoles]);

  // ── Derived state ──

  const isRunActive = Boolean(activeRunId);
  const groupState = computeGroupState(tasks);

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      {/* ── Header ── */}
      <header className="shrink-0 border-b border-black/8 bg-[var(--paper)] px-3 py-2 md:px-5 md:py-2.5">
        <div className="relative flex items-center justify-center">
          {/* Mobile: 侧边栏按钮 */}
          <button
            type="button"
            onClick={onOpenSidebar}
            aria-label="打开列表"
            className="absolute left-0 inline-flex h-8 w-8 items-center justify-center rounded-full border border-black/10 text-[var(--ink)] transition hover:border-[var(--accent)] lg:hidden"
          >
            <svg
              aria-hidden
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

          {/* 标题 + 模式徽标 */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--ink)]">{panel.title}</span>
            <span className="rounded-full border border-black/10 bg-[var(--paper-2)] px-2 py-0.5 text-[10px] font-medium text-[var(--ink-soft)]">
              🗂 任务模式
            </span>
          </div>

          {/* 右侧操作区 */}
          <div className="absolute right-0 flex items-center gap-1.5">
            {/* Mobile: Tab 切换 */}
            <div className="flex overflow-hidden rounded-full border border-black/10 md:hidden">
              {(["chat", "board"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setMobileTab(tab)}
                  className={[
                    "px-3 py-1 text-[11px] font-medium transition",
                    mobileTab === tab
                      ? "bg-[var(--ink)] text-white"
                      : "text-[var(--ink-soft)] hover:text-[var(--ink)]",
                  ].join(" ")}
                >
                  {tab === "chat" ? "对话" : "看板"}
                </button>
              ))}
            </div>

            {/* 角色管理按钮（Desktop 常驻） */}
            <button
              type="button"
              onClick={() =>
                setManageGroupRolesDialog({ open: true, panelId: panel.id, roles: groupRoles })
              }
              className="hidden md:inline-flex h-6 items-center justify-center whitespace-nowrap rounded-full border border-black/10 px-2 text-[9px] font-medium text-[var(--ink)] transition hover:border-[var(--accent)] md:h-7 md:px-2.5 md:text-[10px]"
            >
              角色管理
            </button>

            {/* ⋯ 更多菜单 */}
            <div ref={menuRef} className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((prev) => !prev);
                }}
                aria-label="更多操作"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-black/10 text-[var(--ink)] transition hover:border-[var(--accent)]"
              >
                <span className="inline-flex items-center justify-center gap-0.5 leading-none">
                  <span className="h-1 w-1 rounded-full bg-current" />
                  <span className="h-1 w-1 rounded-full bg-current" />
                  <span className="h-1 w-1 rounded-full bg-current" />
                </span>
              </button>

              {menuOpen && (
                <div
                  className="absolute right-0 top-9 z-10 min-w-[180px] rounded-2xl border border-black/10 bg-white p-2 shadow-[0_20px_40px_rgba(15,23,36,0.12)]"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* 连接状态 */}
                  <div className="rounded-xl bg-[var(--paper-2)] px-3 py-2 text-xs text-[var(--ink-soft)]">
                    <div className="flex items-center justify-between gap-3">
                      <span>连接状态</span>
                      <span className="inline-flex items-center gap-1.5 text-[var(--ink)]">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            streamStatus === "connected"
                              ? "bg-emerald-500"
                              : streamStatus === "connecting"
                                ? "bg-amber-400"
                                : "bg-red-400"
                          }`}
                        />
                        {streamStatus}
                      </span>
                    </div>
                  </div>

                  <div className="mt-2 space-y-1">
                    {/* 添加角色 */}
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        setCreateGroupRoleDialog({ open: true, panelId: panel.id });
                      }}
                      className="flex w-full items-center rounded-xl px-3 py-2 text-[13px] text-[var(--ink)] transition hover:bg-[var(--paper-2)]"
                    >
                      添加角色
                    </button>

                    {/* 角色管理（Mobile 入口） */}
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        setManageGroupRolesDialog({
                          open: true,
                          panelId: panel.id,
                          roles: groupRoles,
                        });
                      }}
                      className="flex w-full items-center rounded-xl px-3 py-2 text-[13px] text-[var(--ink)] transition hover:bg-[var(--paper-2)] md:hidden"
                    >
                      角色管理
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1">
        {/* 对话区 */}
        <div
          className={[
            "flex flex-col border-r border-black/8",
            "md:w-[380px] md:shrink-0",
            mobileTab === "chat" ? "flex-1 md:flex-none" : "hidden md:flex",
          ].join(" ")}
        >
          <TaskModeConversation
            messages={messages}
            leaderRoleId={leaderRoleId}
            isRunActive={isRunActive}
            isSending={isSending}
            errorMessage={errorMessage}
            streamStatus={streamStatus}
            onSend={handleSend}
            onClearError={() => setErrorMessage(null)}
          />
        </div>

        {/* 任务看板 */}
        <div
          className={[
            "min-w-0 flex-1",
            mobileTab === "board" ? "flex" : "hidden md:flex",
          ].join(" ")}
        >
          <TaskModeBoard
            tasks={tasks}
            groupState={groupState}
            isLoading={isLoadingTasks}
            panelId={panel.id}
            onRefresh={() => void fetchTasks()}
          />
        </div>
      </div>

      {/* ── 角色管理对话框 ── */}
      <CreateGroupRoleDialog
        config={createGroupRoleDialog}
        agents={agents}
        isSubmitting={isCreatingRole}
        resetToken={createGroupRoleResetToken}
        onClose={() => { if (!isCreatingRole) setCreateGroupRoleDialog(null); }}
        onCreate={handleCreateGroupRole}
      />

      <ManageGroupRolesDialog
        config={manageGroupRolesDialog}
        onClose={() => setManageGroupRolesDialog(null)}
        onDeleteRole={handleDeleteGroupRole}
        onToggleLeader={handleToggleLeader}
        onAbortRole={handleAbortGroupRole}
      />
    </div>
  );
}
