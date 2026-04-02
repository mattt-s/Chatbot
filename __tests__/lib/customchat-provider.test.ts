import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock "server-only"
vi.mock("server-only", () => ({}));

// Mock logger
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    input: vi.fn(),
    output: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock bridge server
const mockSendRpcToPlugin = vi.fn();
const mockEnsureCustomChatBridgeServer = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/customchat-bridge-server", () => ({
  sendRpcToPlugin: (...args: unknown[]) => mockSendRpcToPlugin(...args),
  ensureCustomChatBridgeServer: () => mockEnsureCustomChatBridgeServer(),
}));

describe("customchat-provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("deleteProviderSession", () => {
    it("calls session.delete RPC with correct params", async () => {
      mockSendRpcToPlugin.mockResolvedValue({ ok: true, keys: ["key1"] });

      const { deleteProviderSession } = await import("@/lib/customchat-provider");
      const result = await deleteProviderSession({ panelId: "p1", agentId: "main" });

      expect(mockEnsureCustomChatBridgeServer).toHaveBeenCalled();
      expect(mockSendRpcToPlugin).toHaveBeenCalledWith(
        "session.delete",
        expect.objectContaining({
          panelId: "p1",
          agentId: "main",
          target: "channel:p1",
        }),
      );
      expect(result).toEqual({ ok: true, keys: ["key1"] });
    });

    it("throws on RPC error", async () => {
      mockSendRpcToPlugin.mockRejectedValue(new Error("session delete failed"));

      const { deleteProviderSession } = await import("@/lib/customchat-provider");
      await expect(
        deleteProviderSession({ panelId: "p1", agentId: "main" }),
      ).rejects.toThrow("session delete failed");
    });
  });

  describe("abortProviderRun", () => {
    it("calls session.abort RPC with correct params", async () => {
      mockSendRpcToPlugin.mockResolvedValue({ ok: true, verified: true });

      const { abortProviderRun } = await import("@/lib/customchat-provider");
      const result = await abortProviderRun({
        panelId: "p1",
        agentId: "main",
        runId: "run-1",
        sessionKey: "panel:p1",
      });

      expect(mockSendRpcToPlugin).toHaveBeenCalledWith(
        "session.abort",
        expect.objectContaining({
          panelId: "p1",
          agentId: "main",
          runId: "run-1",
          sessionKey: "panel:p1",
        }),
      );
      expect(result).toEqual({ ok: true, verified: true });
    });

    it("throws on RPC failure", async () => {
      mockSendRpcToPlugin.mockRejectedValue(new Error("abort failed"));

      const { abortProviderRun } = await import("@/lib/customchat-provider");
      await expect(
        abortProviderRun({ panelId: "p1", agentId: "main" }),
      ).rejects.toThrow("abort failed");
    });
  });

  describe("inspectProviderSession", () => {
    it("calls session.inspect RPC", async () => {
      mockSendRpcToPlugin.mockResolvedValue({ ok: true, exists: true, terminal: false });

      const { inspectProviderSession } = await import("@/lib/customchat-provider");
      const result = await inspectProviderSession({ panelId: "p1", agentId: "main", target: "channel:p1" });

      expect(mockSendRpcToPlugin).toHaveBeenCalledWith(
        "session.inspect",
        expect.objectContaining({ panelId: "p1", agentId: "main", target: "channel:p1" }),
      );
      expect(result?.exists).toBe(true);
    });
  });

  describe("readProviderSessionStatus", () => {
    it("calls session.status RPC", async () => {
      mockSendRpcToPlugin.mockResolvedValue({ ok: true, exists: true, statusText: "running" });

      const { readProviderSessionStatus } = await import("@/lib/customchat-provider");
      const result = await readProviderSessionStatus({ panelId: "p1", agentId: "main" });

      expect(mockSendRpcToPlugin).toHaveBeenCalledWith(
        "session.status",
        expect.objectContaining({ panelId: "p1", agentId: "main" }),
      );
      expect(result?.statusText).toBe("running");
    });
  });
});
