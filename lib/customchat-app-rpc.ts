/**
 * @module customchat-app-rpc
 * Plugin → App 管理类 RPC 分发器。
 *
 * 这条链路复用 customchat bridge WebSocket，不引入新的监听端口。
 * 由插件侧自定义 tool 发起调用，App 侧以当前内置管理员身份执行群组管理动作。
 */
import "server-only";

import { deleteProviderSession } from "@/lib/customchat-provider";
import { submitGroupMessage } from "@/lib/group-message";
import { resetInitializedRoles } from "@/lib/group-router";
import {
  createGroupRole,
  createPanel,
  clearGroupPanelPlan,
  clearGroupRoleMemory,
  deletePanel,
  ensureSeededAdminUser,
  findGroupRoleById,
  getGroupPanelMemory,
  getPanelRecordForUser,
  listGroupRoles,
  listPanelsForUser,
  removeGroupRole,
  setGroupRoleLeader,
  unsetGroupRoleLeader,
  updateGroupPanelPlan,
  updateGroupRole,
  updateGroupRoleMemory,
} from "@/lib/store";
import type {
  GroupMode,
  GroupPlanItem,
  GroupRoleView,
  PanelView,
  SessionUser,
} from "@/lib/types";
import { toCustomChatGroupRoleTarget } from "@/lib/utils";

type AppRpcParams = Record<string, unknown>;

type GroupRoleInput = {
  title: string;
  agentId: string;
  emoji: string | null;
  isLeader: boolean;
};

function readTrimmedString(
  params: AppRpcParams,
  key: string,
  options?: { required?: boolean },
) {
  const raw = params[key];
  if (typeof raw !== "string") {
    if (options?.required) {
      throw new Error(`${key} is required.`);
    }
    return "";
  }

  const value = raw.trim();
  if (!value && options?.required) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function readOptionalBoolean(params: AppRpcParams, key: string) {
  return typeof params[key] === "boolean" ? (params[key] as boolean) : undefined;
}

function readRoleInput(raw: unknown, index: number): GroupRoleInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`roles[${index}] must be an object.`);
  }

  const params = raw as AppRpcParams;
  const title = readTrimmedString(params, "title", { required: true });
  const agentId = readTrimmedString(params, "agentId", { required: true });
  const emojiRaw = params.emoji;

  return {
    title,
    agentId,
    emoji: typeof emojiRaw === "string" ? emojiRaw.trim() || null : null,
    isLeader: readOptionalBoolean(params, "isLeader") ?? false,
  };
}

function readRoleInputs(params: AppRpcParams) {
  const rawRoles = params.roles;
  if (rawRoles == null) {
    return [] as GroupRoleInput[];
  }
  if (!Array.isArray(rawRoles)) {
    throw new Error("roles must be an array.");
  }
  return rawRoles.map((item, index) => readRoleInput(item, index));
}

function readOptionalGroupMode(params: AppRpcParams): GroupMode | undefined {
  const raw = params.groupMode;
  if (raw == null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error("groupMode must be 'chat' or 'task'.");
  }
  const mode = raw.trim();
  if (!mode) {
    return undefined;
  }
  if (mode !== "chat" && mode !== "task") {
    throw new Error("groupMode must be 'chat' or 'task'.");
  }
  return mode;
}

function readPlanItems(params: AppRpcParams): GroupPlanItem[] {
  const rawItems = params.items;
  if (rawItems == null) {
    return [];
  }
  if (!Array.isArray(rawItems)) {
    throw new Error("items must be an array.");
  }

  return rawItems.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`items[${index}] must be an object.`);
    }
    const record = item as AppRpcParams;
    const title = readTrimmedString(record, "title", { required: true });
    const status = readTrimmedString(record, "status") || "pending";
    if (!["pending", "in_progress", "done", "blocked"].includes(status)) {
      throw new Error(`items[${index}].status is invalid.`);
    }
    return {
      title,
      status: status as GroupPlanItem["status"],
    };
  });
}

async function resolveAdminUser(): Promise<SessionUser> {
  return ensureSeededAdminUser();
}

function isGroupPanel(panel: PanelView) {
  return panel.kind === "group";
}

async function requireGroupPanelByReference(
  userId: string,
  params: AppRpcParams,
) {
  const panelId = readTrimmedString(params, "panelId");
  if (panelId) {
    let panel;
    try {
      panel = await getPanelRecordForUser(userId, panelId);
    } catch {
      throw new Error("群组不存在。");
    }
    if ((panel.kind ?? "direct") !== "group") {
      throw new Error("群组不存在。");
    }
    return panel;
  }

  const panelTitle = readTrimmedString(params, "panelTitle");
  if (!panelTitle) {
    throw new Error("缺少群组标识，请提供 panelId 或 panelTitle。");
  }

  const panels = (await listPanelsForUser(userId, { includeMessages: false }))
    .filter(isGroupPanel)
    .filter((panel) => panel.title.trim() === panelTitle);

  if (panels.length === 0) {
    throw new Error("群组不存在。");
  }
  if (panels.length > 1) {
    throw new Error("匹配到多个同名群组，请提供 panelId。");
  }

  return getPanelRecordForUser(userId, panels[0].id);
}

