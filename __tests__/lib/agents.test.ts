import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock "server-only"
vi.mock("server-only", () => ({}));

// Mock env
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    providerBaseUrl: "http://127.0.0.1:18789",
    customChatAuthToken: "test-token",
    agentCatalogJson: '[{"id":"main","name":"Main"},{"id":"coding","name":"Coding","emoji":"🧑‍💻"}]',
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("loadAgentCatalog", () => {
    it("falls back to env catalog when provider unavailable", async () => {
      mockFetch.mockRejectedValue(new Error("network error"));

      vi.mock("server-only", () => ({}));
      const { loadAgentCatalog } = await import("@/lib/agents");
      const agents = await loadAgentCatalog();

      expect(agents).toHaveLength(2);
      expect(agents[0].id).toBe("main");
      expect(agents[1].id).toBe("coding");
      expect(agents[1].emoji).toBe("🧑‍💻");
    });

    it("returns provider agents when fetch succeeds", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          agents: [
            { id: "main", name: "Main Agent" },
            { id: "lucy", name: "Lucy", emoji: "📚", avatarUrl: "http://example.com/lucy.png" },
          ],
        }),
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
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          agents: [
            { id: "valid", name: "Valid" },
            { missing: "name" },
            null,
            42,
          ],
        }),
      });

      vi.mock("server-only", () => ({}));
      const { loadAgentCatalog } = await import("@/lib/agents");
      const agents = await loadAgentCatalog(true);
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe("valid");
    });

    it("falls back to default when env catalog is malformed", async () => {
      mockFetch.mockRejectedValue(new Error("fail"));

      vi.doMock("@/lib/env", () => ({
        getEnv: () => ({
          providerBaseUrl: "",
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
