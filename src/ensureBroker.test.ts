import { describe, expect, it, vi } from "vitest";
import { ensureBroker } from "./ensureBroker.ts";
import type { WebSocket } from "ws";

const fakeWs = () => ({}) as unknown as WebSocket;

describe("ensureBroker", () => {
  it("returns the connection when the broker is already up (no spawn)", async () => {
    const spawnDaemon = vi.fn();
    const connect = vi.fn().mockResolvedValue(fakeWs());
    const ws = await ensureBroker({ connect, spawnDaemon, port: 1 });
    expect(ws).toBeDefined();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("spawns the daemon then connects when nothing is listening", async () => {
    const spawnDaemon = vi.fn();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // first probe
      .mockResolvedValue(fakeWs()); // after spawn
    const ws = await ensureBroker({ connect, spawnDaemon, port: 1 });
    expect(ws).toBeDefined();
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
  });

  it("throws if the broker never comes up", async () => {
    const spawnDaemon = vi.fn();
    const connect = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      ensureBroker({ connect, spawnDaemon, port: 1, timeoutMs: 250 })
    ).rejects.toThrow(/did not come up/);
  });
});
