/**
 * @file 聊天面板卡片组件。
 *
 * 单个 Role/面板的完整聊天界面，集成了消息列表、输入框、头部状态栏、
 * SSE 实时订阅、消息发送/终止/清空等核心交互逻辑。
 */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  AgentView,
  ChatEventPayload,
  MessageView,
  PanelView,
} from "@/lib/types";

import type { GroupRoleView } from "@/lib/types";

import {
  applyChatEventToMessages,
  buildOptimisticUserMessage,
  matchesPanelSession,
  normalizeChatEventRunId,
} from "./chat-helpers";
import { ConfirmDialog } from "./confirm-dialog";
import type { ConfirmDialogConfig } from "./confirm-dialog";
import { CreateGroupRoleDialog } from "./create-group-role-dialog";
import type { CreateGroupRoleDialogConfig } from "./create-group-role-dialog";
import { GroupPlanDialog } from "./group-plan-dialog";
import { ImageViewer } from "./image-viewer";
import { ManageGroupRolesDialog } from "./manage-group-roles-dialog";
import type { ManageGroupRolesDialogConfig } from "./manage-group-roles-dialog";
import { MessageList } from "./message-list";
import { PanelComposer } from "./panel-composer";
import { PanelHeader } from "./panel-header";

/**
 * PanelCard 的 Props。
 *
 * @property panel - 面板数据
 * @property agents - Agent 列表（用于匹配当前面板的 Agent 信息）
 * @property onOpenSidebar - 打开侧边栏的回调
 * @property onPanelReplaced - 面板数据更新后的回调（通知父组件同步）
 */
interface PanelCardProps {
  panel: PanelView;
  agents: AgentView[];
  onOpenSidebar: () => void;
  onPanelReplaced: (nextPanel: PanelView) => void;
}

function randomId() {
  return Math.random().toString(36).substring(2, 15);
}

function buildLatestMessagePreview(messages: MessageView[]) {
  const latestMessage = messages[messages.length - 1];
  if (!latestMessage) {
    return null;
  }

  if (latestMessage.text.trim()) {
    return latestMessage.text.trim();
  }

  if (latestMessage.role === "assistant" && latestMessage.draft) {
    return "正在生成回复...";
  }

  if (latestMessage.attachments.length > 0) {
    return "已发送附件";
  }

  return null;
}

/**
 * 聊天面板卡片。
 *
 * 渲染完整的单面板聊天界面：头部状态栏 + 消息列表 + 输入框。
 * 内部通过 SSE 订阅实时接收 Gateway 推送的聊天事件，
 * 并管理消息发送、终止推理、清空消息、图片预览等交互。
 *
 * @param props.panel - 面板数据
 * @param props.agents - 可用 Agent 列表
 * @param props.onOpenSidebar - 打开侧边栏回调
 * @param props.onPanelReplaced - 面板更新回调
 */
