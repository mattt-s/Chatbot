/**
 * @module group-task
 * 群组任务状态与提示词辅助。
 */

import type { GroupTaskState } from "@/lib/types";

export const GROUP_TASK_COMPLETION_MARKER = "[TASK_COMPLETED]";
export const GROUP_TASK_IN_PROGRESS_MARKER = "[TASK_IN_PROGRESS]";
export const GROUP_TASK_REMINDER_AFTER_MS = 3 * 60_000;

export function normalizeGroupTaskState(taskState: GroupTaskState | null | undefined): GroupTaskState {
  if (taskState === "in_progress" || taskState === "completed") {
    return taskState;
  }
  return "idle";
}

export function getGroupTaskStateLabel(taskState: GroupTaskState | null | undefined): string {
  switch (normalizeGroupTaskState(taskState)) {
    case "in_progress":
      return "进行中";
    case "completed":
      return "已完成";
    default:
      return "空闲";
  }
}

export function getGroupTaskStateClassName(taskState: GroupTaskState | null | undefined): string {
  switch (normalizeGroupTaskState(taskState)) {
    case "in_progress":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "completed":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    default:
      return "bg-[var(--paper-2)] text-[var(--ink-soft)] border-black/8";
  }
}

export function messageMarksGroupTaskCompleted(text: string): boolean {
  return text.includes(GROUP_TASK_COMPLETION_MARKER);
}

export function messageMarksGroupTaskInProgress(text: string): boolean {
  return text.includes(GROUP_TASK_IN_PROGRESS_MARKER);
}

export function stripGroupTaskMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed !== GROUP_TASK_COMPLETION_MARKER &&
        trimmed !== GROUP_TASK_IN_PROGRESS_MARKER
      );
    })
    .join("\n")
    .trim();
}

export function buildLeaderProgressReminder(params: { leaderTitle: string; memberTitles: string[] }): string {
  const members = params.memberTitles.length > 0 ? params.memberTitles.join("、") : "其他成员";
  return [
    "[系统提醒]",
    `当前群任务仍处于进行中，最近 3 分钟群里没有新的进展消息。你是组长「${params.leaderTitle}」。`,
    `请立即判断是否需要催促 ${members} 汇报当前任务进度。`,
    "如果需要继续协作，请直接给对应成员分派任务，并要求他们向你汇报进度。",
    `如果任务仍在推进、但当前需要继续跟进，请在回复末尾单独另起一行输出 ${GROUP_TASK_IN_PROGRESS_MARKER}。`,
    `只有当整个群任务确实完成时，才在回复末尾单独另起一行输出 ${GROUP_TASK_COMPLETION_MARKER}。`,
    `同一条回复里不要同时输出 ${GROUP_TASK_IN_PROGRESS_MARKER} 和 ${GROUP_TASK_COMPLETION_MARKER}。`,
  ].join("\n");
}
