/**
 * 应用核心类型定义模块。
 * 包含存储层数据结构、前端视图模型、以及 SSE 事件载荷的类型声明。
 */

/** 附件类型 */
export type AttachmentKind = "image" | "audio" | "video" | "file";

/** 频道状态 */
export type ChannelState = "passive";

/** 聊天运行状态：delta=流式传输中, final=完成, aborted=中断, error=出错 */
export type ChatRunState = "delta" | "final" | "aborted" | "error";

/** 消息角色 */
export type MessageRole = "user" | "assistant" | "system";

/** 运行时步骤类型 */
export type RuntimeStepKind =
  | "exec"
  | "write"
  | "read"
  | "edit"
  | "process"
  | "search"
  | "step";

/** 运行时步骤状态 */
export type RuntimeStepStatus = "running" | "done" | "info" | "error";

/** 存储层：Agent 运行时步骤（工具调用等） */
export interface StoredRuntimeStep {
  /** 步骤唯一标识 */
  id: string;
  /** 所属运行的 ID */
  runId: string;
  /** 时间戳（毫秒） */
  ts: number;
  /** 来源事件流名称 */
  stream: string;
  /** 步骤类型 */
  kind: RuntimeStepKind;
  /** 步骤标题 */
  title: string;
  /** 步骤描述 */
  description: string;
  /** 详细信息，可为空 */
  detail: string | null;
  /** 步骤状态 */
  status: RuntimeStepStatus;
  /** 原始事件数据 */
  raw: Record<string, unknown>;
}

/** 存储层：用户记录 */
export interface StoredUser {
  id: string;
  email: string;
  displayName: string;
  /** bcrypt 哈希后的密码 */
  passwordHash: string;
  /** ISO 8601 创建时间 */
  createdAt: string;
}

/** 存储层：附件记录 */
export interface StoredAttachment {
  id: string;
  /** 文件名 */
  name: string;
  /** MIME 类型，如 image/png */
  mimeType: string;
  /** 文件大小（字节） */
  size: number;
  kind: AttachmentKind;
  /** 本地存储路径，可为空（外部链接时） */
  storagePath: string | null;
  /** 外部源 URL */
  sourceUrl?: string | null;
  createdAt: string;
}

/** 存储层：消息记录 */
export interface StoredMessage {
  id: string;
  /** 所属面板 ID */
  panelId: string;
  role: MessageRole;
  /** 消息正文 */
  text: string;
  createdAt: string;
  attachments: StoredAttachment[];
  /** Gateway 运行 ID，用于关联流式更新 */
  runId: string | null;
  /** 当前运行状态 */
  state: ChatRunState | null;
  /** 是否为草稿（流式传输中为 true） */
  draft: boolean;
  errorMessage: string | null;
  /** 停止原因，如 toolUse、endTurn 等 */
  stopReason: string | null;
  /** token 用量统计 */
  usage: unknown;
  /** 事件序列号，用于防止乱序覆盖 */
  eventSeq?: number | null;
  /** 运行时步骤列表（工具调用等） */
  runtimeSteps?: StoredRuntimeStep[];
  /** 基础文本，用于追加模式（预留） */
  baseText?: string;
  /** 群组角色 ID（群组消息时非空） */
  groupRoleId?: string | null;
  /** 发送者名字快照（群组消息时使用） */
  senderLabel?: string | null;
  /** 末尾 @ 了哪些角色（供前端右下角展示） */
  mentionedGroupRoleIds?: string[];
  /** 终态后补写的 session 概览信息，用于气泡底部展示 */
  sessionMeta?: MessageSessionMeta | null;
}

/** 面板类型：direct=一对一对话, group=群组 */
export type PanelKind = "direct" | "group";
export type GroupTaskState = "idle" | "in_progress" | "waiting_input" | "blocked" | "pending_review" | "completed";
export type GroupPlanItemStatus = "pending" | "in_progress" | "done" | "blocked";

export interface GroupPlanItem {
  title: string;
  status: GroupPlanItemStatus;
}

export interface GroupPlan {
  summary: string;
  items: GroupPlanItem[];
  updatedAt: string;
  updatedByLabel?: string | null;
}

/** 存储层：聊天面板（对话会话） */
export interface StoredPanel {
  id: string;
  /** 所属用户 ID */
  userId: string;
  /** 面板标题 */
  title: string;
  /** 关联的 Agent ID（群组时为 ""） */
  agentId: string;
  /** Gateway 会话标识 */
  sessionKey: string;
  /** 面板类型，默认 "direct" */
  kind?: PanelKind;
  /** 群任务状态，仅群组使用 */
  taskState?: GroupTaskState;
  /** 群任务状态最近一次变化时间，仅群组使用 */
  taskStateChangedAt?: string;
  /** 群计划，仅群组使用 */
  groupPlan?: GroupPlan | null;
  /** 用户角色显示名 */
  userRoleName?: string;
  /** 助手角色显示名 */
  assistantRoleName?: string;
  /** 当前活跃运行 ID（流式进行中时非空） */
  activeRunId: string | null;
  /** 被阻塞的运行 ID 列表 */
  blockedRunIds?: string[];
  createdAt: string;
  updatedAt: string;
}

