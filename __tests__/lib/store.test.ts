import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppData, StoredAttachment, StoredRuntimeStep } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mock dependencies BEFORE importing store
// ---------------------------------------------------------------------------

// Mock "server-only" (Next.js guard that throws in test)
vi.mock("server-only", () => ({}));

// Mock fs
const mockFs = {
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
};
vi.mock("node:fs/promises", () => ({ default: mockFs, ...mockFs }));

// Mock env
vi.mock("@/lib/env", () => ({
  getStorageDir: () => "/tmp/test-storage",
  getUploadDir: () => "/tmp/test-storage/uploads",
  getDownloadDir: () => "/tmp/test-storage/downloads",
  getDataFilePath: () => "/tmp/test-storage/app-data.json",
  getEnv: () => ({
    adminEmail: "admin@test.com",
    adminPassword: "TestPass123",
    adminName: "Test Admin",
  }),
}));

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

function emptyData(): AppData {
  return { users: [], panels: [], messages: [], groupRoles: [] };
}

function seedData(): AppData {
  return {
    users: [
      {
        id: "u1",
        email: "admin@test.com",
        displayName: "Admin",
        passwordHash: "$2a$10$fakehash",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    panels: [
      {
        id: "p1",
        userId: "u1",
        agentId: "main",
        title: "Test Panel",
        sessionKey: "panel:p1",
        activeRunId: null,
        blockedRunIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    messages: [
      {
        id: "m1",
        panelId: "p1",
        role: "user",
        text: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
        attachments: [],
        runId: null,
        state: null,
        draft: false,
        errorMessage: null,
        stopReason: null,
        usage: null,
        runtimeSteps: [],
      },
    ],
    groupRoles: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up mockFs.readFile to return the given data */
function setMockData(data: AppData) {
  mockFs.readFile.mockResolvedValue(JSON.stringify(data));
}

/** Get the last data written by store */
function getWrittenData(): AppData {
  const calls = mockFs.writeFile.mock.calls;
  const lastCall = calls[calls.length - 1];
  return JSON.parse(lastCall[1] as string) as AppData;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("store", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset the module to clear cached data between tests
    vi.resetModules();
    setMockData(emptyData());
  });

  describe("findUserByEmail", () => {
    it("finds user by email (case-insensitive)", async () => {
      setMockData(seedData());
      const { findUserByEmail } = await import("@/lib/store");
      const user = await findUserByEmail("ADMIN@test.com");
      expect(user).toBeDefined();
      expect(user!.id).toBe("u1");
    });

    it("returns undefined for unknown email", async () => {
      setMockData(seedData());
      const { findUserByEmail } = await import("@/lib/store");
      const user = await findUserByEmail("unknown@test.com");
      expect(user).toBeUndefined();
    });
  });

  describe("findUserById", () => {
    it("finds user by id", async () => {
      setMockData(seedData());
      const { findUserById } = await import("@/lib/store");
      const user = await findUserById("u1");
      expect(user).toBeDefined();
      expect(user!.email).toBe("admin@test.com");
    });

    it("returns undefined for unknown id", async () => {
      setMockData(seedData());
      const { findUserById } = await import("@/lib/store");
      const user = await findUserById("unknown");
      expect(user).toBeUndefined();
    });
  });

  describe("createPanel", () => {
    it("creates a new panel", async () => {
      setMockData(seedData());
      const { createPanel } = await import("@/lib/store");
      const panel = await createPanel("u1", "main", "New Panel");
      expect(panel.title).toBe("New Panel");
      expect(panel.agentId).toBe("main");
      expect(panel.sessionKey).toContain("panel:");
      expect(panel.messageCount).toBe(0);
    });
  });

  describe("listPanelsForUser", () => {
    it("returns panels for the given user", async () => {
      setMockData(seedData());
      const { listPanelsForUser } = await import("@/lib/store");
      const panels = await listPanelsForUser("u1");
      expect(panels).toHaveLength(1);
      expect(panels[0].title).toBe("Test Panel");
    });

    it("returns empty for unknown user", async () => {
      setMockData(seedData());
      const { listPanelsForUser } = await import("@/lib/store");
      const panels = await listPanelsForUser("unknown");
      expect(panels).toHaveLength(0);
    });

    it("includes messages by default", async () => {
      setMockData(seedData());
      const { listPanelsForUser } = await import("@/lib/store");
      const panels = await listPanelsForUser("u1");
      expect(panels[0].messagesLoaded).toBe(true);
      expect(panels[0].messages).toHaveLength(1);
    });

    it("excludes messages when includeMessages=false", async () => {
      setMockData(seedData());
      const { listPanelsForUser } = await import("@/lib/store");
      const panels = await listPanelsForUser("u1", { includeMessages: false });
      expect(panels[0].messagesLoaded).toBe(false);
      expect(panels[0].messages).toHaveLength(0);
    });
  });

  describe("deletePanel", () => {
    it("removes the panel and its messages", async () => {
      setMockData(seedData());
      const { deletePanel } = await import("@/lib/store");
      await deletePanel("u1", "p1");
      const written = getWrittenData();
      expect(written.panels).toHaveLength(0);
      expect(written.messages).toHaveLength(0);
    });

    it("throws for non-owner", async () => {
      setMockData(seedData());
      const { deletePanel } = await import("@/lib/store");
      await expect(deletePanel("other-user", "p1")).rejects.toThrow("Panel not found");
    });
  });

  describe("appendUserMessage", () => {
    it("adds a user message to the panel", async () => {
      setMockData(seedData());
      const { appendUserMessage } = await import("@/lib/store");
      const view = await appendUserMessage("u1", "p1", {
        id: "msg-new",
        text: "world",
        attachments: [],
      });
      expect(view.role).toBe("user");
      expect(view.text).toBe("world");
      const written = getWrittenData();
      expect(written.messages).toHaveLength(2);
    });

    it("throws for non-owner", async () => {
      setMockData(seedData());
      const { appendUserMessage } = await import("@/lib/store");
      await expect(
        appendUserMessage("other", "p1", { id: "x", text: "hi", attachments: [] })
      ).rejects.toThrow("Panel not found");
    });
  });

  describe("upsertAssistantMessage", () => {
    it("creates new message for new runId", async () => {
      setMockData(seedData());
      const { upsertAssistantMessage } = await import("@/lib/store");
      const view = await upsertAssistantMessage("p1", {
        runId: "run-1",
        text: "response",
        state: "final",
        draft: false,
        seq: 1,
      });
      expect(view).not.toBeNull();
      expect(view!.text).toBe("response");
      expect(view!.runId).toBe("run-1");
    });

    it("updates existing message for same runId", async () => {
      const data = seedData();
      data.messages.push({
        id: "m2",
        panelId: "p1",
        role: "assistant",
        text: "partial",
        createdAt: "2026-01-01T00:00:01.000Z",
        attachments: [],
        runId: "run-1",
        state: "delta",
        draft: true,
        errorMessage: null,
        stopReason: null,
        usage: null,
        eventSeq: 1,
        runtimeSteps: [],
      });
      setMockData(data);
      const { upsertAssistantMessage } = await import("@/lib/store");

      const view = await upsertAssistantMessage("p1", {
        runId: "run-1",
        text: "complete",
        state: "final",
        draft: false,
        seq: 2,
      });
      expect(view!.text).toBe("complete");
      expect(view!.state).toBe("final");
    });

    it("rejects out-of-order seq", async () => {
      const data = seedData();
      data.messages.push({
        id: "m2",
        panelId: "p1",
        role: "assistant",
        text: "latest",
        createdAt: "2026-01-01T00:00:01.000Z",
        attachments: [],
        runId: "run-1",
        state: "delta",
        draft: true,
        errorMessage: null,
        stopReason: null,
        usage: null,
        eventSeq: 5,
        runtimeSteps: [],
      });
      setMockData(data);
      const { upsertAssistantMessage } = await import("@/lib/store");

      const view = await upsertAssistantMessage("p1", {
        runId: "run-1",
        text: "old",
        state: "delta",
        draft: true,
        seq: 3,
      });
      // Should return existing message unchanged
      expect(view!.text).toBe("latest");
    });

    it("returns null for blocked runId", async () => {
      const data = seedData();
      data.panels[0].blockedRunIds = ["blocked-run"];
      setMockData(data);
      const { upsertAssistantMessage } = await import("@/lib/store");

      const view = await upsertAssistantMessage("p1", {
        runId: "blocked-run",
        text: "should not appear",
        state: "delta",
        draft: true,
      });
      expect(view).toBeNull();
    });

    it("throws for unknown panel", async () => {
      setMockData(seedData());
      const { upsertAssistantMessage } = await import("@/lib/store");

      await expect(
        upsertAssistantMessage("unknown-panel", {
          runId: "r1",
          text: "x",
          state: "delta",
          draft: true,
        })
      ).rejects.toThrow("Panel not found");
    });
  });

  describe("abortAssistantRun", () => {
    it("aborts an existing assistant message", async () => {
      const data = seedData();
      data.messages.push({
        id: "m2",
        panelId: "p1",
        role: "assistant",
        text: "partial",
        createdAt: "2026-01-01T00:00:01.000Z",
        attachments: [],
        runId: "run-1",
        state: "delta",
        draft: true,
        errorMessage: null,
        stopReason: null,
        usage: null,
        runtimeSteps: [],
      });
      setMockData(data);
      const { abortAssistantRun } = await import("@/lib/store");

      const view = await abortAssistantRun("p1", "run-1");
      expect(view).not.toBeNull();
      expect(view!.state).toBe("aborted");
      expect(view!.draft).toBe(false);
    });

    it("returns null when message not found", async () => {
      setMockData(seedData());
      const { abortAssistantRun } = await import("@/lib/store");
      const view = await abortAssistantRun("p1", "nonexistent");
      expect(view).toBeNull();
    });
  });

  describe("upsertAssistantRuntimeSteps", () => {
    it("creates message if not exists and adds steps", async () => {
      setMockData(seedData());
      const { upsertAssistantRuntimeSteps } = await import("@/lib/store");

      const steps: StoredRuntimeStep[] = [
        {
          id: "s1",
          runId: "run-1",
          ts: 1000,
          stream: "tool",
          kind: "exec",
          title: "Exec",
          description: "ls -la",
          detail: null,
          status: "running",
          raw: {},
        },
      ];

      const view = await upsertAssistantRuntimeSteps("p1", "run-1", steps);
      expect(view).not.toBeNull();
      expect(view!.runtimeSteps).toHaveLength(1);
      expect(view!.runtimeSteps[0].id).toBe("s1");
    });

    it("merges steps into existing message", async () => {
      const data = seedData();
      data.messages.push({
        id: "m2",
        panelId: "p1",
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:01.000Z",
        attachments: [],
        runId: "run-1",
        state: "delta",
        draft: true,
        errorMessage: null,
        stopReason: null,
        usage: null,
        runtimeSteps: [
          {
            id: "s1",
            runId: "run-1",
            ts: 1000,
            stream: "tool",
            kind: "exec",
            title: "Exec",
            description: "ls",
            detail: null,
            status: "running",
            raw: {},
          },
        ],
      });
      setMockData(data);
      const { upsertAssistantRuntimeSteps } = await import("@/lib/store");

      const steps: StoredRuntimeStep[] = [
        {
          id: "s1",
          runId: "run-1",
          ts: 1000,
          stream: "tool",
          kind: "exec",
          title: "Exec",
          description: "ls completed",
          detail: "output here",
          status: "done",
          raw: { exitCode: 0 },
        },
      ];

      const view = await upsertAssistantRuntimeSteps("p1", "run-1", steps);
      expect(view!.runtimeSteps).toHaveLength(1);
      expect(view!.runtimeSteps[0].status).toBe("done");
    });

    it("returns null for empty steps", async () => {
      setMockData(seedData());
      const { upsertAssistantRuntimeSteps } = await import("@/lib/store");
      const view = await upsertAssistantRuntimeSteps("p1", "run-1", []);
      expect(view).toBeNull();
    });
  });

  describe("setPanelActiveRun", () => {
    it("sets activeRunId", async () => {
      setMockData(seedData());
      const { setPanelActiveRun } = await import("@/lib/store");
      const result = await setPanelActiveRun("p1", "run-active");
      expect(result).toBe("run-active");
    });

    it("clears activeRunId", async () => {
      const data = seedData();
      data.panels[0].activeRunId = "run-old";
      setMockData(data);
      const { setPanelActiveRun } = await import("@/lib/store");
      const result = await setPanelActiveRun("p1", null);
      expect(result).toBeNull();
    });
  });

  describe("blockPanelRun", () => {
    it("adds runId to blocked list", async () => {
      setMockData(seedData());
      const { blockPanelRun } = await import("@/lib/store");
      const blocked = await blockPanelRun("p1", "bad-run");
      expect(blocked).toContain("bad-run");
    });
  });

  describe("updatePanel", () => {
    it("updates panel title", async () => {
      setMockData(seedData());
      const { updatePanel } = await import("@/lib/store");
      const view = await updatePanel("u1", "p1", { title: "Renamed" });
      expect(view.title).toBe("Renamed");
    });

    it("clears messages when agentId changes", async () => {
      setMockData(seedData());
      const { updatePanel } = await import("@/lib/store");
      const view = await updatePanel("u1", "p1", { agentId: "coding" });
      expect(view.agentId).toBe("coding");
      expect(view.messages).toHaveLength(0);
    });
  });

  describe("clearPanelMessages", () => {
    it("removes all messages from panel", async () => {
      setMockData(seedData());
      const { clearPanelMessages } = await import("@/lib/store");
      const view = await clearPanelMessages("u1", "p1");
      expect(view.messages).toHaveLength(0);
      expect(view.activeRunId).toBeNull();
    });
  });

  describe("findPanelRecordBySessionKey", () => {
    it("finds panel by session key", async () => {
      setMockData(seedData());
      const { findPanelRecordBySessionKey } = await import("@/lib/store");
      const panel = await findPanelRecordBySessionKey("panel:p1");
      expect(panel).not.toBeNull();
      expect(panel!.id).toBe("p1");
    });

    it("returns null for unknown key", async () => {
      setMockData(seedData());
      const { findPanelRecordBySessionKey } = await import("@/lib/store");
      const panel = await findPanelRecordBySessionKey("panel:unknown");
      expect(panel).toBeNull();
    });
  });

  describe("findPanelRecordByCustomChatTarget", () => {
    it("normalizes and finds panel", async () => {
      setMockData(seedData());
      const { findPanelRecordByCustomChatTarget } = await import("@/lib/store");
      const panel = await findPanelRecordByCustomChatTarget("channel:p1");
      expect(panel).not.toBeNull();
      expect(panel!.id).toBe("p1");
    });
  });

  describe("listPanelMessages", () => {
    it("returns messages sorted by createdAt", async () => {
      const data = seedData();
      data.messages.push({
        id: "m0",
        panelId: "p1",
        role: "user",
        text: "first",
        createdAt: "2025-12-31T00:00:00.000Z",
        attachments: [],
        runId: null,
        state: null,
        draft: false,
        errorMessage: null,
        stopReason: null,
        usage: null,
        runtimeSteps: [],
      });
      setMockData(data);
      const { listPanelMessages } = await import("@/lib/store");
      const messages = await listPanelMessages("p1");
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe("m0"); // earlier
      expect(messages[1].id).toBe("m1");
    });
  });

  describe("persistUploadedFile", () => {
    it("writes file and returns attachment metadata", async () => {
      setMockData(seedData());
      const { persistUploadedFile } = await import("@/lib/store");
      const result = await persistUploadedFile({
        userId: "u1",
        filename: "doc.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([1, 2, 3]),
      });
      expect(result.name).toBe("doc.pdf");
      expect(result.mimeType).toBe("application/pdf");
      expect(result.size).toBe(3);
      expect(result.kind).toBe("file");
      expect(result.storagePath).toContain("/tmp/test-storage/uploads/");
      expect(mockFs.writeFile).toHaveBeenCalled();
    });
  });
});
