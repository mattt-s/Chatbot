import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock "server-only"
vi.mock("server-only", () => ({}));

// Mock store functions
const mockFindPanelRecordByCustomChatTarget = vi.fn();
const mockFindMessageByRunId = vi.fn();
const mockUpsertAssistantMessage = vi.fn();
const mockUpsertAssistantRuntimeSteps = vi.fn();
const mockSetPanelActiveRun = vi.fn();
const mockSetGroupPanelTaskState = vi.fn();
const mockPersistDownloadedBuffer = vi.fn();
const mockListGroupRoles = vi.fn();
const mockListPanelMessages = vi.fn();

vi.mock("@/lib/store", () => ({
  findPanelRecordByCustomChatTarget: (...args: unknown[]) =>
    mockFindPanelRecordByCustomChatTarget(...args),
  findMessageByRunId: (...args: unknown[]) => mockFindMessageByRunId(...args),
  upsertAssistantMessage: (...args: unknown[]) => mockUpsertAssistantMessage(...args),
  upsertAssistantRuntimeSteps: (...args: unknown[]) => mockUpsertAssistantRuntimeSteps(...args),
  setPanelActiveRun: (...args: unknown[]) => mockSetPanelActiveRun(...args),
  setGroupPanelTaskState: (...args: unknown[]) => mockSetGroupPanelTaskState(...args),
  persistDownloadedBuffer: (...args: unknown[]) => mockPersistDownloadedBuffer(...args),
  listGroupRoles: (...args: unknown[]) => mockListGroupRoles(...args),
  listPanelMessages: (...args: unknown[]) => mockListPanelMessages(...args),
}));

// Mock events
const mockPublishCustomChatEvent = vi.fn();
vi.mock("@/lib/customchat-events", () => ({
  publishCustomChatEvent: (...args: unknown[]) => mockPublishCustomChatEvent(...args),
}));

const mockOnRoleReplyFinal = vi.fn();
const mockOnRoleReplyErrorOrAborted = vi.fn();
const mockOnRoleReplyTerminalWithoutRouting = vi.fn();
const mockLookupRoleByRunId = vi.fn();
vi.mock("@/lib/group-router", () => ({
  lookupRoleByRunId: (...args: unknown[]) => mockLookupRoleByRunId(...args),
  onRoleReplyFinal: (...args: unknown[]) => mockOnRoleReplyFinal(...args),
  onRoleReplyErrorOrAborted: (...args: unknown[]) => mockOnRoleReplyErrorOrAborted(...args),
  onRoleReplyTerminalWithoutRouting: (...args: unknown[]) =>
    mockOnRoleReplyTerminalWithoutRouting(...args),
}));

// ---------------------------------------------------------------------------

