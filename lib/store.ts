/**
 * @module store
 * 应用核心持久化层。
 * 基于 JSON 文件实现用户、面板（Panel）、消息（Message）和附件（Attachment）的 CRUD 操作。
 * 所有写操作通过串行化的 mutationQueue 保证并发安全。
 * 内存缓存避免重复读取/解析 JSON 文件。
 */
import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import bcrypt from "bcryptjs";

import { getDataFilePath, getDownloadDir, getStorageDir, getUploadDir, getVoiceDir } from "@/lib/env";
import { normalizeGroupTaskState } from "@/lib/group-task";
import { createLogger } from "@/lib/logger";
import type {
  AppData,
  AttachmentView,
  GroupTaskState,
  GroupRoleView,
  MessageView,
  MessageSessionMeta,
  PanelKind,
  PanelView,
  SessionUser,
  StoredAttachment,
  StoredGroupRole,
  StoredMessage,
  StoredPanel,
  StoredRuntimeStep,
  StoredUser,
} from "@/lib/types";
import {
  extractMessageAttachments,
  buildSessionKey,
  classifyAttachment,
  sanitizeRuntimeSteps,
  messageToView,
  nowIso,
  normalizeCustomChatTarget,
  sanitizeFilename,
  toLocalFilePath,
} from "@/lib/utils";

const log = createLogger("store");

const EMPTY_DATA: AppData = {
  users: [],
  panels: [],
  messages: [],
  groupRoles: [],
};

const DEFAULT_USER_ROLE_NAME = "我";
const DEFAULT_ASSISTANT_ROLE_NAME = "助手";

let mutationQueue = Promise.resolve();

/** In-memory cache – avoids re-reading/parsing the JSON file on every operation. */
let cachedData: AppData | null = null;

/** Once true, `ensureSeededAdminUser` returns immediately. */
let adminSeeded = false;
let adminSeededUser: SessionUser | null = null;

async function ensureStorageReady() {
  await fs.mkdir(getStorageDir(), { recursive: true });
  await fs.mkdir(getUploadDir(), { recursive: true });
  await fs.mkdir(getDownloadDir(), { recursive: true });
  await fs.mkdir(getVoiceDir(), { recursive: true });
}

async function initializeDataFile() {
  await ensureStorageReady();

  try {
    await fs.access(getDataFilePath());
  } catch {
    await fs.writeFile(
      getDataFilePath(),
      `${JSON.stringify(EMPTY_DATA, null, 2)}\n`,
      "utf8",
    );
  }
}

async function readData(): Promise<AppData> {
  if (cachedData) {
    return structuredClone(cachedData);
  }

  await initializeDataFile();
  const raw = await fs.readFile(getDataFilePath(), "utf8");
  const parsed = raw ? (JSON.parse(raw) as AppData) : EMPTY_DATA;
  // Backward compat: older data files may lack groupRoles
  parsed.groupRoles = parsed.groupRoles ?? [];
  parsed.messages = (parsed.messages ?? []).map((message) => ({
    ...message,
    runtimeSteps: sanitizeRuntimeSteps(message.runtimeSteps ?? []),
  }));
  cachedData = structuredClone(parsed);
  return parsed;
}

async function writeData(data: AppData) {
  data.messages = (data.messages ?? []).map((message) => ({
    ...message,
    runtimeSteps: sanitizeRuntimeSteps(message.runtimeSteps ?? []),
  }));
  await fs.writeFile(
    getDataFilePath(),
    `${JSON.stringify(data, null, 2)}\n`,
    "utf8",
  );
  cachedData = structuredClone(data);
}

async function deleteStoredFiles(paths: Array<string | null | undefined>) {
  const uniquePaths = Array.from(
    new Set(paths.filter((candidate): candidate is string => Boolean(candidate))),
  );

  await Promise.all(
    uniquePaths.map(async (targetPath) => {
      try {
        await fs.unlink(targetPath);
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : null;
        if (code !== "ENOENT") {
          throw error;
        }
      }
    }),
  );
}

function attachmentSignature(attachment: StoredAttachment) {
  return (
    attachment.sourceUrl ||
    attachment.storagePath ||
    `${attachment.name}:${attachment.mimeType}:${attachment.size}`
  );
}

function mergeStoredAttachments(
  current: StoredAttachment[],
  incoming: StoredAttachment[],
) {
  if (incoming.length === 0) {
    return {
      attachments: current,
      duplicateIncomingPaths: [] as string[],
    };
  }

  if (current.length === 0) {
    return {
      attachments: incoming,
      duplicateIncomingPaths: [] as string[],
    };
  }

  const seen = new Set(current.map(attachmentSignature));
  const merged = [...current];
  const duplicateIncomingPaths: string[] = [];

  for (const attachment of incoming) {
    const signature = attachmentSignature(attachment);
    if (seen.has(signature)) {
      if (attachment.storagePath) {
        duplicateIncomingPaths.push(attachment.storagePath);
      }
      continue;
    }

    seen.add(signature);
    merged.push(attachment);
  }

  return { attachments: merged, duplicateIncomingPaths };
}

async function mutateData<T>(callback: (draft: AppData) => Promise<T> | T) {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;

  const result = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const run = mutationQueue.then(async () => {
    try {
      const draft = await readData();
      const next = structuredClone(draft);
      const response = await callback(next);
      await writeData(next);
      resolvePromise(response);
    } catch (error) {
      rejectPromise(error);
    }
  });

  mutationQueue = run.catch(() => undefined);

  return result;
}

function toSessionUser(user: StoredUser): SessionUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  };
}

