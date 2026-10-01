import { beforeEach, describe, expect, it, vi } from "vitest";


describe("local API client", () => {
  beforeEach(() => {
    vi.resetModules();
    window.notetaker = { config: vi.fn().mockResolvedValue({ apiBase: "http://127.0.0.1:8765/api", apiToken: "token" }) };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
  });

  it("adds the ephemeral local token", async () => {
    const { api } = await import("./api");
    await api("/tasks/");
    const options = global.fetch.mock.calls[0][1];
    expect(options.headers.get("X-Local-Token")).toBe("token");
  });
});