/** 存储层：群组角色记录 */
export interface StoredGroupRole {
  id: string;
  /** 所属群组面板 ID */
  panelId: string;
  /** 关联的 Agent ID */
  agentId: string;
  /** 角色显示名（同时用于 @mention 匹配） */
  title: string;
  /** Emoji 图标 */
  emoji?: string | null;
  /** 是否为组长（每个群组有且仅有一个） */
  isLeader?: boolean;
  /** 是否启用（软删除） */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAppSettings {
  appDebugEnabled?: boolean;
  groupRoleWatchdogIntervalMs?: number;
  groupRoleBusyInspectAfterMs?: number;
  groupRoleBusyAbortAfterMs?: number;
  updatedAt?: string;
}

/** 应用持久化数据的顶层结构（app-data.json） */
export interface AppData {
  users: StoredUser[];
  panels: StoredPanel[];
  messages: StoredMessage[];
  /** 群组角色列表 */
  groupRoles: StoredGroupRole[];
  settings?: StoredAppSettings;
}

/** 会话中的用户信息（不含敏感字段） */
export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

/** 前端视图：附件（含访问 URL） */
export interface AttachmentView {
  id: string;
  name: string;
  mimeType: string;
  /** 文件大小（字节） */
  size: number;
  kind: AttachmentKind;
  /** 可访问的附件 URL */
  url: string;
  /** 本地文件路径（若存储在服务端磁盘） */
  localPath?: string | null;
}

/** 前端视图：消息 */
export interface MessageView {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: string;
  attachments: AttachmentView[];
  runId: string | null;
  state: ChatRunState | null;
  /** 流式传输中为 true */
  draft: boolean;
  errorMessage: string | null;
  stopReason: string | null;
  usage: unknown;
  eventSeq?: number | null;
  runtimeSteps: StoredRuntimeStep[];
  /** 群组角色 ID */
  groupRoleId?: string | null;
  /** 发送者名字快照 */
  senderLabel?: string | null;
  /** 末尾 @ 了哪些角色 ID */
  mentionedGroupRoleIds?: string[];
  /** 终态后补写的 session 概览信息 */
  sessionMeta?: MessageSessionMeta | null;
}

export interface MessageSessionMeta {
  model: string | null;
  contextUsedTokens: number | null;
  contextMaxTokens: number | null;
  contextPercent: number | null;
  compactions: number | null;
}

/** 前端视图：群组角色 */
export interface GroupRoleView {
  id: string;
  panelId: string;
  agentId: string;
  title: string;
  emoji: string | null;
  isLeader: boolean;
  enabled: boolean;
  runtimeStatus?: "idle" | "busy" | "checking" | "aborting";
  activeRunId?: string | null;
  busyAgeMs?: number | null;
  runtimeSource?: "local" | "verified";
  runtimeNote?: string | null;
}

/** 前端视图：聊天面板 */
export interface PanelView {
  id: string;
  title: string;
  agentId: string;
  sessionKey: string;
  /** 面板类型 */
  kind: PanelKind;
  /** 群任务状态，仅 kind="group" 时有效 */
  taskState?: GroupTaskState;
  /** 群计划，仅 kind="group" 时有效 */
  groupPlan?: GroupPlan | null;
  userRoleName: string;
  assistantRoleName: string;
  /** 当前活跃运行 ID */
  activeRunId: string | null;
  /** 消息总数 */
  messageCount: number;
  /** 最新消息预览文本 */
  latestMessagePreview: string | null;
  /** 消息列表是否已加载 */
  messagesLoaded: boolean;
  createdAt: string;
  updatedAt: string;
  messages: MessageView[];
  /** 群组角色列表（仅 kind="group" 时填充） */
  groupRoles?: GroupRoleView[];
}

/** 前端视图：Agent 信息 */
export interface AgentView {
  id: string;
  /** Agent 显示名称 */
  name: string;
  /** Emoji 图标，可为空 */
  emoji: string | null;
  /** 头像 URL，可为空 */
  avatarUrl: string | null;
  /** UI 主题标识，可为空 */
  theme: string | null;
}

/** 前端视图：频道状态 */
export interface ChannelView {
  /** 频道模式 */
  mode: "provider";
  state: ChannelState;
  /** 频道显示标签 */
  label: string;
  errorMessage: string | null;
}

/** 仪表盘页面所需的聚合数据 */
export interface DashboardData {
  /** 当前登录用户 */
  user: SessionUser;
  /** 可用 Agent 列表 */
  agents: AgentView[];
  /** 用户的聊天面板列表 */
  panels: PanelView[];
  /** 频道状态 */
  channel: ChannelView;
}

export interface AppSettingsView {
  appDebugEnabled: boolean;
  groupRoleWatchdogIntervalMs: number;
  groupRoleBusyInspectAfterMs: number;
  groupRoleBusyAbortAfterMs: number;
}

/** SSE 聊天事件载荷，由 customchat-ingest 发布到前端 */
export interface ChatEventPayload {
  /** Gateway 运行 ID */
  runId: string;
  /** Gateway 会话标识 */
  sessionKey: string;
  /** 事件序列号（递增） */
  seq: number;
  /** 运行状态 */
  state: ChatRunState;
  /** 消息内容（文本或结构化） */
  message?: unknown;
  attachments?: AttachmentView[];
  runtimeSteps?: StoredRuntimeStep[];
  errorMessage?: string;
  /** token 用量 */
  usage?: unknown;
  stopReason?: string;
  /** 群组角色 ID */
  groupRoleId?: string;
  /** 发送者名字快照 */
  senderLabel?: string;
  /** 末尾 @ 了哪些角色 ID */
  mentionedGroupRoleIds?: string[];
  /** 终态后补写的 session 概览信息 */
  sessionMeta?: MessageSessionMeta | null;
}

/** 日志尾部读取的响应结构 */
export interface LogsTailResponse {
  /** 日志文件路径 */
  file: string;
  /** 当前读取位置（字节偏移） */
  cursor: number;
  /** 文件总大小 */
  size: number;
  /** 返回的日志行 */
  lines: string[];
  /** 是否因行数限制而截断 */
  truncated?: boolean;
  /** 文件是否被重置（如 logrotate），需从头读取 */
  reset?: boolean;
}