export function PanelCard({
  panel,
  agents,
  onOpenSidebar,
  onPanelReplaced,
}: PanelCardProps) {
  const [messages, setMessages] = useState<MessageView[]>(panel.messages);
  const [draft, setDraft] = useState("");
  const [selectedMentionRoleIds, setSelectedMentionRoleIds] = useState<string[]>([]);
  const [title, setTitle] = useState(panel.title);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [panelAgentId, setPanelAgentId] = useState(panel.agentId);
  const [composerFocused, setComposerFocused] = useState(false);
  const [streamStatus, setStreamStatus] = useState<
    "connecting" | "connected" | "closed"
  >("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(
    panel.activeRunId,
  );
  const [isMobileInputMode, setIsMobileInputMode] = useState(false);
  const [mobileComposerExpanded, setMobileComposerExpanded] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogConfig | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [groupRoles, setGroupRoles] = useState<GroupRoleView[]>(panel.groupRoles ?? []);
  const [createGroupRoleDialog, setCreateGroupRoleDialog] = useState<CreateGroupRoleDialogConfig | null>(null);
  const [manageGroupRolesDialog, setManageGroupRolesDialog] = useState<ManageGroupRolesDialogConfig | null>(null);
  const [isCreatingRole, setIsCreatingRole] = useState(false);
  const [createGroupRoleResetToken, setCreateGroupRoleResetToken] = useState(0);
  const [groupPlanDialogOpen, setGroupPlanDialogOpen] = useState(false);
  const [panelMessagesReady, setPanelMessagesReady] = useState(
    panel.messagesLoaded && (panel.messageCount === 0 || panel.messages.length > 0),
  );

  const activeRunIdRef = useRef<string | null>(panel.activeRunId);
  const messagesRef = useRef<MessageView[]>(panel.messages);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const hasComposerContent =
    draft.trim().length > 0 ||
    selectedFiles.length > 0 ||
    selectedMentionRoleIds.length > 0;

  useEffect(() => {
    setTitle(panel.title);
  }, [panel.title]);

  useEffect(() => {
    setPanelAgentId(panel.agentId);
  }, [panel.agentId]);

  useEffect(() => {
    setActiveRunId(panel.activeRunId);
  }, [panel.activeRunId]);

  useEffect(() => {
    setGroupRoles(panel.groupRoles ?? []);
  }, [panel.groupRoles]);

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
    if (!activeRunId) setIsAborting(false);
  }, [activeRunId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const shouldHydratePanel =
      !panelMessagesReady || (panel.messageCount > 0 && panel.messages.length === 0);
    if (!shouldHydratePanel) return;
    let cancelled = false;
    const hydratePanel = async () => {
      const resp = await fetch(`/api/panels/${panel.id}`, { cache: "no-store" }).catch(() => null);
      if (!resp?.ok || cancelled) return;
      const payload = (await resp.json().catch(() => null)) as PanelView | null;
      if (!payload || cancelled) return;
      onPanelReplaced(payload);
      setPanelMessagesReady(true);
      setMessages(payload.messages);
      setTitle(payload.title);
      setPanelAgentId(payload.agentId);
      setActiveRunId(payload.activeRunId);
      setGroupRoles(payload.groupRoles ?? []);
    };
    void hydratePanel();
    return () => { cancelled = true; };
  }, [
    onPanelReplaced,
    panel.id,
    panel.messageCount,
    panel.messages.length,
    panelMessagesReady,
  ]);

  useEffect(() => {
    if (messages.length > 0 && !panelMessagesReady) {
      setPanelMessagesReady(true);
    }
  }, [messages.length, panelMessagesReady]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(max-width: 768px), (pointer: coarse)");
    const sync = () => setIsMobileInputMode(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const sync = () => {
      const dist = list.scrollHeight - list.clientHeight - list.scrollTop;
      const near = dist <= 80;
      shouldStickToBottomRef.current = near;
      setShowScrollButton(!near && dist > 200);
    };
    sync();
    list.addEventListener("scroll", sync, { passive: true });
    return () => list.removeEventListener("scroll", sync);
  }, []);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
  }, []);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) {
      shouldStickToBottomRef.current = true;
      setShowScrollButton(false);
      requestAnimationFrame(() => list.scrollTo({ top: list.scrollHeight, behavior: "auto" }));
    }
  }, [panel.id]);

  useEffect(() => {
    const list = messageListRef.current;
    if (list && shouldStickToBottomRef.current) {
      list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
    }
  }, [messages]);

  const panelCacheBase = useMemo(
    () => ({
      id: panel.id,
      title: panel.title,
      agentId: panel.agentId,
      sessionKey: panel.sessionKey,
      kind: panel.kind,
      taskState: panel.taskState,
      groupPlan: panel.groupPlan,
      userRoleName: panel.userRoleName,
      assistantRoleName: panel.assistantRoleName,
      createdAt: panel.createdAt,
      updatedAt: panel.updatedAt,
    }),
    [
      panel.agentId,
      panel.assistantRoleName,
      panel.createdAt,
      panel.id,
      panel.kind,
      panel.groupPlan,
      panel.sessionKey,
      panel.taskState,
      panel.title,
      panel.updatedAt,
      panel.userRoleName,
    ],
  );

  useEffect(() => {
    if (!panelMessagesReady) {
      return;
    }

    onPanelReplaced({
      ...panelCacheBase,
      activeRunId,
      messageCount: messages.length,
      latestMessagePreview: buildLatestMessagePreview(messages),
      messagesLoaded: true,
      messages,
      // groupRoles 由 refreshPanelMeta/refreshGroupRoles 这些显式刷新入口同步父级，
      // 这里只沿用当前 panel prop，避免“prop -> local state -> parent”形成回写震荡。
      groupRoles: panel.groupRoles ?? [],
    });
  }, [
    activeRunId,
    messages,
    onPanelReplaced,
    panel.groupRoles,
    panelCacheBase,
    panelMessagesReady,
  ]);

  useEffect(() => {
    const composer = composerFormRef.current;
    if (!composer || typeof ResizeObserver === "undefined") {
      return;
    }

    let lastHeight = Math.round(composer.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const nextHeight = Math.round(entries[0]?.contentRect.height ?? composer.getBoundingClientRect().height);
      if (nextHeight === lastHeight) {
        return;
      }
      lastHeight = nextHeight;

      if (!shouldStickToBottomRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        const list = messageListRef.current;
        if (!list) {
          return;
        }
        list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
        setShowScrollButton(false);
      });
    });

    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollTo({ top: messageListRef.current.scrollHeight, behavior: "smooth" });
  }, []);

  const refreshPanelMeta = useCallback(async () => {
    const resp = await fetch(`/api/panels/${panel.id}`, { cache: "no-store" }).catch(() => null);
    if (!resp?.ok) {
      return;
    }
    const payload = (await resp.json().catch(() => null)) as PanelView | null;
    if (!payload) {
      return;
    }
    onPanelReplaced({
      ...payload,
      messages: messagesRef.current,
      messagesLoaded: true,
    });
  }, [onPanelReplaced, panel.id]);

  useEffect(() => {
    const source = new EventSource(`/api/panels/${panel.id}/stream`);
    setStreamStatus("connecting");
    source.addEventListener("hello", () => setStreamStatus("connected"));
    source.addEventListener("chat", (e: MessageEvent<string>) => {
      const payload = JSON.parse(e.data) as ChatEventPayload;
      if (!matchesPanelSession(payload.sessionKey, panel.sessionKey, panel.kind, panel.id)) return;
      
      const runtimeRunId = activeRunIdRef.current;
      const normalizedPayload = normalizeChatEventRunId(messagesRef.current, payload, runtimeRunId);
      const runtimeLookupRunId = (runtimeRunId && runtimeRunId !== normalizedPayload.runId && 
        (normalizedPayload.state === "final" || normalizedPayload.state === "aborted" || normalizedPayload.state === "error"))
        ? runtimeRunId : normalizedPayload.runId;

      setMessages((current) => applyChatEventToMessages(current, normalizedPayload));
      if (normalizedPayload.state === "delta") setActiveRunId(runtimeLookupRunId);
      if (["final", "aborted", "error"].includes(normalizedPayload.state)) {
        setActiveRunId(null);
        if (panel.kind === "group") {
          void refreshPanelMeta();
        }
      }
    });
    const err = () => setStreamStatus("closed");
    source.addEventListener("error", err);
    source.onerror = err;
    return () => { source.close(); };
  }, [panel.id, panel.kind, panel.sessionKey, refreshPanelMeta]);

  async function patchPanel(patch: {
    title?: string;
    agentId?: string;
    taskStateSelection?: "idle" | "in_progress" | "completed";
  }) {
    const resp = await fetch(`/api/panels/${panel.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) {
      const p = await resp.json().catch(() => null);
      throw new Error(p?.error ?? "更新面板失败。");
    }
    const next = await resp.json();
    onPanelReplaced(next);
  }

  async function handleClearMessages() {
    const resp = await fetch(`/api/panels/${panel.id}/messages`, { method: "DELETE" });
    const p = await resp.json().catch(() => null);
    if (!resp.ok || !p || !("id" in p)) {
      setErrorMessage((p && "error" in p && p.error) || "清空消息失败。");
      return;
    }
    onPanelReplaced(p);
    setMessages([]);
    setPanelMessagesReady(true);
    setActiveRunId(null);
    setErrorMessage(null);
  }

  async function handleSend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSending || (panel.kind !== "group" && activeRunIdRef.current)) return;
    const pendingText = draft;
    const pendingFiles = selectedFiles;
    const pendingMentionRoleIds = selectedMentionRoleIds;
    if (!pendingText.trim() && pendingFiles.length === 0 && pendingMentionRoleIds.length === 0) return;

    const pendingMentionTitles = pendingMentionRoleIds
      .map((roleId) => groupRoles.find((role) => role.id === roleId)?.title)
      .filter((title): title is string => Boolean(title));
    const mentionSuffix = pendingMentionTitles.map((title) => `@${title}`).join("\n");
    const messageText = pendingText.trim()
      ? [pendingText.trimEnd(), mentionSuffix].filter(Boolean).join("\n")
      : mentionSuffix;

    const messageId = randomId();
    const optimisticMessage = buildOptimisticUserMessage({
      id: messageId,
      text: pendingText.trim(),
      files: pendingFiles,
      mentionedGroupRoleIds: pendingMentionRoleIds,
    });
    const body = new FormData();
    body.append("panelId", panel.id);
    body.append("messageId", messageId);
    body.append("message", messageText);
    pendingFiles.forEach(f => body.append("files", f));

    setMessages((current) => [...current, optimisticMessage]);
    setPanelMessagesReady(true);
    if (panel.kind === "group") {
      onPanelReplaced({
        ...panel,
        messages: [...messagesRef.current, optimisticMessage],
      });
    }
    setDraft("");
    setSelectedFiles([]);
    setSelectedMentionRoleIds([]);
    setMobileComposerExpanded(false);
    setIsSending(true);
    setErrorMessage(null);

    const resp = await fetch("/api/customchat/webhook", { method: "POST", body }).catch(e => ({
      ok: false, json: async () => ({ error: e instanceof Error ? e.message : "发送失败。" })
    })) as Response;
    const payload = await resp.json().catch(() => null);
    
    if (!resp.ok) {
      optimisticMessage.attachments.forEach(a => { if (a.url.startsWith("blob:")) URL.revokeObjectURL(a.url); });
      setMessages((current) => current.filter(m => m.id !== messageId));
      setDraft(current => current || pendingText);
      setSelectedFiles(current => current.length ? current : pendingFiles);
      setSelectedMentionRoleIds((current) => current.length ? current : pendingMentionRoleIds);
      setErrorMessage(payload?.error ?? "发送失败。");
    } else if (payload?.userMessage) {
      optimisticMessage.attachments.forEach(a => { if (a.url.startsWith("blob:")) URL.revokeObjectURL(a.url); });
      setMessages(current => current.map(m => m.id === messageId ? payload.userMessage : m));
    }
    setActiveRunId(payload?.runId?.trim() || null);
    setIsSending(false);
  }

  async function handleAbortRun() {
    if (isAborting) return;
    setIsAborting(true);
    const resp = await fetch(`/api/panels/${panel.id}/abort`, { method: "POST" });
    const p = await resp.json().catch(() => null);
    if (!resp.ok) {
      setIsAborting(false);
      setErrorMessage(p?.error ?? "终止失败。");
    } else if (p?.status === "aborting") {
      setErrorMessage(null);
    } else {
      setActiveRunId(null);
      setIsAborting(false);
      setErrorMessage(null);
    }
  }

  const currentAgent = useMemo(() => agents.find(a => a.id === panelAgentId) || null, [agents, panelAgentId]);
  const isRunActive = Boolean(activeRunId);
  const isGroupPanel = panel.kind === "group";

  // --- 群组角色 CRUD ---

  const refreshGroupRoles = useCallback(async (): Promise<GroupRoleView[] | null> => {
    const verify = manageGroupRolesDialog?.open ? "?verify=1" : "";
    const resp = await fetch(`/api/panels/${panel.id}/group-roles${verify}`, { cache: "no-store" }).catch(() => null);
    if (!resp?.ok) return null;
    const payload = (await resp.json().catch(() => null)) as { roles?: GroupRoleView[] } | null;
    const roles = Array.isArray(payload?.roles) ? payload.roles : null;
    if (roles) {
      setGroupRoles(roles);
      setManageGroupRolesDialog((prev) =>
        prev ? { ...prev, roles } : prev,
      );
      const currentMessages = messagesRef.current;
      // 同步到父级 panel 的 groupRoles，同时避免依赖新的 panel 对象导致轮询 effect 自触发。
      onPanelReplaced({
        ...panelCacheBase,
        activeRunId: activeRunIdRef.current,
        messageCount: currentMessages.length,
        latestMessagePreview: buildLatestMessagePreview(currentMessages),
        messagesLoaded: true,
        messages: currentMessages,
        groupRoles: roles,
      });
    }
    return roles;
  }, [manageGroupRolesDialog?.open, onPanelReplaced, panel.id, panelCacheBase]);

  useEffect(() => {
    if (!manageGroupRolesDialog?.open) {
      return;
    }

    void refreshGroupRoles();
    const timer = window.setInterval(() => {
      void refreshGroupRoles();
    }, 2_000);

    return () => window.clearInterval(timer);
  }, [manageGroupRolesDialog?.open, panel.id, refreshGroupRoles]);

  async function handleCreateGroupRole(input: { panelId: string; title: string; agentId: string }) {
    setIsCreatingRole(true);
    const resp = await fetch(`/api/panels/${input.panelId}/group-roles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: input.title, agentId: input.agentId }),
    });
    if (resp.ok) {
      await refreshGroupRoles();
      setCreateGroupRoleResetToken((current) => current + 1);
    }
    setIsCreatingRole(false);
  }

  async function handleDeleteGroupRole(panelId: string, roleId: string) {
    const resp = await fetch(`/api/panels/${panelId}/group-roles/${roleId}`, { method: "DELETE" });
    if (resp.ok) {
      await refreshGroupRoles();
      // 更新管理对话框中的角色列表
      setManageGroupRolesDialog((prev) =>
        prev ? { ...prev, roles: groupRoles.filter((r) => r.id !== roleId) } : null,
      );
    }
  }

  async function handleToggleLeader(panelId: string, roleId: string, currentlyLeader: boolean) {
    const method = currentlyLeader ? "DELETE" : "PUT";
    const resp = await fetch(`/api/panels/${panelId}/group-roles/${roleId}/leader`, { method });
    if (resp.ok) {
      const freshRoles = await refreshGroupRoles();
      if (freshRoles) {
        setManageGroupRolesDialog((prev) => prev ? { ...prev, roles: freshRoles } : null);
      }
    }
  }

  async function handleAbortGroupRole(panelId: string, roleId: string) {
    const markRoleAborting = (roles: GroupRoleView[]) =>
      roles.map((role) =>
        role.id === roleId
          ? {
              ...role,
              runtimeStatus: "aborting" as const,
            }
          : role,
      );

    setGroupRoles((current) => markRoleAborting(current));
    setManageGroupRolesDialog((prev) =>
      prev ? { ...prev, roles: markRoleAborting(prev.roles) } : prev,
    );

    const resp = await fetch(`/api/panels/${panelId}/group-roles/${roleId}/abort`, {
      method: "POST",
    });
    const payload = (await resp.json().catch(() => null)) as { error?: string } | null;
    if (!resp.ok && resp.status !== 202) {
      setErrorMessage(payload?.error ?? "终止角色推理失败。");
      await refreshGroupRoles();
      return;
    }

    setErrorMessage(null);
    const freshRoles = await refreshGroupRoles();
    if (freshRoles) {
      setManageGroupRolesDialog((prev) => (prev ? { ...prev, roles: freshRoles } : null));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={title}
        panel={panel}
        currentAgent={currentAgent}
        streamStatus={streamStatus}
        isRunActive={isRunActive}
        isAborting={isAborting}
        messagesCount={messages.length}
        onOpenSidebar={onOpenSidebar}
        onTitleChange={setTitle}
        onTitleBlur={() => { if (title.trim() && title.trim() !== panel.title) void patchPanel({ title }); }}
        onAbortRun={handleAbortRun}
        onOpenClearDialog={() => setConfirmDialog({
          title: "确认清空消息",
          description: `"${title.trim() || panel.title}"的本地消息记录和附件副本会被清空。`,
          confirmLabel: "确认清空",
          tone: "danger",
          onConfirm: handleClearMessages,
        })}
        onCollapse={() => {
          if (isMobileInputMode && !hasComposerContent) {
            setMobileComposerExpanded(false);
          }
        }}
        onAddGroupRole={isGroupPanel ? () => setCreateGroupRoleDialog({ open: true, panelId: panel.id }) : undefined}
        onManageGroupRoles={isGroupPanel ? () => setManageGroupRolesDialog({ open: true, panelId: panel.id, roles: groupRoles }) : undefined}
        onOpenGroupPlan={isGroupPanel ? () => setGroupPlanDialogOpen(true) : undefined}
        onSelectTaskState={isGroupPanel ? (selection) => { void patchPanel({ taskStateSelection: selection }); } : undefined}
      />

      <MessageList
        messages={messages}
        title={title}
        currentAgent={currentAgent}
        agents={agents}
        displayUserRoleName="我"
        messageListRef={messageListRef}
        showScrollButton={showScrollButton}
        onScrollToBottom={scrollToBottom}
        onPreview={setPreviewImageUrl}
        onCollapse={() => {
          if (isMobileInputMode && !hasComposerContent) {
            setMobileComposerExpanded(false);
          }
        }}
        isGroupPanel={isGroupPanel}
        groupRoles={groupRoles}
      />

      <PanelComposer
        draft={draft}
        setDraft={setDraft}
        selectedMentionRoleIds={selectedMentionRoleIds}
        setSelectedMentionRoleIds={setSelectedMentionRoleIds}
        selectedFiles={selectedFiles}
        setSelectedFiles={setSelectedFiles}
        isSending={isSending}
        isRunActive={isRunActive}
        isMobileInputMode={isMobileInputMode}
        mobileComposerExpanded={mobileComposerExpanded}
        setMobileComposerExpanded={setMobileComposerExpanded}
        composerFocused={composerFocused}
        setComposerFocused={setComposerFocused}
        hasComposerContent={hasComposerContent}
        displayAssistantRoleName={`${title.trim() || "助手"}${currentAgent?.emoji ? ` ${currentAgent.emoji}` : ""}`}
        errorMessage={errorMessage}
        setErrorMessage={setErrorMessage}
        composerFormRef={composerFormRef}
        messageListRef={messageListRef}
        onSend={handleSend}
        isGroupPanel={isGroupPanel}
        groupRoles={groupRoles}
        agents={agents}
      />

      <ConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} />

      {isGroupPanel ? (
        <>
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
          <GroupPlanDialog
            open={groupPlanDialogOpen}
            title={panel.title}
            plan={panel.groupPlan}
            onClose={() => setGroupPlanDialogOpen(false)}
          />
        </>
      ) : null}

      {previewImageUrl && (
        <ImageViewer url={previewImageUrl} onClose={() => setPreviewImageUrl(null)} />
      )}
    </div>
  );
}