function buildLatestMessagePreview(messages: StoredMessage[]) {
  const latestMessage = messages[messages.length - 1];
  if (!latestMessage) {
    return null;
  }

  if (latestMessage.text?.trim()) {
    return latestMessage.text.trim();
  }

  if (latestMessage.role === "assistant" && latestMessage.draft) {
    return "正在生成回复...";
  }

  if ((latestMessage.attachments?.length ?? 0) > 0) {
    return "已发送附件";
  }

  return null;
}

function isPanelRunBlocked(panel: StoredPanel, runId: string) {
  return (panel.blockedRunIds ?? []).includes(runId);
}

function groupRoleToView(role: StoredGroupRole): GroupRoleView {
  return {
    id: role.id,
    panelId: role.panelId,
    agentId: role.agentId,
    title: role.title,
    emoji: role.emoji ?? null,
    isLeader: role.isLeader === true,
    enabled: role.enabled,
  };
}

function panelToView(
  panel: StoredPanel,
  messages: StoredMessage[],
  options?: {
    includeMessages?: boolean;
    groupRoles?: StoredGroupRole[];
  },
): PanelView {
  const includeMessages = options?.includeMessages ?? true;
  const effectiveActiveRunId = (() => {
    if (!panel.activeRunId) {
      return null;
    }

    const activeMessage = messages.find(
      (message) =>
        message.role === "assistant" &&
        message.runId === panel.activeRunId,
    );

    if (
      activeMessage &&
      !activeMessage.draft &&
      (activeMessage.state === "final" ||
        activeMessage.state === "aborted" ||
        activeMessage.state === "error")
    ) {
      return null;
    }

    return panel.activeRunId;
  })();

  const panelKind = panel.kind ?? "direct";
  const panelGroupRoles =
    panelKind === "group" && options?.groupRoles
      ? options.groupRoles
          .filter((r) => r.panelId === panel.id)
          .map(groupRoleToView)
      : undefined;

  return {
    id: panel.id,
    title: panel.title,
    agentId: panel.agentId,
    sessionKey: panel.sessionKey,
    kind: panelKind,
    taskState: panelKind === "group" ? normalizeGroupTaskState(panel.taskState) : undefined,
    userRoleName: panel.userRoleName?.trim() || DEFAULT_USER_ROLE_NAME,
    assistantRoleName:
      panel.assistantRoleName?.trim() || DEFAULT_ASSISTANT_ROLE_NAME,
    activeRunId: effectiveActiveRunId,
    messageCount: messages.length,
    latestMessagePreview: buildLatestMessagePreview(messages),
    messagesLoaded: includeMessages,
    createdAt: panel.createdAt,
    updatedAt: panel.updatedAt,
    messages: includeMessages
      ? messages
          .sort(
            (left, right) =>
              new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
          )
          .map((message) => {
            const view = messageToView(message);
            const isActiveRunMessage = Boolean(
              effectiveActiveRunId &&
                view.role === "assistant" &&
                view.runId === effectiveActiveRunId,
            );
            if (view.draft && !isActiveRunMessage) {
              return {
                ...view,
                draft: false,
                state: view.state === "delta" ? "final" : view.state,
              };
            }
            return view;
          })
      : [],
    groupRoles: panelGroupRoles,
  };
}

function requirePanelOwner(
  panels: StoredPanel[],
  panelId: string,
  userId: string,
): StoredPanel {
  const panel = panels.find(
    (candidate) => candidate.id === panelId && candidate.userId === userId,
  );

  if (!panel) {
    throw new Error("Panel not found.");
  }

  return panel;
}

function createPanelRecord(
  userId: string,
  agentId: string,
  title: string,
  kind: PanelKind = "direct",
) {
  const id = crypto.randomUUID();
  const createdAt = nowIso();

  return {
    id,
    userId,
    title,
    agentId,
    sessionKey: buildSessionKey(agentId, id),
    kind,
    taskState: kind === "group" ? "idle" : undefined,
    userRoleName: DEFAULT_USER_ROLE_NAME,
    assistantRoleName: DEFAULT_ASSISTANT_ROLE_NAME,
    activeRunId: null,
    blockedRunIds: [],
    createdAt,
    updatedAt: createdAt,
  } satisfies StoredPanel;
}

/**
 * 确保内置管理员用户已创建或同步。
 * 首次调用时从环境变量读取管理员信息，写入存储；后续调用使用内存缓存直接返回。
 * 若环境变量中的密码或邮箱发生变化，会自动更新存储中的记录。
 * @returns {Promise<SessionUser>} 管理员用户信息
 */
export async function ensureSeededAdminUser() {
  // Fast path: already seeded during this process lifetime.
  if (adminSeeded && adminSeededUser) {
    return adminSeededUser;
  }

  const { adminEmail, adminName, adminPassword } = await import("@/lib/env").then(
    (module) => module.getEnv(),
  );

  const result = await mutateData(async (draft) => {
    const normalizedEmail = adminEmail.toLowerCase();
    const existing = draft.users.find(
      (candidate) => candidate.email.toLowerCase() === normalizedEmail,
    );

    if (existing) {
      // Only re-hash if the password actually changed.
      const passwordUnchanged = await bcrypt.compare(adminPassword, existing.passwordHash);
      if (!passwordUnchanged) {
        existing.passwordHash = await bcrypt.hash(adminPassword, 10);
      }
      existing.email = normalizedEmail;
      existing.displayName = adminName;
      return toSessionUser(existing);
    }

    // This app currently supports a single built-in admin. If the env email
    // changes, keep the stored admin in sync instead of forcing storage reset.
    if (draft.users.length === 1) {
      const builtInAdmin = draft.users[0];
      const passwordUnchanged = await bcrypt.compare(adminPassword, builtInAdmin.passwordHash);
      if (!passwordUnchanged) {
        builtInAdmin.passwordHash = await bcrypt.hash(adminPassword, 10);
      }
      builtInAdmin.email = normalizedEmail;
      builtInAdmin.displayName = adminName;
      return toSessionUser(builtInAdmin);
    }

    const user: StoredUser = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      displayName: adminName,
      passwordHash: await bcrypt.hash(adminPassword, 10),
      createdAt: nowIso(),
    };

    draft.users.push(user);
    return toSessionUser(user);
  });

  adminSeeded = true;
  adminSeededUser = result;
  return result;
}

