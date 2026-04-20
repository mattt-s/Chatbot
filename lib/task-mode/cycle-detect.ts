/**
 * @module task-mode/cycle-detect
 * 任务依赖图的循环依赖检测（DFS）。
 * 仅在 add_dependency / block_on 时触发，create_task 不需要（新任务无入边）。
 */

import type { StoredGroupTask } from "@/lib/task-mode/types";

/**
 * 检测给某个已存在任务追加依赖是否会形成循环。
 *
 * 即检测：add_dependency(taskId=X, dependsOnTaskId=Y) 是否成环。
 * 核心问题：X 是否出现在 Y 的上游链路中（即 Y 已经间接依赖 X）。
 *
 * @param tasks 当前面板的全量任务列表
 * @param taskId 要追加依赖的任务 X
 * @param newDependsOnTaskId 新的前置任务 Y
 * @returns 若存在循环，返回循环路径描述；否则返回 null
 */
export function detectCycle(
  tasks: StoredGroupTask[],
  taskId: string,
  newDependsOnTaskId: string,
): string | null {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // BFS/DFS 从 Y 出发，沿 dependsOnTaskIds 向上游走，看能否到达 X
  const visited = new Set<string>();
  const path: string[] = [newDependsOnTaskId];
  const stack: string[] = [newDependsOnTaskId];

  while (stack.length > 0) {
    const current = stack.pop()!;

    if (current === taskId) {
      // 找到了循环，构造路径描述
      const cycleDesc = [...path, taskId]
        .map((id) => {
          const t = taskMap.get(id);
          return t ? `"${t.title}"(${id.slice(0, 8)})` : id.slice(0, 8);
        })
        .join(" → ");
      return `循环依赖：${cycleDesc}`;
    }

    if (visited.has(current)) continue;
    visited.add(current);

    const currentTask = taskMap.get(current);
    if (!currentTask) continue;

    for (const depId of currentTask.dependsOnTaskIds) {
      if (!visited.has(depId)) {
        stack.push(depId);
      }
    }
  }

  return null;
}