async function requireGroupRoleByReference(
  userId: string,
  params: AppRpcParams,
) {
  const panel = await requireGroupPanelByReference(userId, params);
  const roleId = readTrimmedString(params, "roleId");
  const roleTitle = readTrimmedString(params, "roleTitle");

  if (!roleId && !roleTitle) {
    throw new Error("缺少角色标识，请提供 roleId 或 roleTitle。");
  }

  const roles = await listGroupRoles(panel.id);
  const matched = roleId
    ? roles.find((role) => role.id === roleId)
    : roles.filter((role) => role.title.trim() === roleTitle);

  if (Array.isArray(matched)) {
    if (matched.length === 0) {
      throw new Error("角色不存在。");
    }
    if (matched.length > 1) {
      throw new Error("匹配到多个同名角色，请提供 roleId。");
    }
    return { panel, role: matched[0] };
  }

  if (!matched) {
    throw new Error("角色不存在。");
  }

  return { panel, role: matched };
}

async function buildAgentIdSet() {
  const { loadAgentCatalog } = await import("@/lib/agents");
  const agents = await loadAgentCatalog(true);
  return new Set(agents.map((agent) => agent.id));
}

async function assertKnownAgentIds(roles: GroupRoleInput[]) {
  const knownAgentIds = await buildAgentIdSet();
  for (const role of roles) {
    if (!knownAgentIds.has(role.agentId)) {
      throw new Error(`Unknown agentId: ${role.agentId}`);
    }
  }
}

async function handleCreateGroup(user: SessionUser, params: AppRpcParams) {
  const title = readTrimmedString(params, "title", { required: true });
  const roles = readRoleInputs(params);
  const groupMode = readOptionalGroupMode(params);
  await assertKnownAgentIds(roles);

  const panel = await createPanel(user.id, "", title, "group", groupMode);
  const createdRoles: GroupRoleView[] = [];
  for (const role of roles) {
    createdRoles.push(await createGroupRole({
      panelId: panel.id,
      agentId: role.agentId,
      title: role.title,
      emoji: role.emoji,
      isLeader: role.isLeader,
    }));
  }
  resetInitializedRoles(panel.id);

  const nextPanel = await getPanelRecordForUser(user.id, panel.id);
  return {
    ok: true,
    panel: nextPanel,
    roles: createdRoles,
  };
}

async function handleListGroups(user: SessionUser) {
  const groups = (await listPanelsForUser(user.id, { includeMessages: false }))
    .filter(isGroupPanel)
    .map((panel) => ({
      id: panel.id,
      title: panel.title,
      kind: panel.kind,
      taskState: panel.taskState ?? "idle",
      updatedAt: panel.updatedAt,
      groupRoles: panel.groupRoles ?? [],
      groupPlan: panel.groupPlan ?? null,
    }));

  return {
    ok: true,
    groups,
  };
}

async function buildGroupDetails(userId: string, panelId: string) {
  const panel = await getPanelRecordForUser(userId, panelId);
  const groupRoles = await listGroupRoles(panelId);
  return {
    id: panel.id,
    title: panel.title,
    kind: panel.kind,
    taskState: panel.taskState ?? "idle",
    taskStateChangedAt: panel.taskStateChangedAt ?? null,
    updatedAt: panel.updatedAt,
    groupRoles,
    groupPlan: panel.groupPlan ?? null,
  };
}

async function handleGetGroup(user: SessionUser, params: AppRpcParams) {
  const panel = await requireGroupPanelByReference(user.id, params);
  return {
    ok: true,
    group: await buildGroupDetails(user.id, panel.id),
  };
}

async function handleDeleteGroup(user: SessionUser, params: AppRpcParams) {
  const panel = await requireGroupPanelByReference(user.id, params);
  const roles = await listGroupRoles(panel.id);

  await deletePanel(user.id, panel.id);
  resetInitializedRoles(panel.id);

  await Promise.allSettled(
    roles.map((role) =>
      deleteProviderSession({
        panelId: panel.id,
        agentId: role.agentId,
        target: toCustomChatGroupRoleTarget(panel.id, role.id),
      })
    ),
  );

  return {
    ok: true,
    panelId: panel.id,
    title: panel.title,
    removedRoleIds: roles.map((role) => role.id),
  };
}

