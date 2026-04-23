/**
 * @module task-mode/types
 * 任务模式专属类型定义。
 * 这些类型仅用于任务驱动协作模式（groupMode="task"），与聊天模式完全隔离。
 */

// ─────────────────────────────────────────────────────────────
// 任务状态
// ─────────────────────────────────────────────────────────────

export type GroupTaskStatus =
  | "created"            // 已创建，等待前置任务完成
  | "assigned"           // 已分配，等待认领
  | "in_progress"        // 执行中
  | "blocked"            // 执行中发现阻塞，等待新增前置任务完成后自动恢复
  | "submitted"          // 已提交，等待验收
  | "reviewing"          // 验收者审核中
  | "done"               // 已完成（终态）
  | "rejected"           // 退回，自动 dispatch 给 assignee 重新执行（非终态）
  | "needs_intervention" // watchdog 达到重试上限，需用户介入（准终态）
  | "cancelled";         // 用户主动放弃，永久终止（终态）

/** 真正的终态：不会再自动转换，可触发队列释放和下游依赖 */
export const TASK_TERMINAL_STATUSES = new Set<GroupTaskStatus>(["done", "cancelled"]);

/** 准终态：app 不再自动 dispatch，但用户可以恢复 */
export const TASK_QUASI_TERMINAL_STATUSES = new Set<GroupTaskStatus>(["needs_intervention"]);

/** 未完成任务的状态（角色删除前需检查） */
export const TASK_INCOMPLETE_STATUSES = new Set<GroupTaskStatus>([
  "created",
  "assigned",
  "in_progress",
  "blocked",
  "submitted",
  "reviewing",
  "rejected",
  "needs_intervention",
]);

// ─────────────────────────────────────────────────────────────
// 事件类型
// ─────────────────────────────────────────────────────────────

export type GroupTaskEventType =
  | "created"
  | "assigned"
  | "started"
  | "submitted"
  | "approved"
  | "rejected"
  | "blocked"
  | "dependency_added"
  | "watchdog_redispatched"
  | "watchdog_in_progress_retry"
  | "needs_intervention"
  | "cancelled"
  | "comment";

// ─────────────────────────────────────────────────────────────
// 存储层类型
// ─────────────────────────────────────────────────────────────

export interface GroupTaskTextOutput {
  id: string;
  /** 角色 ID（通常就是 assigneeRoleId） */
  roleId: string;
  roleTitle: string;
  /** 本次 session 产出的完整文本 */
  text: string;
  /** 关联的 runId，便于按 run 追溯 */
  runId?: string;
  ts: string;
}

export interface GroupTaskEvent {
  id: string;
  type: GroupTaskEventType;
  actorRoleId: string;
  actorRoleTitle: string;
  note?: string;
  ts: string;
}

export interface StoredGroupTask {
  id: string;
  panelId: string;
  title: string;
  /** 任务描述，包含上下文和验收标准 */
  description: string;
  status: GroupTaskStatus;
  creatorRoleId: string;
  creatorRoleTitle: string;
  /** 执行者 */
  assigneeRoleId?: string;
  assigneeRoleTitle?: string;
  /**
   * 验收者。autoApprove=false 时必填，且不能与 assigneeRoleId 相同。
   * autoApprove=true 时忽略此字段（提交即通过）。
   */
  reviewerRoleId?: string;
  reviewerRoleTitle?: string;
  /** 父任务 ID（成员提子任务时填写） */
  parentTaskId?: string;
  /**
   * 前置任务 ID 列表，所有前置任务均 done 后才自动触发本任务。
   * 循环依赖检测：add_dependency / block_on 时触发。
   */
  dependsOnTaskIds: string[];
  /**
   * true = 提交即通过，无需验收者审核。
   * 任何创建者均可设置；autoApprove=false 时 assignee ≠ reviewer 由代码强制保证。
   */
  autoApprove: boolean;
  submissionNote?: string;
  reviewNote?: string;
  /**
   * assignee 在执行本任务过程中产生的自然语言输出。
   * ingest state=final 且 textLen>0 时追加。
   */
  textOutputs: GroupTaskTextOutput[];
  /**
   * 当前活跃 dispatch 绑定的 Gateway runId。
   * dispatch 后写入，任务终态时清空。
   */
  activeRunId?: string | null;
  /** watchdog 已重试 dispatch 的次数，达到阈值后置为 needs_intervention */
  watchdogRetryCount: number;
  /** 最近一次 dispatch 时间戳，watchdog 5 分钟兜底据此判断 */
  lastDispatchAt?: string;
  /** 完整事件日志 */
  events: GroupTaskEvent[];
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────
// 前端视图类型
// ─────────────────────────────────────────────────────────────

/** 群组状态聚合（任务模式专属，按优先级降序） */
export type GroupTaskModeState =
  | "needs_user"         // 有 needs_intervention 任务
  | "blocked"            // 有 blocked 任务，无 in_progress
  | "in_progress"        // 有 assigned/in_progress/submitted/reviewing 任务
  | "waiting_dependency" // 仅有 created 任务（等前置）
  | "idle";              // 无任务或全部 done/cancelled

export interface GroupTaskView {
  id: string;
  panelId: string;
  title: string;
  description: string;
  status: GroupTaskStatus;
  creatorRoleId: string;
  creatorRoleTitle: string;
  assigneeRoleId?: string;
  assigneeRoleTitle?: string;
  reviewerRoleId?: string;
  reviewerRoleTitle?: string;
  parentTaskId?: string;
  dependsOnTaskIds: string[];
  autoApprove: boolean;
  submissionNote?: string;
  reviewNote?: string;
  textOutputs: GroupTaskTextOutput[];
  watchdogRetryCount: number;
  lastDispatchAt?: string;
  events: GroupTaskEvent[];
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

export function taskToView(task: StoredGroupTask): GroupTaskView {
  return {
    id: task.id,
    panelId: task.panelId,
    title: task.title,
    description: task.description,
    status: task.status,
    creatorRoleId: task.creatorRoleId,
    creatorRoleTitle: task.creatorRoleTitle,
    assigneeRoleId: task.assigneeRoleId,
    assigneeRoleTitle: task.assigneeRoleTitle,
    reviewerRoleId: task.reviewerRoleId,
    reviewerRoleTitle: task.reviewerRoleTitle,
    parentTaskId: task.parentTaskId,
    dependsOnTaskIds: task.dependsOnTaskIds,
    autoApprove: task.autoApprove,
    submissionNote: task.submissionNote,
    reviewNote: task.reviewNote,
    textOutputs: task.textOutputs,
    watchdogRetryCount: task.watchdogRetryCount,
    lastDispatchAt: task.lastDispatchAt,
    events: task.events,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * 从任务列表派生群组级聚合状态（按优先级）。
 */
export function deriveGroupTaskModeState(tasks: StoredGroupTask[]): GroupTaskModeState {
  const active = tasks.filter((t) => !TASK_TERMINAL_STATUSES.has(t.status));

  if (active.some((t) => t.status === "needs_intervention")) return "needs_user";
  if (
    active.some((t) => t.status === "blocked") &&
    !active.some((t) => t.status === "in_progress")
  ) {
    return "blocked";
  }
  if (
    active.some((t) =>
      ["assigned", "in_progress", "submitted", "reviewing"].includes(t.status),
    )
  ) {
    return "in_progress";
  }
  if (active.some((t) => t.status === "created")) return "waiting_dependency";
  return "idle";
}