/**
 * 根据邮箱查找用户（不区分大小写）。
 * @param {string} email - 用户邮箱
 * @returns {Promise<StoredUser | undefined>} 匹配的用户记录，未找到返回 undefined
 */
export async function findUserByEmail(email: string) {
  const data = await readData();
  return data.users.find(
    (user) => user.email.toLowerCase() === email.trim().toLowerCase(),
  );
}

/**
 * 根据用户 ID 查找用户。
 * @param {string} userId - 用户 ID
 * @returns {Promise<StoredUser | undefined>} 匹配的用户记录，未找到返回 undefined
 */
export async function findUserById(userId: string) {
  const data = await readData();
  return data.users.find((user) => user.id === userId);
}

/**
 * 获取指定用户的所有面板列表，按创建时间排序。
 * @param {string} userId - 用户 ID
 * @param {object} [options] - 可选配置
 * @param {boolean} [options.includeMessages=true] - 是否在结果中包含消息列表
 * @returns {Promise<PanelView[]>} 面板视图数组
 */
export async function listPanelsForUser(
  userId: string,
  options?: {
    includeMessages?: boolean;
  },
): Promise<PanelView[]> {
  const data = await readData();
  const includeMessages = options?.includeMessages ?? true;
  const panels = data.panels
    .filter((panel) => panel.userId === userId)
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );

  return panels.map((panel) =>
    panelToView(
      panel,
      data.messages.filter((message) => message.panelId === panel.id),
      { includeMessages, groupRoles: data.groupRoles },
    ),
  );
}

/**
 * 确保用户至少有一个面板，若没有则自动创建默认面板。
 * @param {string} userId - 用户 ID
 * @param {string} agentId - Agent ID
 * @param {object} [options] - 可选配置
 * @param {boolean} [options.includeMessages] - 是否包含消息列表
 * @returns {Promise<PanelView[]>} 用户的面板列表（保证非空）
 */
export async function ensureDefaultPanel(
  userId: string,
  agentId: string,
  options?: {
    includeMessages?: boolean;
  },
) {
  const panels = await listPanelsForUser(userId, options);
  if (panels.length > 0) {
    return panels;
  }

  await createPanel(userId, agentId, "Main Agent");
  return listPanelsForUser(userId, options);
}

/**
 * 获取指定用户的面板详细视图（含消息）。
 * @param {string} userId - 用户 ID
 * @param {string} panelId - 面板 ID
 * @returns {Promise<PanelView>} 面板视图
 * @throws {Error} 面板不存在或不属于该用户时抛出异常
 */
export async function getPanelViewForUser(userId: string, panelId: string) {
  const data = await readData();
  const panel = requirePanelOwner(data.panels, panelId, userId);
  return panelToView(
    panel,
    data.messages.filter((message) => message.panelId === panel.id),
    { includeMessages: true, groupRoles: data.groupRoles },
  );
}

/**
 * 创建新的聊天面板。
 * @param {string} userId - 所属用户 ID
 * @param {string} agentId - 关联的 Agent ID
 * @param {string} title - 面板标题
 * @returns {Promise<PanelView>} 新创建的面板视图
 */
export async function createPanel(
  userId: string,
  agentId: string,
  title: string,
  kind: PanelKind = "direct",
) {
  return mutateData((draft) => {
    const panel = createPanelRecord(userId, agentId, title, kind);
    draft.panels.push(panel);
    return panelToView(panel, [], { groupRoles: draft.groupRoles });
  });
}

/**
 * 更新面板属性。切换 agentId 时会重置 sessionKey 并清除该面板的所有消息。
 * @param {string} userId - 用户 ID
 * @param {string} panelId - 面板 ID
 * @param {object} input - 要更新的字段
 * @param {string} [input.title] - 新标题
 * @param {string} [input.agentId] - 新 Agent ID（切换时清空消息）
 * @param {string} [input.userRoleName] - 用户角色显示名
 * @param {string} [input.assistantRoleName] - 助手角色显示名
 * @returns {Promise<PanelView>} 更新后的面板视图
 */
export async function updatePanel(
  userId: string,
  panelId: string,
  input: {
    title?: string;
    agentId?: string;
    userRoleName?: string;
    assistantRoleName?: string;
  },
) {
  return mutateData((draft) => {
    const panel = requirePanelOwner(draft.panels, panelId, userId);
    const updatedAt = nowIso();

    if (typeof input.title === "string" && input.title.trim()) {
      panel.title = input.title.trim();
    }

    if (typeof input.userRoleName === "string") {
      panel.userRoleName = input.userRoleName.trim() || DEFAULT_USER_ROLE_NAME;
    }

    if (typeof input.assistantRoleName === "string") {
      panel.assistantRoleName =
        input.assistantRoleName.trim() || DEFAULT_ASSISTANT_ROLE_NAME;
    }

    if (typeof input.agentId === "string" && input.agentId !== panel.agentId) {
      panel.agentId = input.agentId;
      panel.sessionKey = buildSessionKey(input.agentId, panel.id);
      panel.activeRunId = null;
      panel.blockedRunIds = [];
      draft.messages = draft.messages.filter((message) => message.panelId !== panel.id);
    }

    panel.updatedAt = updatedAt;

    return panelToView(
      panel,
      draft.messages.filter((message) => message.panelId === panel.id),
      { groupRoles: draft.groupRoles },
    );
  });
}

