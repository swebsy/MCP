import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { Broker } from "./broker.ts";
import { BrokerClient } from "./brokerClient.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEST_ORIGIN = "https://swebsy.test";
const TEST_AGENT_TOKEN = "b".repeat(64);
async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs)
      throw new Error("waitFor timeout");
    await delay(5);
  }
}

/** Minimal browser stub. */
class BrowserStub {
  readonly ws: WebSocket;
  private readonly waiters: Array<(m: any) => void> = [];
  private readonly buffer: any[] = [];
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      const w = this.waiters.shift();
      if (w) w(m);
      else this.buffer.push(m);
    });
  }
  static connect(port: number): Promise<BrowserStub> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Origin: TEST_ORIGIN },
      });
      ws.once("open", () => res(new BrowserStub(ws)));
      ws.once("error", rej);
    });
  }
  next(): Promise<any> {
    const b = this.buffer.shift();
    if (b) return Promise.resolve(b);
    return new Promise((r) => this.waiters.push(r));
  }
  async nextOfType(type: string): Promise<any> {
    for (;;) {
      const m = await this.next();
      if (m.type === type) return m;
    }
  }
  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }
  close(): void {
    this.ws.close();
  }
}

class FakeBrokerSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];

  constructor(private readonly autoWelcome = true) {
    super();
  }

  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data);
    if (this.autoWelcome && frame.type === "hello") {
      this.emit(
        "message",
        JSON.stringify({ type: "welcome", agentId: "fake-agent" })
      );
    }
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  req(op: string): { reqId: string } {
    const frame = this.sent.map((s) => JSON.parse(s)).find((f) => f.op === op);
    if (!frame) throw new Error(`Missing ${op} request`);
    return frame;
  }

  reply(reqId: string, result: unknown): void {
    this.emit(
      "message",
      JSON.stringify({ type: "res", reqId, ok: true, result })
    );
  }
}

