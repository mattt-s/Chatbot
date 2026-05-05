/**
 * @module task-mode/plan-store
 * TaskModePlan CRUD。所有写操作在持久化后触发 publishGroupPlanUpdate。
 */
import "server-only";

import { createLogger } from "@/lib/logger";
import { mutateTaskModePlans, readTaskModePlan } from "@/lib/store";
import {
  emptyTaskModePlan,
  type TaskModePlan,
  type TaskModePlanField,
} from "@/lib/task-mode/types";
import { publishGroupPlanUpdate } from "@/lib/task-mode/sse";

const log = createLogger("task-mode:plan-store");

/** 获取面板的 Plan，不存在则返回 null。 */
export async function getTaskModePlan(panelId: string): Promise<TaskModePlan | null> {
  return readTaskModePlan(panelId);
}

/** 获取面板的 Plan，不存在则自动创建并持久化一个空 Plan。 */
export async function getOrCreateTaskModePlan(panelId: string): Promise<TaskModePlan> {
  const existing = await readTaskModePlan(panelId);
  if (existing) return existing;

  const plan = emptyTaskModePlan(panelId);
  await mutateTaskModePlans((plans) => {
    plans.push(plan);
  });

  log.debug("getOrCreateTaskModePlan.created", { panelId });
  return plan;
}

/**
 * 更新 Plan 的某个字段。
 * - goal: string（直接替换）
 * - constraints / deliverables / acceptanceCriteria / taskOutline: string[]（直接替换）
 */
export async function updateTaskModePlanField(
  panelId: string,
  field: TaskModePlanField,
  value: string | string[],
): Promise<TaskModePlan> {
  const updated = await mutateTaskModePlans((plans) => {
    let plan = plans.find((p) => p.panelId === panelId);
    if (!plan) {
      plan = emptyTaskModePlan(panelId);
      plans.push(plan);
    }

    if (field === "goal") {
      plan.goal = typeof value === "string" ? value : value.join("\n");
    } else {
      const arr = Array.isArray(value)
        ? value
        : [value].filter(Boolean);
      (plan as unknown as Record<string, unknown>)[field] = arr;
    }

    return structuredClone(plan);
  });

  log.debug("updateTaskModePlanField", { panelId, field });
  publishGroupPlanUpdate(panelId);
  return updated;
}

/** 将 Plan 标记为 confirmed，阻止后续修改并解锁 create_task。 */
export async function confirmTaskModePlan(panelId: string): Promise<TaskModePlan> {
  const updated = await mutateTaskModePlans((plans) => {
    let plan = plans.find((p) => p.panelId === panelId);
    if (!plan) {
      plan = emptyTaskModePlan(panelId);
      plans.push(plan);
    }
    plan.status = "confirmed";
    plan.confirmedAt = new Date().toISOString();
    return structuredClone(plan);
  });

  log.debug("confirmTaskModePlan", { panelId });
  publishGroupPlanUpdate(panelId);
  return updated;
}