/**
 * 删除面板及其所有消息和关联的附件文件。
 * @param {string} userId - 用户 ID
 * @param {string} panelId - 面板 ID
 * @returns {Promise<{ok: true}>} 删除成功
 * @throws {Error} 面板不存在或不属于该用户时抛出异常
 */
export async function deletePanel(userId: string, panelId: string) {
  return mutateData(async (draft) => {
    requirePanelOwner(draft.panels, panelId, userId);
    const attachmentPaths = draft.messages
      .filter((message) => message.panelId === panelId)
      .flatMap((message) => message.attachments.map((attachment) => attachment.storagePath));

    draft.panels = draft.panels.filter((panel) => panel.id !== panelId);
    draft.messages = draft.messages.filter((message) => message.panelId !== panelId);
    draft.groupRoles = draft.groupRoles.filter((role) => role.panelId !== panelId);
    await deleteStoredFiles(attachmentPaths);
    return { ok: true };
  });
}

/**
 * 清空面板的所有消息和附件文件，同时重置 activeRunId。
 * @param {string} userId - 用户 ID
 * @param {string} panelId - 面板 ID
 * @returns {Promise<PanelView>} 清空后的面板视图
 */
export async function clearPanelMessages(userId: string, panelId: string) {
  return mutateData(async (draft) => {
    const panel = requirePanelOwner(draft.panels, panelId, userId);
    const panelMessages = draft.messages.filter((message) => message.panelId === panelId);
    const attachmentPaths = panelMessages.flatMap((message) =>
      message.attachments.map((attachment) => attachment.storagePath),
    );

    draft.messages = draft.messages.filter((message) => message.panelId !== panelId);
    panel.activeRunId = null;
    panel.blockedRunIds = [];
    panel.updatedAt = nowIso();

    await deleteStoredFiles(attachmentPaths);

    return panelToView(panel, []);
  });
}

/**
 * 删除面板中的单条消息及其附件文件。
 * @param {string} userId - 用户 ID
 * @param {string} panelId - 面板 ID
 * @param {string} messageId - 消息 ID
 * @returns {Promise<{ok: true}>} 删除成功
 * @throws {Error} 消息不存在时抛出异常
 */
export async function deletePanelMessage(
  userId: string,
  panelId: string,
  messageId: string,
) {
  return mutateData(async (draft) => {
    const panel = requirePanelOwner(draft.panels, panelId, userId);
    const message = draft.messages.find(
      (candidate) =>
        candidate.panelId === panelId && candidate.id === messageId,
    );

    if (!message) {
      throw new Error("Message not found.");
    }

    const attachmentPaths = message.attachments
      .map((attachment) => attachment.storagePath)
      .filter((candidate): candidate is string => Boolean(candidate));

    draft.messages = draft.messages.filter(
      (candidate) => candidate.id !== messageId,
    );
    panel.updatedAt = nowIso();

    await deleteStoredFiles(attachmentPaths);
    return { ok: true };
  });
}

/**
 * 获取面板的原始存储记录。
 * @param {string} userId - 用户 ID
 * @param {string} panelId - 面板 ID
 * @returns {Promise<StoredPanel>} 面板存储记录
 * @throws {Error} 面板不存在或不属于该用户时抛出异常
 */
export async function getPanelRecordForUser(userId: string, panelId: string) {
  const data = await readData();
  return requirePanelOwner(data.panels, panelId, userId);
}

/**
 * 根据 sessionKey 查找面板记录。
 * @param {string} sessionKey - 会话标识（格式: agentId:panelId）
 * @returns {Promise<StoredPanel | null>} 面板记录，未找到返回 null
 */
export async function findPanelRecordBySessionKey(sessionKey: string) {
  const data = await readData();
  return data.panels.find((candidate) => candidate.sessionKey === sessionKey) ?? null;
}

/**
 * 根据 CustomChat 目标标识查找面板记录。
 * 会对 target 进行规范化处理后再匹配。
 * @param {string} target - CustomChat 目标标识（如 Gateway 的 session target）
 * @returns {Promise<StoredPanel | null>} 面板记录，未找到返回 null
 */
export async function findPanelRecordByCustomChatTarget(target: string) {
  const normalized = normalizeCustomChatTarget(target);
  if (!normalized) {
    return null;
  }

  const data = await readData();
  return (
    data.panels.find(
      (candidate) => normalizeCustomChatTarget(candidate.sessionKey) === normalized,
    ) ?? null
  );
}

/**
 * 获取面板当前正在执行的 runId。
 * @param {string} panelId - 面板 ID
 * @returns {Promise<string | null>} 活跃的 runId，无活跃运行时返回 null
 */
export async function getPanelActiveRun(panelId: string): Promise<string | null> {
  const data = await readData();
  const panel = data.panels.find((candidate) => candidate.id === panelId);
  return panel?.activeRunId ?? null;
}

/**
 * 根据 runId 在指定面板中查找消息。
 * @param {string} panelId - 面板 ID
 * @param {string} runId - Gateway 运行 ID
 * @returns {Promise<StoredMessage | null>} 匹配的消息，未找到返回 null
 */
export async function findMessageByRunId(panelId: string, runId: string) {
  const data = await readData();
  return data.messages.find(
    (message) => message.panelId === panelId && message.runId === runId
  ) ?? null;
}

/**
 * 追加一条用户消息到面板。
 * @param {string} userId - 用户 ID
 * @param {string} panelId - 面板 ID
 * @param {object} input - 消息内容
 * @param {string} input.id - 消息 ID
 * @param {string} input.text - 消息文本
 * @param {StoredAttachment[]} input.attachments - 附件列表
 * @returns {Promise<MessageView>} 新消息的视图
 */
