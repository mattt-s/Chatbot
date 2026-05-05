/**
 * @module task-mode/plan-rpc-handlers
 * task_plan.* RPC handler。
 * Leader 在规划阶段调用 task_plan(update_field) 更新 TaskModePlan 字段。
 */
import "server-only";

import { updateTaskModePlanField } from "@/lib/task-mode/plan-store";
import { TASK_PLAN_FIELDS, type TaskModePlanField } from "@/lib/task-mode/types";
import { createLogger } from "@/lib/logger";

const log = createLogger("task-mode:plan-rpc");

type AppRpcParams = Record<string, unknown>;

function readStr(params: AppRpcParams, key: string): string {
  return typeof params[key] === "string" ? (params[key] as string).trim() : "";
}

export async function handleTaskPlanUpdateField(params: AppRpcParams) {
  const panelId = readStr(params, "panelId");
  if (!panelId) throw new Error("task_plan.update_field: panelId is required.");

  const field = readStr(params, "field") as TaskModePlanField;
  if (!TASK_PLAN_FIELDS.includes(field)) {
    throw new Error(`task_plan.update_field: invalid field "${field}". Must be one of: ${TASK_PLAN_FIELDS.join(", ")}`);
  }

  const raw = params.value;
  let value: string | string[];

  if (field === "goal") {
    value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("\n") : "";
  } else {
    value = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === "string")
      : typeof raw === "string"
      ? raw.split("\n").map((s) => s.trim()).filter(Boolean)
      : [];
  }

  const updated = await updateTaskModePlanField(panelId, field, value);

  log.input("handleTaskPlanUpdateField", { panelId, field });

  return { ok: true, plan: updated };
}