describe("BrokerClient", () => {
  let broker: Broker;
  let port: number;
  let client: BrokerClient;
  let browser: BrowserStub;

  beforeEach(async () => {
    broker = new Broker({
      port: 0,
      commandTimeoutMs: 500,
      agentToken: TEST_AGENT_TOKEN,
      browserOrigins: [TEST_ORIGIN],
    });
    port = await broker.listen();
    // Connect the client straight to our broker (no spawn).
    client = new BrokerClient(
      { handleFrame: () => {} },
      { port, agentToken: TEST_AGENT_TOKEN, connect: (p) => connectWs(p) }
    );
    client.setInfo("claude-code", "1.2.3");
  });

  afterEach(async () => {
    await client.close();
    browser?.close();
    await broker.close();
  });

  function connectWs(p: number): Promise<WebSocket> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${p}`);
      ws.once("open", () => res(ws));
      ws.once("error", rej);
    });
  }

  it("registers with its label and start_pairing round-trips", async () => {
    const res = (await client.startPairing()) as { code: string; port: number };
    expect(typeof res.code).toBe("string");
    expect(res.port).toBe(port);
    // The broker's roster now carries our label.
    const status = await client.status();
    expect(status.agents?.[0]).toMatchObject({ name: "claude-code" });
  });

  it("relays a command to the paired tab and resolves the result", async () => {
    const { code } = await client.startPairing();
    browser = await BrowserStub.connect(port);
    browser.send({ type: "pair", code });
    await browser.nextOfType("paired");
    await waitFor(() => true);

    const done = client.sendCommand("add_section", { at: 3 });
    const cmd = await browser.nextOfType("cmd");
    expect(cmd).toMatchObject({ tool: "add_section", args: { at: 3 } });
    expect(cmd.agent).toMatchObject({ name: "claude-code" });
    browser.send({ type: "res", id: cmd.id, ok: true, result: { ok: true } });
    await expect(done).resolves.toEqual({ ok: true });
  });

  it("rejects with a BridgeError when the tab returns an error", async () => {
    const { code } = await client.startPairing();
    browser = await BrowserStub.connect(port);
    browser.send({ type: "pair", code });
    await browser.nextOfType("paired");

    const done = client.sendCommand("read_selection", {});
    const cmd = await browser.nextOfType("cmd");
    browser.send({
      type: "res",
      id: cmd.id,
      ok: false,
      error: { code: "no_selection", message: "nothing selected" },
    });
    await expect(done).rejects.toMatchObject({ code: "no_selection" });
  });

  it("feeds forwarded artifact frames into the receiver", async () => {
    const frames: any[] = [];
    const bc = new BrokerClient(
      { handleFrame: (f) => frames.push(f) },
      { port, agentToken: TEST_AGENT_TOKEN, connect: (p) => connectWs(p) }
    );
    bc.setInfo("codex");
    const { code } = await bc.startPairing();
    browser = await BrowserStub.connect(port);
    browser.send({ type: "pair", code });
    await browser.nextOfType("paired");

    const done = bc.sendCommand("capture", {});
    const cmd = await browser.nextOfType("cmd");
    browser.send({ type: "artifact_begin", id: "a1", kind: "screenshots" });
    await delay(20);
    browser.send({ type: "res", id: cmd.id, ok: true, result: {} });
    await done;

    expect(frames.some((f) => f.type === "artifact_begin")).toBe(true);
    await bc.close();
  });

  it("ignores a stale close from a socket replaced while reconnecting", async () => {
    const sockets: FakeBrokerSocket[] = [];
    const bc = new BrokerClient(
      { handleFrame: () => {} },
      {
        port,
        agentToken: TEST_AGENT_TOKEN,
        connect: async () => {
          const socket = new FakeBrokerSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }
    );

    await bc.start();
    const first = sockets[0];
    first.readyState = WebSocket.CLOSING;

    const status = bc.status();
    await waitFor(() =>
      Boolean(sockets[1]?.sent.some((s) => JSON.parse(s).op === "status"))
    );
    const second = sockets[1];
    const { reqId } = second.req("status");

    first.emit("close");
    second.reply(reqId, {
      connected: false,
      busy: false,
      settlingTimeout: false,
      port,
      agents: [],
    });

    await expect(status).resolves.toMatchObject({ connected: false });
    await bc.close();
  });

  describe("mixed versions", () => {
    function oldBrokerClient(): {
      bc: BrokerClient;
      socket: FakeBrokerSocket;
    } {
      // Its welcome carries no `features`, like every broker before 0.8.
      const socket = new FakeBrokerSocket();
      const bc = new BrokerClient(
        { handleFrame: () => {} },
        {
          port,
          agentToken: TEST_AGENT_TOKEN,
          connect: async () => socket as unknown as WebSocket,
        }
      );
      return { bc, socket };
    }
    const frames = (socket: FakeBrokerSocket) =>
      socket.sent.map((raw) => JSON.parse(raw));

    it("sends an old broker only the original ops and fields", async () => {
      const { bc, socket } = oldBrokerClient();
      try {
        expect((await bc.features()).size).toBe(0);
        const pairing = bc.startPairing({ reuse: true });
        await waitFor(() =>
          frames(socket).some((f) => f.op === "start_pairing")
        );
        const req = socket.req("start_pairing") as Record<string, unknown>;
        expect(req).not.toHaveProperty("reuse");
        socket.reply(String(req.reqId), { code: "c", port });
        await pairing;

        const cancel = new AbortController();
        const cmd = bc.sendCommand("edit", {}, 1_000, {
          signal: cancel.signal,
          queueDeadline: Date.now() + 1_000,
        });
        await waitFor(() => frames(socket).some((f) => f.op === "cmd"));
        expect(socket.req("cmd")).not.toHaveProperty("queueDeadline");
        cancel.abort();
        // Answered at once, and no `cancel` frame an old broker can't read.
        await expect(cmd).rejects.toMatchObject({ code: "cancelled" });
        expect(frames(socket).some((f) => f.type === "cancel")).toBe(false);
      } finally {
        await bc.close();
      }
    });

    it("cancels a queued command on a new broker so it never reaches the tab", async () => {
      expect(await client.features()).toEqual(
        new Set(["pair_reuse", "cancel", "deadline"])
      );
      const { code, fresh } = await client.startPairing({ reuse: true });
      expect(fresh).toBe(true);
      expect(await client.startPairing({ reuse: true })).toMatchObject({
        code,
        fresh: false,
      });
      browser = await BrowserStub.connect(port);
      browser.send({ type: "pair", code });
      await browser.nextOfType("paired");

      const first = client.sendCommand("first", {});
      const cmd1 = await browser.nextOfType("cmd");
      const cancel = new AbortController();
      const queued = client.sendCommand("queued", {}, undefined, {
        signal: cancel.signal,
      });
      await waitFor(() => broker.status().busy);
      await delay(20); // let the queued req reach the broker
      cancel.abort();
      await expect(queued).rejects.toMatchObject({ code: "cancelled" });

      browser.send({ type: "res", id: cmd1.id, ok: true, result: 1 });
      await first;
      const third = client.sendCommand("third", {});
      const cmd3 = await browser.nextOfType("cmd");
      expect(cmd3.tool).toBe("third");
      browser.send({ type: "res", id: cmd3.id, ok: true, result: 3 });
      await expect(third).resolves.toBe(3);
    });
  });

  it("rejects when a websocket on the port is not a broker", async () => {
    vi.useFakeTimers();
    const socket = new FakeBrokerSocket(false);
    const bc = new BrokerClient(
      { handleFrame: () => {} },
      {
        port,
        agentToken: TEST_AGENT_TOKEN,
        connect: async () => socket as unknown as WebSocket,
      }
    );

    try {
      const pairing = expect(bc.startPairing()).rejects.toMatchObject({
        code: "not_connected",
        message: "Broker handshake timed out.",
      });
      await vi.advanceTimersByTimeAsync(2500);
      await pairing;
    } finally {
      await bc.close();
      vi.useRealTimers();
    }
  });
});