export async function appendUserMessage(
  userId: string,
  panelId: string,
  input: {
    id: string;
    text: string;
    attachments: StoredAttachment[];
    mentionedGroupRoleIds?: string[];
  },
) {
  return mutateData((draft) => {
    const panel = requirePanelOwner(draft.panels, panelId, userId);
    const message: StoredMessage = {
      id: input.id,
      panelId,
      role: "user",
      text: input.text,
      createdAt: nowIso(),
      attachments: input.attachments,
      runId: null,
      state: null,
      draft: false,
      errorMessage: null,
      stopReason: null,
      usage: null,
      runtimeSteps: [],
      mentionedGroupRoleIds: input.mentionedGroupRoleIds ?? [],
      sessionMeta: null,
    };

    draft.messages.push(message);
    panel.updatedAt = nowIso();

    return messageToView(message);
  });
}

/**
 * 设置面板当前活跃的 runId。
 * 流式输出开始时设为 runId，结束时设为 null。
 * @param {string} panelId - 面板 ID
 * @param {string | null} runId - 活跃的 runId，传 null 表示清除
 * @returns {Promise<string | null>} 设置后的 activeRunId
 */
export async function setPanelActiveRun(
  panelId: string,
  runId: string | null,
) {
  return mutateData((draft) => {
    const panel = draft.panels.find((candidate) => candidate.id === panelId);
    if (!panel) {
      throw new Error("Panel not found.");
    }

    panel.activeRunId = runId;
    panel.updatedAt = nowIso();
    return panel.activeRunId;
  });
}

/**
 * 将指定 runId 加入面板的屏蔽列表（最多保留最近 20 个）。
 * 被屏蔽的 runId 后续的消息更新将被丢弃。
 * @param {string} panelId - 面板 ID
 * @param {string} runId - 要屏蔽的 runId
 * @returns {Promise<string[]>} 更新后的屏蔽 runId 列表
 */
export async function blockPanelRun(panelId: string, runId: string) {
  return mutateData((draft) => {
    const panel = draft.panels.find((candidate) => candidate.id === panelId);
    if (!panel) {
      throw new Error("Panel not found.");
    }

    const blockedRunIds = new Set(panel.blockedRunIds ?? []);
    blockedRunIds.add(runId);
    panel.blockedRunIds = Array.from(blockedRunIds).slice(-20);
    panel.updatedAt = nowIso();
    return panel.blockedRunIds;
  });
}

/**
 * 插入或更新助手消息，是消息持久化的核心方法。
 *
 * **匹配规则**：根据 panelId + runId 查找已有消息。
 * - **相同 runId** → 更新已有记录（覆盖 text，合并 attachments，更新 state/draft 等）。
 * - **不同 runId** → 创建新消息记录，对应 UI 中的新气泡。
 *
 * **序号守卫**：若 incoming seq < existing eventSeq，则丢弃本次更新（防止乱序覆盖）。
 *
 * **屏蔽检查**：若 runId 在面板的 blockedRunIds 列表中，直接返回 null。
 *
 * **附件合并**：通过签名去重（sourceUrl / storagePath / name:mimeType:size），
 * 重复附件的磁盘文件会被删除。
 *
 * @param {string} panelId - 面板 ID
 * @param {object} input - 消息数据
 * @param {string} input.runId - Gateway 运行 ID（或 customchat:UUID 回退标识）
 * @param {string} input.text - 消息文本内容
 * @param {StoredAttachment[]} [input.attachments] - 附件列表
 * @param {StoredMessage["state"]} input.state - 消息状态：delta / final / aborted / error
 * @param {boolean} input.draft - 是否为草稿（流式输出中为 true）
 * @param {string | null} [input.errorMessage] - 错误信息
 * @param {string | null} [input.stopReason] - 停止原因
 * @param {unknown} [input.usage] - Token 使用量统计
 * @param {number | null} [input.seq] - 事件序号，用于乱序保护
 * @returns {Promise<MessageView | null>} 消息视图，被屏蔽时返回 null
 */