async function handleSendGroupMessage(user: SessionUser, params: AppRpcParams) {
  const panel = await requireGroupPanelByReference(user.id, params);
  const message = readTrimmedString(params, "message", { required: true });
  const result = await submitGroupMessage({
    user,
    panel,
    message,
    files: [],
  });

  return {
    ok: true,
    panelId: panel.id,
    title: panel.title,
    taskState: panel.taskState ?? "idle",
    userMessage: result.userMessage,
  };
}

async function handleGetGroupPlan(user: SessionUser, params: AppRpcParams) {
  const panel = await requireGroupPanelByReference(user.id, params);
  const group = await buildGroupDetails(user.id, panel.id);
  return {
    ok: true,
    panelId: panel.id,
    title: panel.title,
    taskState: group.taskState,
    groupPlan: group.groupPlan,
  };
}

async function handleUpdateGroupPlan(user: SessionUser, params: AppRpcParams) {
  const panel = await requireGroupPanelByReference(user.id, params);
  const summary = readTrimmedString(params, "summary");
  const items = readPlanItems(params);
  const updatedByLabel = readTrimmedString(params, "updatedByLabel");
  if (!summary && items.length === 0) {
    throw new Error("summary or items is required.");
  }

  const nextPanel = await updateGroupPanelPlan(panel.id, {
    summary,
    items,
    updatedByLabel: updatedByLabel || null,
  });

  return {
    ok: true,
    panelId: panel.id,
    title: panel.title,
    taskState: nextPanel.taskState ?? "idle",
    groupPlan: nextPanel.groupPlan ?? null,
  };
}

async function handleClearGroupPlan(user: SessionUser, params: AppRpcParams) {
  const panel = await requireGroupPanelByReference(user.id, params);
  const nextPanel = await clearGroupPanelPlan(panel.id);
  return {
    ok: true,
    panelId: panel.id,
    title: panel.title,
    taskState: nextPanel.taskState ?? "idle",
    groupPlan: null,
  };
}

async function handleListAgents() {
  const { loadAgentCatalog } = await import("@/lib/agents");
  const agents = await loadAgentCatalog(true);
  return {
    ok: true,
    agents,
  };
}

async function handleAddGroupRole(user: SessionUser, params: AppRpcParams) {
  const panel = await requireGroupPanelByReference(user.id, params);
  const roleInput = readRoleInput(params, 0);
  await assertKnownAgentIds([roleInput]);

  const role = await createGroupRole({
    panelId: panel.id,
    agentId: roleInput.agentId,
    title: roleInput.title,
    emoji: roleInput.emoji,
    isLeader: roleInput.isLeader,
  });
  resetInitializedRoles(panel.id);

  return {
    ok: true,
    panelId: panel.id,
    role,
  };
}

async function handleUpdateGroupRole(user: SessionUser, params: AppRpcParams) {
  const { panel, role } = await requireGroupRoleByReference(user.id, params);
  const nextAgentId = readTrimmedString(params, "agentId");
  if (nextAgentId) {
    await assertKnownAgentIds([
      {
        title: role.title,
        agentId: nextAgentId,
        emoji: role.emoji ?? null,
        isLeader: role.isLeader ?? false,
      },
    ]);
  }

  const updatedRole = await updateGroupRole(role.id, {
    title: readTrimmedString(params, "title") || undefined,
    emoji: params.emoji === null
      ? null
      : typeof params.emoji === "string"
        ? params.emoji.trim() || null
        : undefined,
    agentId: nextAgentId || undefined,
    enabled: typeof params.enabled === "boolean" ? params.enabled : undefined,
  });
  resetInitializedRoles(panel.id);

  return {
    ok: true,
    panelId: panel.id,
    role: updatedRole,
  };
}

async function handleSetGroupLeader(user: SessionUser, params: AppRpcParams) {
  const { panel, role } = await requireGroupRoleByReference(user.id, params);
  const nextRole = readOptionalBoolean(params, "enabled") === false
    ? await unsetGroupRoleLeader(panel.id, role.id)
    : await setGroupRoleLeader(panel.id, role.id);

  return {
    ok: true,
    panelId: panel.id,
    role: nextRole,
  };
}

async function handleRemoveGroupRole(user: SessionUser, params: AppRpcParams) {
  const { panel, role } = await requireGroupRoleByReference(user.id, params);
  const storedRole = await findGroupRoleById(role.id);
  await removeGroupRole(role.id);
  resetInitializedRoles(panel.id);

  if (storedRole) {
    void deleteProviderSession({
      panelId: panel.id,
      agentId: storedRole.agentId,
      target: toCustomChatGroupRoleTarget(panel.id, storedRole.id),
    }).catch(() => null);
  }

  return {
    ok: true,
    panelId: panel.id,
    roleId: role.id,
  };
}

// ─────────────────────────────────────────────
// Group Memory handlers
// ─────────────────────────────────────────────

