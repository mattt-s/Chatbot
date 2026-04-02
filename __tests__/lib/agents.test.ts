import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock "server-only"
vi.mock("server-only", () => ({}));

// Mock env
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    customChatAuthToken: "test-token",
    agentCatalogJson: '[{"id":"main","name":"Main"},{"id":"coding","name":"Coding","emoji":"🧑‍💻"}]',
  }),
}));

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
const mockIsPluginConnected = vi.fn();
const mockEnsureCustomChatBridgeServer = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/customchat-bridge-server", () => ({
  sendRpcToPlugin: (...args: unknown[]) => mockSendRpcToPlugin(...args),
  isPluginConnected: () => mockIsPluginConnected(),
  ensureCustomChatBridgeServer: () => mockEnsureCustomChatBridgeServer(),
}));

describe("agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("loadAgentCatalog", () => {
    it("falls back to env catalog when plugin unavailable", async () => {
      mockIsPluginConnected.mockReturnValue(false);

      vi.mock("server-only", () => ({}));
      const { loadAgentCatalog } = await import("@/lib/agents");
      const agents = await loadAgentCatalog();

      expect(agents).toHaveLength(2);
      expect(agents[0].id).toBe("main");
      expect(agents[1].id).toBe("coding");
      expect(agents[1].emoji).toBe("🧑‍💻");
    });

    it("returns provider agents when RPC succeeds", async () => {
      mockIsPluginConnected.mockReturnValue(true);
      mockSendRpcToPlugin.mockResolvedValue({
        agents: [
          { id: "main", name: "Main Agent" },
          { id: "lucy", name: "Lucy", emoji: "📚", avatarUrl: "http://example.com/lucy.png" },
        ],
      });

      vi.mock("server-only", () => ({}));
      const { loadAgentCatalog } = await import("@/lib/agents");
      const agents = await loadAgentCatalog(true); // force refresh

      expect(agents).toHaveLength(2);
      expect(agents[0].id).toBe("main");
      expect(agents[0].name).toBe("Main Agent");
      expect(agents[1].avatarUrl).toBe("/api/agents/lucy/avatar");
    });

    it("filters out invalid agent entries", async () => {
      mockIsPluginConnected.mockReturnValue(true);
      mockSendRpcToPlugin.mockResolvedValue({
        agents: [
          { id: "valid", name: "Valid" },
          { missing: "name" },
          null,
          42,
        ],
      });

      vi.mock("server-only", () => ({}));
      const { loadAgentCatalog } = await import("@/lib/agents");
      const agents = await loadAgentCatalog(true);
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe("valid");
    });

    it("falls back to default when env catalog is malformed", async () => {
      mockIsPluginConnected.mockReturnValue(false);

      vi.doMock("@/lib/env", () => ({
        getEnv: () => ({
          customChatAuthToken: "",
          agentCatalogJson: "not valid json",
        }),
      }));
      vi.mock("server-only", () => ({}));
      vi.resetModules();

      const { loadAgentCatalog } = await import("@/lib/agents");
      const agents = await loadAgentCatalog();
      expect(agents.length).toBeGreaterThan(0);
      expect(agents[0].id).toBe("main");
    });
  });

  describe("getChannelView", () => {
    it("returns static channel view", async () => {
      vi.mock("server-only", () => ({}));
      const { getChannelView } = await import("@/lib/agents");
      const view = getChannelView();
      expect(view.mode).toBe("provider");
      expect(view.state).toBe("passive");
      expect(view.errorMessage).toBeNull();
    });
  });
});