export async function upsertAssistantMessage(
  panelId: string,
  input: {
    runId: string;
    text: string;
    attachments?: StoredAttachment[];
    state: StoredMessage["state"];
    draft: boolean;
    errorMessage?: string | null;
    stopReason?: string | null;
    usage?: unknown;
    seq?: number | null;
    groupRoleId?: string;
    senderLabel?: string;
    mentionedGroupRoleIds?: string[];
    sessionMeta?: MessageSessionMeta | null;
  },
) {
  log.input("upsertAssistantMessage", {
    panelId,
    runId: input.runId,
    state: String(input.state),
    draft: String(input.draft),
    seq: input.seq != null ? String(input.seq) : "null",
    textLen: String(input.text.length),
    attachmentCount: String(input.attachments?.length ?? 0),
  });
  return mutateData(async (draft) => {
    const panel = draft.panels.find((candidate) => candidate.id === panelId);
    if (!panel) {
      log.error("upsertAssistantMessage", new Error("Panel not found"), { panelId });
      throw new Error("Panel not found.");
    }

    if (isPanelRunBlocked(panel, input.runId)) {
      log.debug("upsertAssistantMessage", { result: "blocked", runId: input.runId });
      return null;
    }

    const existing = draft.messages.find(
      (message) =>
        message.panelId === panelId &&
        message.role === "assistant" &&
        message.runId === input.runId,
    );

    if (existing) {
      const incomingSeq = typeof input.seq === "number" ? input.seq : null;
      const existingSeq = typeof existing.eventSeq === "number" ? existing.eventSeq : null;
      if (
        incomingSeq !== null &&
        existingSeq !== null &&
        incomingSeq < existingSeq
      ) {
        log.debug("upsertAssistantMessage", {
          result: "seq rejected",
          runId: input.runId,
          incomingSeq: String(incomingSeq),
          existingSeq: String(existingSeq),
        });
        return messageToView(existing);
      }

      const incomingAttachments = input.attachments ?? [];
      const mergedAttachments = mergeStoredAttachments(
        existing.attachments,
        incomingAttachments,
      );

      if (existing.baseText !== undefined) {
        existing.text = [existing.baseText, input.text].filter(Boolean).join("\n\n");
      } else {
        existing.text = input.text || existing.text;
      }
      existing.attachments =
        incomingAttachments.length > 0
          ? mergedAttachments.attachments
          : existing.attachments;
      existing.state = input.state;
      existing.draft = input.draft;
      existing.errorMessage = input.errorMessage ?? null;
      existing.stopReason = input.stopReason ?? null;
      existing.usage = input.usage ?? null;
      existing.eventSeq =
        incomingSeq ?? existingSeq ?? existing.eventSeq ?? null;
      // Group fields: set once, don't overwrite on subsequent deltas
      if (input.groupRoleId && !existing.groupRoleId) {
        existing.groupRoleId = input.groupRoleId;
      }
      if (input.senderLabel && !existing.senderLabel) {
        existing.senderLabel = input.senderLabel;
      }
      if (input.mentionedGroupRoleIds && input.mentionedGroupRoleIds.length > 0) {
        existing.mentionedGroupRoleIds = input.mentionedGroupRoleIds;
      }
      if (input.sessionMeta !== undefined) {
        existing.sessionMeta = input.sessionMeta;
      }
      if (mergedAttachments.duplicateIncomingPaths.length > 0) {
        await deleteStoredFiles(mergedAttachments.duplicateIncomingPaths);
      }
      return messageToView(existing);
    }

    // We no longer automatically merge messages from different runs.
    // Each distinct runId will create a new message record in the database.

    const message: StoredMessage = {
      id: crypto.randomUUID(),
      panelId,
      role: "assistant",
      text: input.text,
      createdAt: nowIso(),
      attachments: input.attachments ?? [],
      runId: input.runId,
      state: input.state,
      draft: input.draft,
      errorMessage: input.errorMessage ?? null,
      stopReason: input.stopReason ?? null,
      usage: input.usage ?? null,
      eventSeq: typeof input.seq === "number" ? input.seq : null,
      runtimeSteps: [],
      groupRoleId: input.groupRoleId ?? null,
      senderLabel: input.senderLabel ?? null,
      mentionedGroupRoleIds: input.mentionedGroupRoleIds ?? [],
      sessionMeta: input.sessionMeta ?? null,
    };

    draft.messages.push(message);
    panel.updatedAt = nowIso();

    return messageToView(message);
  });
}

/**
 * 中止助手运行，将消息状态设为 aborted。
 * @param {string} panelId - 面板 ID
 * @param {string} runId - 要中止的 runId
 * @param {string} [stopReason="user aborted"] - 中止原因
 * @returns {Promise<MessageView | null>} 中止后的消息视图，消息不存在时返回 null
 */
export async function abortAssistantRun(
  panelId: string,
  runId: string,
  stopReason = "user aborted",
) {
  return mutateData((draft) => {
    const panel = draft.panels.find((candidate) => candidate.id === panelId);
    if (!panel) {
      throw new Error("Panel not found.");
    }

    const message = draft.messages.find(
      (candidate) =>
        candidate.panelId === panelId &&
        candidate.role === "assistant" &&
        candidate.runId === runId,
    );

    if (!message) {
      panel.updatedAt = nowIso();
      return null;
    }

    message.draft = false;
    message.state = "aborted";
    message.stopReason = stopReason;
    message.eventSeq = (message.eventSeq ?? 0) + 1;
    panel.updatedAt = nowIso();

    return messageToView(message);
  });
}

export async function upsertAssistantRuntimeSteps(
  panelId: string,
  runId: string,
  runtimeSteps: StoredRuntimeStep[],
) {
  return mutateData((draft) => {
    const panel = draft.panels.find((candidate) => candidate.id === panelId);
    if (!panel) {
      throw new Error("Panel not found.");
    }

    if (isPanelRunBlocked(panel, runId)) {
      return null;
    }

    let message = draft.messages.find(
      (candidate) =>
        candidate.panelId === panelId &&
        candidate.role === "assistant" &&
        candidate.runId === runId,
    );

    if (runtimeSteps.length === 0) {
      return message ? messageToView(message) : null;
    }

    if (!message) {
      message = {
        id: crypto.randomUUID(),
        panelId,
        role: "assistant",
        text: "",
        createdAt: nowIso(),
        attachments: [],
        runId,
        state: "delta",
        draft: true,
        errorMessage: null,
        stopReason: null,
        usage: null,
        eventSeq: null,
        runtimeSteps: [],
      };
      draft.messages.push(message);
    }

    const byId = new Map(
      sanitizeRuntimeSteps(message.runtimeSteps ?? []).map((step) => [step.id, step] as const),
    );
    for (const step of runtimeSteps) {
      const sanitized = sanitizeRuntimeSteps([step]);
      if (sanitized[0]) {
        const inc = sanitized[0];
        if (byId.has(inc.id)) {
          const existing = byId.get(inc.id)!;
          byId.set(inc.id, {
            ...inc,
            raw: { ...existing.raw, ...inc.raw },
          });
        } else {
          byId.set(inc.id, inc);
        }
      }
    }
    message.runtimeSteps = Array.from(byId.values())
      .sort((left, right) => left.ts - right.ts)
      .slice(-200);
    panel.updatedAt = nowIso();

    return messageToView(message);
  });
}