async function handleGetGroupMemory(user: SessionUser, params: AppRpcParams) {
  const panel = await requireGroupPanelByReference(user.id, params);
  const memory = await getGroupPanelMemory(panel.id);
  return { ok: true, panelId: panel.id, memory };
}

async function handleUpdateGroupMemory(user: SessionUser, params: AppRpcParams) {
  const { panel, role } = await requireGroupRoleByReference(user.id, params);
  const roleTitle =
    readTrimmedString(params, "roleTitle") ||
    role.title;
  const content = readTrimmedString(params, "content", { required: true });
  await updateGroupRoleMemory(panel.id, role.id, roleTitle, content);
  return { ok: true, panelId: panel.id, roleId: role.id };
}

async function handleClearGroupMemory(user: SessionUser, params: AppRpcParams) {
  const { panel, role } = await requireGroupRoleByReference(user.id, params);
  await clearGroupRoleMemory(panel.id, role.id);
  return { ok: true, panelId: panel.id, roleId: role.id };
}

// ---------------------------------------------------------------------------
// group_route: 结构化路由意图存储
// tool execute 时通过 RPC push 路由意图，ingest state=final 时消费
// ---------------------------------------------------------------------------

type PendingRouteIntent = {
  panelId: string;
  targetTitles: string[];
  taskState?: string;
  declaredAt: number;
};

const pendingRouteIntents = new Map<string, PendingRouteIntent>();

function handleGroupRouteDeclare(params: AppRpcParams) {
  const runId = typeof params.runId === "string" ? params.runId.trim() : "";
  if (!runId) throw new Error("group_route.declare: runId is required");

  const panelId = typeof params.panelId === "string" ? params.panelId.trim() : "";
  const targets = Array.isArray(params.targets)
    ? (params.targets as unknown[]).filter((t) => typeof t === "string").map((t) => (t as string).trim()).filter(Boolean)
    : [];
  const taskState = typeof params.taskState === "string" && params.taskState.trim()
    ? params.taskState.trim()
    : undefined;

  pendingRouteIntents.set(runId, {
    panelId,
    targetTitles: targets,
    taskState,
    declaredAt: Date.now(),
  });

  return { ok: true };
}

/**
 * 消费并删除某个 runId 的路由意图。ingest state=final 时调用。
 * 消费后自动从 Map 中移除，保证幂等。
 */
export function consumeRouteIntent(runId: string): PendingRouteIntent | null {
  const intent = pendingRouteIntents.get(runId);
  if (intent) pendingRouteIntents.delete(runId);
  return intent ?? null;
}

// ─────────────────────────────────────────────────────────────
// group_task.* handler（任务模式，完全独立于聊天模式）
// ─────────────────────────────────────────────────────────────

async function handleGroupTask(params: AppRpcParams) {
  const { dispatchGroupTaskRpc } = await import("@/lib/task-mode/app-rpc-handlers");
  const panelId = typeof params.panelId === "string" ? params.panelId.trim() : "";
  const action = typeof params.action === "string" ? params.action.trim() : "";
  if (!panelId) throw new Error("group_task: panelId is required.");
  if (!action) throw new Error("group_task: action is required.");
  return dispatchGroupTaskRpc(panelId, action, params);
}

/**
 * 分发 Plugin → App 管理类 RPC。
 */
export async function dispatchCustomChatAppRpc(
  method: string,
  params: AppRpcParams = {},
) {
  const user = await resolveAdminUser();

  switch (method) {
    case "group.create":
      return handleCreateGroup(user, params);
    case "group.delete":
      return handleDeleteGroup(user, params);
    case "group.get":
      return handleGetGroup(user, params);
    case "group.message":
      return handleSendGroupMessage(user, params);
    case "group_plan.get":
      return handleGetGroupPlan(user, params);
    case "group_plan.update":
      return handleUpdateGroupPlan(user, params);
    case "group_plan.clear":
      return handleClearGroupPlan(user, params);
    case "group_memory.get":
      return handleGetGroupMemory(user, params);
    case "group_memory.update":
      return handleUpdateGroupMemory(user, params);
    case "group_memory.clear":
      return handleClearGroupMemory(user, params);
    case "group_route.declare":
      return handleGroupRouteDeclare(params);
    case "group.list":
      return handleListGroups(user);
    case "agents.list":
      return handleListAgents();
    case "group_role.add":
      return handleAddGroupRole(user, params);
    case "group_role.update":
      return handleUpdateGroupRole(user, params);
    case "group_role.set_leader":
      return handleSetGroupLeader(user, params);
    case "group_role.remove":
      return handleRemoveGroupRole(user, params);
    // ── 任务模式（入口分流，后续完全由 task-mode 模块处理）──
    case "group_task":
      return handleGroupTask(params);
    default:
      throw new Error(`Unknown App RPC method: ${method}`);
  }
}
