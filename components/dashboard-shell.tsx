/**
 * @file 应用主布局外壳组件。
 *
 * 包含左侧角色列表侧边栏和右侧聊天面板的完整仪表盘布局。
 * 管理角色的增删、Agent 刷新、侧边栏展开/收起、登出等全局操作。
 */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type {
  AgentView,
  DashboardData,
  PanelView,
} from "@/lib/types";

import { ConfirmDialog } from "./confirm-dialog";
import type { ConfirmDialogConfig } from "./confirm-dialog";
import { CreateGroupDialog } from "./create-group-dialog";
import type { CreateGroupDialogConfig } from "./create-group-dialog";
import { CreateRoleDialog } from "./create-role-dialog";
import type { CreateRoleDialogConfig } from "./create-role-dialog";
import { AppSettingsDialog } from "./app-settings-dialog";
import type { AppSettingsDialogConfig } from "./app-settings-dialog";
import { PanelCard } from "./panel-card";
import { PanelSidebarItem } from "./panel-sidebar-item";

const ACTIVE_PANEL_STORAGE_KEY = "chatbot.active-panel-id";

/**
 * 应用主布局外壳。
 *
 * 渲染左侧角色侧边栏 + 右侧活跃面板的双栏布局。
 * 管理面板列表的 CRUD 操作、Agent 列表刷新、用户登出，
 * 并在移动端支持侧边栏的滑入/滑出。
 *
 * @param props.initialData - 服务端渲染时提供的初始仪表盘数据
 */
