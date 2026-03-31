import { describe, expect, it } from "vitest";

import {
  GROUP_TASK_COMPLETION_MARKER,
  messageMarksGroupTaskCompleted,
  normalizeGroupTaskState,
  stripGroupTaskMarkers,
} from "@/lib/group-task";

describe("group-task", () => {
  it("识别 leader 完成标记", () => {
    expect(messageMarksGroupTaskCompleted(`已完成\n${GROUP_TASK_COMPLETION_MARKER}`)).toBe(true);
    expect(messageMarksGroupTaskCompleted("未完成")).toBe(false);
  });

  it("移除完成标记，不影响正文", () => {
    expect(stripGroupTaskMarkers(`阶段总结\n\n${GROUP_TASK_COMPLETION_MARKER}`)).toBe("阶段总结");
  });

  it("标准化任务状态", () => {
    expect(normalizeGroupTaskState(undefined)).toBe("idle");
    expect(normalizeGroupTaskState("in_progress")).toBe("in_progress");
  });
});
