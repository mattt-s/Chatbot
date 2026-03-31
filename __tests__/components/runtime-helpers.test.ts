import { describe, it, expect } from "vitest";
import {
  describeRuntimeData,
  isAssistantTextStep,
  isIgnorableRuntimeStep,
  normalizeRuntimeStepForDisplay,
  hasMessageToolRuntimeStep,
} from "@/components/runtime-helpers";
import type { StoredRuntimeStep } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<StoredRuntimeStep> = {}): StoredRuntimeStep {
  return {
    id: "s1",
    runId: "run-1",
    ts: 1000,
    stream: "tool",
    kind: "step",
    title: "Step",
    description: "",
    detail: null,
    status: "info",
    raw: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// describeRuntimeData
// ---------------------------------------------------------------------------

describe("describeRuntimeData", () => {
  it("recognizes lifecycle start", () => {
    const result = describeRuntimeData("lifecycle", { phase: "start" });
    expect(result.kind).toBe("process");
    expect(result.status).toBe("running");
    expect(result.description).toBe("started");
  });

  it("recognizes lifecycle end", () => {
    const result = describeRuntimeData("lifecycle", { phase: "end" });
    expect(result.kind).toBe("process");
    expect(result.status).toBe("done");
    expect(result.description).toBe("completed");
  });

  it("detects exec kind from command", () => {
    const result = describeRuntimeData("tool", {
      tool: "bash",
      command: "ls -la",
      phase: "end",
      exitCode: 0,
    });
    expect(result.kind).toBe("exec");
    expect(result.title).toBe("Exec");
    expect(result.status).toBe("done");
  });

  it("detects exec error from exitCode", () => {
    const result = describeRuntimeData("tool", {
      tool: "bash",
      command: "false",
      exitCode: 1,
      error: "command failed",
    });
    expect(result.kind).toBe("exec");
    expect(result.status).toBe("error");
  });

  it("detects write kind", () => {
    const result = describeRuntimeData("tool", {
      tool: "write_file",
      path: "/tmp/out.txt",
      phase: "end",
    });
    expect(result.kind).toBe("write");
    expect(result.title).toBe("Write");
    expect(result.description).toContain("/tmp/out.txt");
  });

  it("detects read kind", () => {
    const result = describeRuntimeData("tool", {
      tool: "read_file",
      path: "/tmp/in.txt",
    });
    expect(result.kind).toBe("read");
    expect(result.title).toBe("Read");
  });

  it("detects edit kind", () => {
    const result = describeRuntimeData("tool", {
      tool: "edit",
      path: "/tmp/file.ts",
    });
    expect(result.kind).toBe("edit");
    expect(result.title).toBe("Edit");
  });

  it("detects search kind", () => {
    const result = describeRuntimeData("tool", {
      tool: "grep",
      query: "TODO",
      phase: "end",
    });
    expect(result.kind).toBe("search");
    expect(result.title).toBe("Search");
    expect(result.description).toBe("TODO");
  });

  it("detects process kind", () => {
    const result = describeRuntimeData("tool", {
      tool: "session",
      process: "agent-main",
    });
    expect(result.kind).toBe("process");
    expect(result.title).toBe("Process");
  });

  it("falls back to step for unknown tools", () => {
    const result = describeRuntimeData("tool", {
      tool: "custom_tool",
      summary: "doing something",
    });
    expect(result.kind).toBe("step");
    expect(result.description).toContain("custom_tool");
  });

  it("handles error in generic step", () => {
    const result = describeRuntimeData("tool", {
      error: "something went wrong",
      tool: "broken_tool",
    });
    expect(result.status).toBe("error");
    expect(result.description).toContain("something went wrong");
  });

  it("falls back to stream name for description", () => {
    const result = describeRuntimeData("my_stream", {});
    expect(result.kind).toBe("step");
    expect(result.description).toBe("my stream");
  });
});

// ---------------------------------------------------------------------------
// isAssistantTextStep
// ---------------------------------------------------------------------------

describe("isAssistantTextStep", () => {
  it("returns true for assistant-text stream", () => {
    expect(isAssistantTextStep(makeStep({ stream: "assistant-text" }))).toBe(true);
  });

  it("returns true for assistant-text raw type", () => {
    expect(
      isAssistantTextStep(makeStep({ raw: { type: "assistant-text" } }))
    ).toBe(true);
  });

  it("returns false for tool stream", () => {
    expect(isAssistantTextStep(makeStep({ stream: "tool" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isIgnorableRuntimeStep
// ---------------------------------------------------------------------------

describe("isIgnorableRuntimeStep", () => {
  it("ignores assistant stream", () => {
    expect(isIgnorableRuntimeStep(makeStep({ stream: "assistant" }))).toBe(true);
  });

  it("ignores lifecycle stream", () => {
    expect(isIgnorableRuntimeStep(makeStep({ stream: "lifecycle" }))).toBe(true);
  });

  it("ignores assistant raw type", () => {
    expect(
      isIgnorableRuntimeStep(makeStep({ raw: { type: "assistant" } }))
    ).toBe(true);
  });

  it("keeps tool stream", () => {
    expect(isIgnorableRuntimeStep(makeStep({ stream: "tool" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeRuntimeStepForDisplay
// ---------------------------------------------------------------------------

describe("normalizeRuntimeStepForDisplay", () => {
  it("returns assistant-text steps as-is", () => {
    const step = makeStep({ stream: "assistant-text", raw: { type: "assistant-text" } });
    const result = normalizeRuntimeStepForDisplay(step);
    expect(result).toBe(step);
  });

  it("enriches tool steps via describeRuntimeData", () => {
    const step = makeStep({
      stream: "tool",
      raw: { tool: "bash", command: "echo hi", phase: "end", exitCode: 0 },
    });
    const result = normalizeRuntimeStepForDisplay(step);
    expect(result.kind).toBe("exec");
    expect(result.title).toBe("Exec");
    expect(result.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// hasMessageToolRuntimeStep
// ---------------------------------------------------------------------------

describe("hasMessageToolRuntimeStep", () => {
  it("returns true when a step has tool=message", () => {
    const steps = [
      makeStep({ raw: { tool: "message" } }),
    ];
    expect(hasMessageToolRuntimeStep(steps)).toBe(true);
  });

  it("returns true when a step has name=message", () => {
    const steps = [
      makeStep({ raw: { name: "message" } }),
    ];
    expect(hasMessageToolRuntimeStep(steps)).toBe(true);
  });

  it("returns false when no message tool", () => {
    const steps = [
      makeStep({ raw: { tool: "bash" } }),
      makeStep({ raw: { tool: "read_file" } }),
    ];
    expect(hasMessageToolRuntimeStep(steps)).toBe(false);
  });

  it("returns false for empty steps", () => {
    expect(hasMessageToolRuntimeStep([])).toBe(false);
  });
});