export function DashboardShell({ initialData }: { initialData: DashboardData }) {
  const [panels, setPanels] = useState(initialData.panels);
  const [agents, setAgents] = useState(initialData.agents);
  const [isCreating, setIsCreating] = useState(false);
  const [channel, setChannel] = useState(initialData.channel);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogConfig | null>(null);
  const [createRoleDialog, setCreateRoleDialog] = useState<CreateRoleDialogConfig | null>(null);
  const [createGroupDialog, setCreateGroupDialog] = useState<CreateGroupDialogConfig | null>(null);
  const [settingsDialog, setSettingsDialog] = useState<AppSettingsDialogConfig | null>(null);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);

  useEffect(() => {
    setPanels(initialData.panels);
    setAgents(initialData.agents);
    setChannel(initialData.channel);
  }, [initialData]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storedPanelId = window.localStorage.getItem(ACTIVE_PANEL_STORAGE_KEY);
    const preferredPanelId =
      storedPanelId && initialData.panels.some((panel) => panel.id === storedPanelId)
        ? storedPanelId
        : initialData.panels[0]?.id ?? null;

    setActivePanelId(preferredPanelId);
  }, [initialData.panels]);

  const refreshAgents = useCallback(async (forceRefresh = false) => {
    const url = new URL("/api/agents", window.location.origin);
    url.searchParams.set("ts", Date.now().toString());
    if (forceRefresh) {
      url.searchParams.set("refresh", "true");
    }

    const response = await fetch(url.toString(), {
      cache: "no-store",
    }).catch(() => null);
    if (!response?.ok) {
      return null;
    }

    const payload = (await response.json().catch(() => null)) as
      | { agents?: AgentView[] }
      | null;
    if (!payload?.agents) {
      return null;
    }

    setAgents(payload.agents);
    return payload.agents;
  }, []);

  useEffect(() => {
    // If we have initial agents from SSR, don't immediately refresh to avoid flickering.
    if (initialData.agents.length > 0) {
      return;
    }
    void refreshAgents();
  }, [refreshAgents, initialData.agents.length]);

  useEffect(() => {
    setActivePanelId((current) =>
      panels.some((panel) => panel.id === current) ? current : panels[0]?.id ?? null,
    );
  }, [panels]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (activePanelId) {
      window.localStorage.setItem(ACTIVE_PANEL_STORAGE_KEY, activePanelId);
    } else {
      window.localStorage.removeItem(ACTIVE_PANEL_STORAGE_KEY);
    }
  }, [activePanelId]);

  const userDisplayLabel = useMemo(() => {
    const value = initialData.user.displayName?.trim() || "";
    if (!value) {
      return "管理员";
    }
    return value.includes("@") ? "管理员" : value;
  }, [initialData.user.displayName]);

  async function handleLogout() {
    await fetch("/api/auth/logout", {
      method: "POST",
    });
    window.location.href = "/login";
  }

  async function openCreatePanelDialog() {
    const currentAgents = agents.length > 0
      ? agents
      : [{ id: "main", name: "Main", emoji: null, avatarUrl: null, theme: null }];
    const suggestedAgentId =
      panels.find((panel) => panel.id === activePanelId)?.agentId ||
      currentAgents[0]?.id ||
      "main";
    setCreateRoleDialog({
      open: true,
      initialTitle: `Role ${panels.length + 1}`,
      initialAgentId: suggestedAgentId,
    });

    void refreshAgents(true);
  }

  async function createPanel(input: { title: string; agentId: string }) {
    setIsCreating(true);

    const response = await fetch("/api/panels", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId: input.agentId,
        title: input.title,
      }),
    });

    const payload = (await response.json().catch(() => null)) as PanelView | null;
    if (response.ok && payload) {
      setPanels((current) => [...current, payload]);
      setActivePanelId(payload.id);
      setSidebarOpen(false);
      setCreateRoleDialog(null);
    }
    setIsCreating(false);
  }

  async function createGroup(input: { title: string }) {
    setIsCreatingGroup(true);
    const response = await fetch("/api/panels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "",
        title: input.title,
        kind: "group",
      }),
    });
    const payload = (await response.json().catch(() => null)) as PanelView | null;
    if (response.ok && payload) {
      setPanels((current) => [...current, payload]);
      setActivePanelId(payload.id);
      setSidebarOpen(false);
      setCreateGroupDialog(null);
    }
    setIsCreatingGroup(false);
  }

  async function deletePanel(panelId: string) {
    const response = await fetch(`/api/panels/${panelId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      return;
    }

    setPanels((current) => current.filter((panel) => panel.id !== panelId));
  }

  function openSidebarDeleteDialog(panelId: string) {
    const targetPanel = panels.find((panel) => panel.id === panelId);
    const isGroup = targetPanel?.kind === "group";
    setConfirmDialog({
      title: isGroup ? "确认删除群组" : "确认删除角色",
      description: isGroup
        ? `群组"${targetPanel?.title ?? "未命名群组"}"及其所有角色和消息会被永久删除。`
        : `角色"${targetPanel?.title ?? "未命名角色"}"会从当前页面和服务器记录里删除，同时清掉本地保存的消息与附件。`,
      confirmLabel: "确认删除",
      tone: "danger",
      onConfirm: () => deletePanel(panelId),
    });
  }

  const agentNameById = useMemo(
    () =>
      new Map(
        agents.map((agent) => [
          agent.id,
          `${agent.emoji ? `${agent.emoji} ` : ""}${agent.name}`,
        ]),
      ),
    [agents],
  );
  const handlePanelReplaced = useCallback((nextPanel: PanelView) => {
    setPanels((current) =>
      current.map((currentPanel) =>
        currentPanel.id === nextPanel.id ? nextPanel : currentPanel,
      ),
    );
  }, []);
  const activePanel = panels.find((panel) => panel.id === activePanelId) ?? null;

  return (
    <main
      className="h-[100dvh] w-full overflow-hidden bg-[var(--canvas)] pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] md:p-4"
    >
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="关闭角色列表"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/24 backdrop-blur-[1px] lg:hidden"
        />
      ) : null}

      <div className="flex h-full w-full gap-0 md:mx-auto md:max-w-[1680px] md:gap-4">
        <aside
          className={`fixed inset-y-0 left-0 z-40 flex w-[286px] max-w-[88vw] flex-col rounded-none border border-black/10 bg-[var(--paper)] p-3 shadow-[0_24px_80px_rgba(12,18,28,0.12)] transition-transform duration-200 lg:static lg:w-[320px] lg:max-w-none lg:translate-x-0 lg:rounded-[30px] md:inset-y-3 md:left-3 md:max-w-[calc(100vw-1.5rem)] md:rounded-[30px] ${
            sidebarOpen ? "translate-x-0" : "-translate-x-[calc(100%+1rem)]"
          }`}
        >
          <div className="flex items-center justify-between gap-3 px-2 py-1">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--ink-soft)]">
                roles
              </div>
              <div className="text-xl font-semibold text-[var(--ink)]">角色列表</div>
            </div>

            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-black/10 text-lg text-[var(--ink-soft)] transition hover:border-[var(--accent)] lg:hidden"
            >
              ×
            </button>
          </div>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={openCreatePanelDialog}
              className="flex-1 rounded-[22px] border border-black/8 bg-[var(--paper-2)] px-4 py-3 text-sm font-semibold text-[var(--ink)] shadow-[0_10px_24px_rgba(15,23,36,0.05)] transition hover:border-[var(--accent)] hover:bg-white disabled:opacity-60"
              disabled={isCreating}
            >
              {isCreating ? "新增中..." : "新增角色"}
            </button>
            <button
              type="button"
              onClick={() => setCreateGroupDialog({ open: true })}
              className="flex-1 rounded-[22px] border border-black/8 bg-[var(--paper-2)] px-4 py-3 text-sm font-semibold text-[var(--ink)] shadow-[0_10px_24px_rgba(15,23,36,0.05)] transition hover:border-[var(--accent)] hover:bg-white disabled:opacity-60"
              disabled={isCreatingGroup}
            >
              {isCreatingGroup ? "新增中..." : "新增群组"}
            </button>
          </div>

          <div className="touch-scroll mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {panels.map((panel) => (
              <PanelSidebarItem
                key={panel.id}
                panel={panel}
                agentLabel={agentNameById.get(panel.agentId) ?? panel.agentId}
                agentEmoji={agents.find((a) => a.id === panel.agentId)?.emoji}
                agentAvatarUrl={agents.find((a) => a.id === panel.agentId)?.avatarUrl}
                agents={agents}
                isActive={panel.id === activePanelId}
                onSelect={() => {
                  setActivePanelId(panel.id);
                  setSidebarOpen(false);
                }}
                onDelete={() => {
                  openSidebarDeleteDialog(panel.id);
                }}
              />
            ))}
          </div>

          <div className="mt-3 rounded-[24px] bg-[var(--paper-2)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[var(--ink)]">
                  {userDisplayLabel}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ink-soft)]">
                  <span
                    className="h-2.5 w-2.5 rounded-full bg-emerald-500"
                  />
                  {channel.label}
                </div>
              </div>

              <span className="rounded-full bg-white px-3 py-1.5 text-xs text-[var(--ink-soft)]">
                {panels.length} roles
              </span>
            </div>

            {channel.errorMessage ? (
              <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {channel.errorMessage}
              </div>
            ) : null}

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSettingsDialog({ open: true })}
                className="flex-1 rounded-full border border-black/10 px-3 py-2 text-sm font-medium text-[var(--ink)] transition hover:border-[var(--accent)]"
              >
                设置
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="flex-1 rounded-full border border-black/10 px-3 py-2 text-sm font-medium text-[var(--ink)] transition hover:border-[var(--accent)]"
              >
                退出
              </button>
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--paper)] md:rounded-[32px] md:border md:border-black/10 md:shadow-[0_24px_80px_rgba(12,18,28,0.08)]">
          {activePanel ? (
            <div className="h-full min-h-0">
              <div key={activePanel.id} className="h-full min-h-0">
                <PanelCard
                  panel={activePanel}
                  agents={agents}
                  onOpenSidebar={() => setSidebarOpen(true)}
                  onPanelReplaced={handlePanelReplaced}
                />
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-md rounded-[28px] border border-dashed border-black/10 bg-white/70 px-6 py-10 text-center">
                <div className="text-lg font-semibold text-[var(--ink)]">还没有角色</div>
                <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
                  先创建一个角色，再开始对话。
                </p>
                <button
                  type="button"
                  onClick={openCreatePanelDialog}
                  className="mt-5 rounded-full bg-[var(--ink)] px-5 py-2.5 text-sm font-semibold text-[var(--paper)] transition hover:opacity-90"
                >
                  新增角色
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
      <ConfirmDialog
        config={confirmDialog}
        onClose={() => setConfirmDialog(null)}
      />
      <CreateRoleDialog
        config={createRoleDialog}
        agents={agents}
        isSubmitting={isCreating}
        onClose={() => {
          if (!isCreating) {
            setCreateRoleDialog(null);
          }
        }}
        onCreate={createPanel}
      />
      <CreateGroupDialog
        config={createGroupDialog}
        isSubmitting={isCreatingGroup}
        onClose={() => {
          if (!isCreatingGroup) {
            setCreateGroupDialog(null);
          }
        }}
        onCreate={createGroup}
      />
      <AppSettingsDialog
        config={settingsDialog}
        onClose={() => setSettingsDialog(null)}
        onSaved={() => undefined}
      />
    </main>
  );
}