export async function setAssistantMessageSessionMeta(
  panelId: string,
  runId: string,
  sessionMeta: MessageSessionMeta | null,
) {
  return mutateData((draft) => {
    const panel = draft.panels.find((candidate) => candidate.id === panelId);
    if (!panel) {
      throw new Error("Panel not found.");
    }

    const message = draft.messages.find(
      (candidate) =>
        candidate.panelId === panelId &&
        candidate.role === "assistant" &&
        candidate.runId === runId,
    );

    if (!message) {
      return null;
    }

    message.sessionMeta = sessionMeta;
    panel.updatedAt = nowIso();

    return messageToView(message);
  });
}

export async function findAttachmentForUser(
  userId: string,
  attachmentId: string,
) {
  const data = await readData();
  const userPanelIds = new Set(
    data.panels
      .filter((panel) => panel.userId === userId)
      .map((panel) => panel.id),
  );

  for (const message of data.messages) {
    if (!userPanelIds.has(message.panelId)) {
      continue;
    }

    const attachment = message.attachments.find(
      (candidate) => candidate.id === attachmentId,
    );

    if (attachment) {
      return attachment;
    }
  }

  return null;
}

export async function persistUploadedFile(
  input: {
    userId: string;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  },
) {
  await ensureStorageReady();

  const attachmentId = crypto.randomUUID();
  const targetDir = input.mimeType.startsWith("audio/") ? getVoiceDir() : getUploadDir();
  const targetPath = path.join(targetDir, attachmentId);
  await fs.writeFile(targetPath, input.bytes);

  return {
    id: attachmentId,
    name: input.filename,
    mimeType: input.mimeType,
    size: input.bytes.byteLength,
    kind: classifyAttachment(input.mimeType),
    storagePath: targetPath,
    sourceUrl: null,
    createdAt: nowIso(),
  } satisfies StoredAttachment;
}

function decodeDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^,]*?),([\s\S]*)$/);
  if (!match) {
    return null;
  }

  const meta = match[1] ?? "";
  const payload = match[2] ?? "";
  const isBase64 = meta.split(";").includes("base64");
  const mimeType = meta.split(";")[0] || "application/octet-stream";

  try {
    const bytes = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { bytes, mimeType };
  } catch {
    return null;
  }
}

async function persistDownloadedFile(
  input: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    sourceUrl?: string | null;
  },
) {
  await ensureStorageReady();

  const attachmentId = crypto.randomUUID();
  const targetPath = path.join(getDownloadDir(), attachmentId);
  await fs.writeFile(targetPath, input.bytes);

  return {
    id: attachmentId,
    name: sanitizeFilename(input.filename),
    mimeType: input.mimeType,
    size: input.bytes.byteLength,
    kind: classifyAttachment(input.mimeType),
    storagePath: targetPath,
    sourceUrl: input.sourceUrl ?? null,
    createdAt: nowIso(),
  } satisfies StoredAttachment;
}

async function materializeAttachment(attachment: AttachmentView) {
  const sanitizedName = sanitizeFilename(attachment.name || "download");

  if (attachment.url.startsWith("data:")) {
    const decoded = decodeDataUrl(attachment.url);
    if (decoded) {
      return persistDownloadedFile({
        filename: sanitizedName,
        mimeType: decoded.mimeType || attachment.mimeType,
        bytes: decoded.bytes,
      });
    }
  }

  const localPath = toLocalFilePath(attachment.url);
  if (localPath) {
    try {
      const buffer = await fs.readFile(localPath);
      return persistDownloadedFile({
        filename: sanitizedName,
        mimeType: attachment.mimeType,
        bytes: new Uint8Array(buffer),
      });
    } catch {
      return {
        id: crypto.randomUUID(),
        name: sanitizedName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        kind: classifyAttachment(attachment.mimeType),
        storagePath: null,
        sourceUrl: attachment.url,
        createdAt: nowIso(),
      } satisfies StoredAttachment;
    }
  }

  return {
    id: crypto.randomUUID(),
    name: sanitizedName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: classifyAttachment(attachment.mimeType),
    storagePath: null,
    sourceUrl: attachment.url,
    createdAt: nowIso(),
  } satisfies StoredAttachment;
}

export async function materializeAttachmentViews(
  attachments: AttachmentView[],
) {
  if (attachments.length === 0) {
    return [];
  }

  const persisted: StoredAttachment[] = [];
  for (const attachment of attachments) {
    persisted.push(await materializeAttachment(attachment));
  }

  return persisted;
}

export async function materializeMessageAttachments(message: unknown) {
  return materializeAttachmentViews(
    extractMessageAttachments(message),
  );
}

export async function persistDownloadedBuffer(
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
) {
  return persistDownloadedFile({
    filename,
    mimeType,
    bytes,
  });
}

export async function listPanelMessages(panelId: string): Promise<MessageView[]> {
  const data = await readData();
  return data.messages
    .filter((message) => message.panelId === panelId)
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    )
    .map(messageToView);
}

export async function setGroupPanelTaskState(
  panelId: string,
  taskState: GroupTaskState,
): Promise<PanelView> {
  return mutateData((draft) => {
    const panel = draft.panels.find((candidate) => candidate.id === panelId);
    if (!panel || (panel.kind ?? "direct") !== "group") {
      throw new Error("Group panel not found.");
    }

    panel.taskState = normalizeGroupTaskState(taskState);
    panel.updatedAt = nowIso();

    return panelToView(
      panel,
      draft.messages.filter((message) => message.panelId === panel.id),
      { groupRoles: draft.groupRoles },
    );
  });
}

export async function listInProgressGroupPanels(): Promise<StoredPanel[]> {
  const data = await readData();
  return data.panels.filter(
    (panel) =>
      (panel.kind ?? "direct") === "group" &&
      normalizeGroupTaskState(panel.taskState) === "in_progress",
  );
}