const mockPanel = {
  id: "p1",
  userId: "u1",
  agentId: "main",
  title: "Test",
  sessionKey: "panel:p1",
  activeRunId: null,
  blockedRunIds: [] as string[],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("customchat-ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindPanelRecordByCustomChatTarget.mockResolvedValue({ ...mockPanel });
    mockFindMessageByRunId.mockResolvedValue(null);
    mockUpsertAssistantMessage.mockResolvedValue({
      id: "m1",
      role: "assistant",
      text: "hello",
      runId: "run-1",
      state: "delta",
      draft: true,
      attachments: [],
      runtimeSteps: [],
    });
    mockUpsertAssistantRuntimeSteps.mockResolvedValue(null);
    mockSetPanelActiveRun.mockResolvedValue(null);
    mockSetGroupPanelTaskState.mockResolvedValue(null);
    mockListGroupRoles.mockResolvedValue([
      {
        id: "role-dd",
        panelId: "p1",
        title: "dd",
        agentId: "main",
        emoji: null,
        isLeader: false,
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    mockLookupRoleByRunId.mockReturnValue(null);
    mockOnRoleReplyFinal.mockResolvedValue(undefined);
    mockOnRoleReplyErrorOrAborted.mockResolvedValue(undefined);
    mockOnRoleReplyTerminalWithoutRouting.mockResolvedValue(undefined);
    mockPersistDownloadedBuffer.mockResolvedValue({
      id: "att-1",
      name: "file.png",
      mimeType: "image/png",
      size: 100,
      kind: "image",
      storagePath: "/storage/downloads/att-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    mockListPanelMessages.mockResolvedValue([]);
  });

  describe("customChatDeliverySchema", () => {
    it("validates a minimal payload", async () => {
      const { customChatDeliverySchema } = await import("@/lib/customchat-ingest");
      const result = customChatDeliverySchema.parse({
        target: "panel:p1",
        text: "hello",
      });
      expect(result.target).toBe("panel:p1");
      expect(result.text).toBe("hello");
      expect(result.state).toBe("final");
      expect(result.attachments).toEqual([]);
      expect(result.runtimeSteps).toEqual([]);
    });

    it("rejects missing target", async () => {
      const { customChatDeliverySchema } = await import("@/lib/customchat-ingest");
      expect(() => customChatDeliverySchema.parse({ text: "hi" })).toThrow();
    });

    it("accepts all valid states", async () => {
      const { customChatDeliverySchema } = await import("@/lib/customchat-ingest");
      for (const state of ["delta", "final", "aborted", "error"]) {
        const result = customChatDeliverySchema.parse({
          target: "panel:p1",
          state,
        });
        expect(result.state).toBe(state);
      }
    });
  });

  describe("ingestCustomChatDelivery", () => {
    it("ingests a valid delivery and publishes SSE event", async () => {
      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      const result = await ingestCustomChatDelivery({
        target: "panel:p1",
        runId: "run-1",
        text: "hello",
        state: "delta",
        seq: 1,
      });

      expect(result.ok).toBe(true);
      expect(result.panelId).toBe("p1");
      expect(mockUpsertAssistantMessage).toHaveBeenCalledWith("p1", expect.objectContaining({
        runId: "run-1",
        text: "hello",
        state: "delta",
      }));
      expect(mockSetPanelActiveRun).toHaveBeenCalledWith("p1", "run-1");
      expect(mockPublishCustomChatEvent).toHaveBeenCalled();
    });

    it("clears activeRunId on final", async () => {
      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      await ingestCustomChatDelivery({
        target: "panel:p1",
        runId: "run-1",
        text: "done",
        state: "final",
      });

      expect(mockSetPanelActiveRun).toHaveBeenCalledWith("p1", null);
    });

    it("throws for unsupported target", async () => {
      mockFindPanelRecordByCustomChatTarget.mockResolvedValue(null);
      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      await expect(
        ingestCustomChatDelivery({ target: "unknown-format", text: "hi" })
      ).rejects.toThrow();
    });

    it("throws when panel not found", async () => {
      mockFindPanelRecordByCustomChatTarget.mockResolvedValue(null);
      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      await expect(
        ingestCustomChatDelivery({ target: "panel:missing", text: "hi" })
      ).rejects.toThrow("Panel not found");
    });

    it("ignores blocked runIds", async () => {
      mockFindPanelRecordByCustomChatTarget.mockResolvedValue({
        ...mockPanel,
        blockedRunIds: ["blocked-run"],
      });
      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      const result = await ingestCustomChatDelivery({
        target: "panel:p1",
        runId: "blocked-run",
        text: "should not appear",
        state: "delta",
      });

      expect(result.ok).toBe(true);
      expect(result.ignored).toBe(true);
      expect(mockUpsertAssistantMessage).not.toHaveBeenCalled();
    });

    it("ignores empty deliveries without existing message", async () => {
      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      const result = await ingestCustomChatDelivery({
        target: "panel:p1",
        runId: "run-1",
        text: "",
        state: "delta",
      });

      expect(result.ok).toBe(true);
      expect(result.ignored).toBe(true);
      expect(result.reason).toBe("empty placeholder ignored");
    });

    it("ignores standalone NO noise without storing or routing", async () => {
      mockFindPanelRecordByCustomChatTarget.mockResolvedValue({
        ...mockPanel,
        kind: "group",
      });
      mockLookupRoleByRunId.mockReturnValue({ panelId: "p1", groupRoleId: "role-dd" });

      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      const result = await ingestCustomChatDelivery({
        target: "group:direct:p1:role:role-dd",
        runId: "run-no",
        text: "NO",
        state: "final",
      });

      expect(result.ok).toBe(true);
      expect(result.ignored).toBe(true);
      expect(result.reason).toBe("standalone NO ignored");
      expect(mockUpsertAssistantMessage).not.toHaveBeenCalled();
      expect(mockPublishCustomChatEvent).not.toHaveBeenCalled();
      expect(mockOnRoleReplyFinal).not.toHaveBeenCalled();
      expect(mockOnRoleReplyTerminalWithoutRouting).not.toHaveBeenCalled();
      expect(mockSetPanelActiveRun).toHaveBeenCalledWith("p1", null);
    });

    it("keeps a normal negative answer with explanation", async () => {
      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      await ingestCustomChatDelivery({
        target: "panel:p1",
        runId: "run-negative",
        text: "No, because tag API is not ready yet.",
        state: "final",
      });

      expect(mockUpsertAssistantMessage).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          runId: "run-negative",
          text: "No, because tag API is not ready yet.",
        }),
      );
    });

    it("strips NO_REPLY and thinking tags from text", async () => {
      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      await ingestCustomChatDelivery({
        target: "panel:p1",
        runId: "run-1",
        text: "<think>reasoning</think>Hello NO_REPLY world",
        state: "final",
      });

      expect(mockUpsertAssistantMessage).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          text: "Hello  world",
        })
      );
    });

    it("generates fallback runId when not provided", async () => {
      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      await ingestCustomChatDelivery({
        target: "panel:p1",
        text: "hello",
        state: "final",
      });

      const call = mockUpsertAssistantMessage.mock.calls[0];
      expect(call[1].runId).toMatch(/^customchat:/);
    });

    it("processes runtime steps", async () => {
      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      await ingestCustomChatDelivery({
        target: "panel:p1",
        runId: "run-1",
        text: "result",
        state: "delta",
        runtimeSteps: [
          {
            stream: "tool",
            ts: 1000,
            data: { kind: "exec", title: "Exec", description: "ls", status: "running" },
          },
        ],
      });

      expect(mockUpsertAssistantRuntimeSteps).toHaveBeenCalledWith(
        "p1",
        "run-1",
        expect.arrayContaining([
          expect.objectContaining({
            stream: "tool",
            kind: "exec",
          }),
        ])
      );
    });

    it("does not reroute duplicate final group events for the same run", async () => {
      mockFindPanelRecordByCustomChatTarget.mockResolvedValue({
        ...mockPanel,
        kind: "group",
      });
      mockFindMessageByRunId.mockResolvedValue({
        id: "m-existing",
        panelId: "p1",
        role: "assistant",
        text: "旧内容",
        createdAt: "2026-01-01T00:00:00.000Z",
        attachments: [],
        runId: "run-1",
        state: "final",
        draft: false,
        errorMessage: null,
        stopReason: null,
        usage: null,
        runtimeSteps: [],
        groupRoleId: "role-dd",
        senderLabel: "dd",
        mentionedGroupRoleIds: [],
      });
      mockLookupRoleByRunId.mockReturnValue({ panelId: "p1", groupRoleId: "role-dd" });

      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      await ingestCustomChatDelivery({
        target: "group:direct:p1:role:role-dd",
        runId: "run-1",
        text: "重复终态",
        state: "final",
      });

      expect(mockOnRoleReplyFinal).not.toHaveBeenCalled();
    });

    it("suppresses noisy bridge NO text before storage and skips leader forwarding", async () => {
      mockFindPanelRecordByCustomChatTarget.mockResolvedValue({
        ...mockPanel,
        kind: "group",
      });
      mockLookupRoleByRunId.mockReturnValue({ panelId: "p1", groupRoleId: "role-dd" });
      mockListPanelMessages.mockResolvedValue([
        {
          id: "delivered",
          role: "assistant",
          text: "豆豆的头像 🐶",
          createdAt: "2026-01-01T00:00:05.000Z",
          attachments: [
            {
              id: "att-1",
              name: "file.png",
              mimeType: "image/png",
              size: 100,
              kind: "image",
              url: "/api/uploads/att-1",
            },
          ],
          runId: "customchat:delivery",
          state: "final",
          draft: false,
          errorMessage: null,
          stopReason: null,
          usage: null,
          runtimeSteps: [],
        },
      ]);

      const { ingestCustomChatDelivery } = await import("@/lib/customchat-ingest");

      await ingestCustomChatDelivery({
        target: "group:direct:p1:role:role-dd",
        runId: "run-noise",
        text: "NO",
        state: "final",
        runtimeSteps: [
          {
            stream: "tool",
            ts: 1000,
            data: { tool: "message", title: "message", description: "sent", status: "done" },
          },
        ],
      });

      expect(mockUpsertAssistantMessage).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          text: "",
          runId: "run-noise",
        }),
      );
      expect(mockOnRoleReplyFinal).not.toHaveBeenCalled();
      expect(mockOnRoleReplyTerminalWithoutRouting).toHaveBeenCalledWith(
        expect.objectContaining({
          panelId: "p1",
          groupRoleId: "role-dd",
        }),
      );
    });
  });
});