// ────────────────────────────────────────────
// GroupRole CRUD
// ────────────────────────────────────────────

/**
 * 列出指定面板的所有群组角色。
 * @param {string} panelId - 群组面板 ID
 * @returns {Promise<StoredGroupRole[]>} 群组角色列表
 */
export async function listGroupRoles(panelId: string): Promise<StoredGroupRole[]> {
  const data = await readData();
  return data.groupRoles.filter((role) => role.panelId === panelId);
}

/**
 * 根据 ID 查找群组角色。
 * @param {string} groupRoleId - 群组角色 ID
 * @returns {Promise<StoredGroupRole | null>} 角色记录，未找到返回 null
 */
export async function findGroupRoleById(groupRoleId: string): Promise<StoredGroupRole | null> {
  const data = await readData();
  return data.groupRoles.find((role) => role.id === groupRoleId) ?? null;
}

/**
 * 创建新的群组角色。
 * @param {object} input - 角色信息
 * @param {string} input.panelId - 所属群组面板 ID
 * @param {string} input.agentId - 关联的 Agent ID
 * @param {string} input.title - 角色显示名
 * @param {string | null} [input.emoji] - Emoji 图标
 * @param {boolean} [input.isLeader] - 是否为组长
 * @returns {Promise<GroupRoleView>} 新创建的角色视图
 */
export async function createGroupRole(input: {
  panelId: string;
  agentId: string;
  title: string;
  emoji?: string | null;
  isLeader?: boolean;
}): Promise<GroupRoleView> {
  return mutateData((draft) => {
    const panel = draft.panels.find((p) => p.id === input.panelId);
    if (!panel) {
      throw new Error("Panel not found.");
    }

    // 如果新角色要设为 Leader，取消已有 Leader
    if (input.isLeader) {
      for (const role of draft.groupRoles) {
        if (role.panelId === input.panelId && role.isLeader) {
          role.isLeader = false;
          role.updatedAt = nowIso();
        }
      }
    }

    const now = nowIso();
    const role: StoredGroupRole = {
      id: crypto.randomUUID(),
      panelId: input.panelId,
      agentId: input.agentId,
      title: input.title.trim(),
      emoji: input.emoji ?? null,
      isLeader: input.isLeader ?? false,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    draft.groupRoles.push(role);
    panel.updatedAt = now;

    return groupRoleToView(role);
  });
}

/**
 * 更新群组角色信息。
 * @param {string} groupRoleId - 角色 ID
 * @param {object} input - 要更新的字段
 * @returns {Promise<GroupRoleView>} 更新后的角色视图
 */
export async function updateGroupRole(
  groupRoleId: string,
  input: {
    title?: string;
    emoji?: string | null;
    agentId?: string;
    enabled?: boolean;
  },
): Promise<GroupRoleView> {
  return mutateData((draft) => {
    const role = draft.groupRoles.find((r) => r.id === groupRoleId);
    if (!role) {
      throw new Error("Group role not found.");
    }

    if (typeof input.title === "string" && input.title.trim()) {
      role.title = input.title.trim();
    }
    if (input.emoji !== undefined) {
      role.emoji = input.emoji;
    }
    if (typeof input.agentId === "string") {
      role.agentId = input.agentId;
    }
    if (typeof input.enabled === "boolean") {
      role.enabled = input.enabled;
    }
    role.updatedAt = nowIso();

    return groupRoleToView(role);
  });
}

/**
 * 删除群组角色（硬删除）。
 * @param {string} groupRoleId - 角色 ID
 * @returns {Promise<{ok: true}>} 删除成功
 */
export async function removeGroupRole(groupRoleId: string): Promise<{ ok: true }> {
  return mutateData((draft) => {
    const index = draft.groupRoles.findIndex((r) => r.id === groupRoleId);
    if (index < 0) {
      throw new Error("Group role not found.");
    }
    draft.groupRoles.splice(index, 1);
    return { ok: true as const };
  });
}

/**
 * 设置指定角色为群组的 Leader。
 * 同一群组内仅允许一个 Leader，设置新 Leader 时自动取消旧 Leader。
 * @param {string} panelId - 群组面板 ID
 * @param {string} groupRoleId - 要设置为 Leader 的角色 ID
 * @returns {Promise<GroupRoleView>} 新 Leader 的角色视图
 */
export async function setGroupRoleLeader(
  panelId: string,
  groupRoleId: string,
): Promise<GroupRoleView> {
  return mutateData((draft) => {
    const role = draft.groupRoles.find(
      (r) => r.id === groupRoleId && r.panelId === panelId,
    );
    if (!role) {
      throw new Error("Group role not found in this panel.");
    }

    // 取消同面板内其他角色的 Leader 标记
    for (const r of draft.groupRoles) {
      if (r.panelId === panelId && r.isLeader && r.id !== groupRoleId) {
        r.isLeader = false;
        r.updatedAt = nowIso();
      }
    }

    role.isLeader = true;
    role.updatedAt = nowIso();

    return groupRoleToView(role);
  });
}

/**
 * 取消指定角色的 Leader 标记。
 * @param {string} panelId - 群组面板 ID
 * @param {string} groupRoleId - 角色 ID
 * @returns {Promise<GroupRoleView>} 更新后的角色视图
 */
export async function unsetGroupRoleLeader(
  panelId: string,
  groupRoleId: string,
): Promise<GroupRoleView> {
  return mutateData((draft) => {
    const role = draft.groupRoles.find(
      (r) => r.id === groupRoleId && r.panelId === panelId,
    );
    if (!role) {
      throw new Error("Group role not found in this panel.");
    }

    role.isLeader = false;
    role.updatedAt = nowIso();

    return groupRoleToView(role);
  });
}
