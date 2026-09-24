import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker, MAX_COMMAND_TIMEOUT_MS } from "./broker.ts";
import { BridgeError } from "./errors.ts";
import { EXPORT_TEMPLATE_TIMEOUT_MS } from "./server.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEST_ORIGIN = "https://swebsy.test";
const TEST_AGENT_TOKEN = "a".repeat(64);

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs)
      throw new Error("waitFor timeout");
    await delay(5);
  }
}

/** A browser-tab stand-in: buffers frames and lets tests await them. */
class TestClient {
  readonly ws: WebSocket;
  private readonly buffer: any[] = [];
  private readonly waiters: Array<(m: any) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.buffer.push(msg);
    });
  }

  static connect(port: number, origin = TEST_ORIGIN): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Origin: origin },
      });
      ws.once("open", () => resolve(new TestClient(ws)));
      ws.once("error", reject);
    });
  }

  next(): Promise<any> {
    const buffered = this.buffer.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((r) => this.waiters.push(r));
  }

  /** Await the next frame whose type matches, skipping others (e.g. roster). */
  async nextOfType(type: string): Promise<any> {
    for (;;) {
      const m = await this.next();
      if (m.type === type) return m;
    }
  }

  /** Await a roster frame whose list satisfies the predicate. */
  async waitRoster(pred: (list: any[]) => boolean): Promise<any[]> {
    for (;;) {
      const m = await this.nextOfType("agents");
      if (pred(m.list)) return m.list;
    }
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    this.ws.close();
  }
}

/** An agent-process stand-in over the broker's agent protocol. */
class AgentClient {
  readonly ws: WebSocket;
  agentId = "";
  features: string[] | undefined;
  readonly artifacts: any[] = [];
  private readonly reqs = new Map<string, (m: any) => void>();
  private welcomeResolve!: (id: string) => void;
  readonly welcome: Promise<string>;
  private seq = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.welcome = new Promise((r) => (this.welcomeResolve = r));
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === "welcome") {
        this.agentId = m.agentId;
        this.features = m.features;
        this.welcomeResolve(m.agentId);
      } else if (m.type === "res") {
        this.reqs.get(m.reqId)?.(m);
        this.reqs.delete(m.reqId);
      } else {
        this.artifacts.push(m);
      }
    });
  }

  static async connect(
    port: number,
    hello: { name?: string; version?: string; pid?: number } = {}
  ): Promise<AgentClient> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`);
      s.once("open", () => resolve(s));
      s.once("error", reject);
    });
    const a = new AgentClient(ws);
    a.ws.send(
      JSON.stringify({ type: "hello", token: TEST_AGENT_TOKEN, ...hello })
    );
    await a.welcome;
    return a;
  }

  req(op: string, extra: Record<string, unknown> = {}): Promise<any> {
    const reqId = `r${this.seq++}`;
    return new Promise((resolve) => {
      this.reqs.set(reqId, resolve);
      this.ws.send(JSON.stringify({ type: "req", reqId, op, ...extra }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

describe("Broker", () => {
  let broker: Broker;
  let port: number;
  const clients: TestClient[] = [];
  const agents: AgentClient[] = [];

  beforeEach(async () => {
    broker = new Broker({
      port: 0,
      commandTimeoutMs: 100,
      agentToken: TEST_AGENT_TOKEN,
      browserOrigins: [TEST_ORIGIN],
    });
    port = await broker.listen();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const a of agents.splice(0)) a.close();
    await broker.close();
    vi.restoreAllMocks();
  });

  async function pair(): Promise<{ client: TestClient; token: string }> {
    const { code } = broker.startPairing();
    const client = await TestClient.connect(port);
    clients.push(client);
    client.send({ type: "pair", code });
    const ack = await client.nextOfType("paired");
    expect(ack).toMatchObject({ type: "paired", ok: true });
    expect(typeof ack.token).toBe("string");
    await waitFor(() => broker.status().connected);
    return { client, token: ack.token };
  }

  async function connectAgent(
    hello: { name?: string; version?: string; pid?: number } = {}
  ): Promise<AgentClient> {
    const a = await AgentClient.connect(port, hello);
    agents.push(a);
    return a;
  }

  // ── Browser session (ported from the relay) ──────────────────────────────

  describe("pairing", () => {
    it("accepts a valid code", async () => {
      await pair();
      expect(broker.status().connected).toBe(true);
    });

    it("rejects a wrong code and closes the socket", async () => {
      broker.startPairing();
      const client = await TestClient.connect(port);
      clients.push(client);
      client.send({ type: "pair", code: "deadbeef" });
      const ack = await client.next();
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("not_paired");
      expect(broker.status().connected).toBe(false);
    });

    it("consumes the code (single-use)", async () => {
      const { code } = broker.startPairing();
      const a = await TestClient.connect(port);
      clients.push(a);
      a.send({ type: "pair", code });
      expect((await a.next()).ok).toBe(true);

      const b = await TestClient.connect(port);
      clients.push(b);
      b.send({ type: "pair", code });
      const ack = await b.nextOfType("paired");
      expect(ack.ok).toBe(false);
    });
  });

  describe("resume token", () => {
    it("re-attaches with a valid token without consuming a code", async () => {
      const { client, token } = await pair();
      client.close();
      await waitFor(() => !broker.status().connected);

      const b = await TestClient.connect(port);
      clients.push(b);
      b.send({ type: "pair", token });
      const ack = await b.nextOfType("paired");
      expect(ack).toMatchObject({ ok: true, token });
      await waitFor(() => broker.status().connected);
    });

    it("rejects a stale token", async () => {
      await pair();
      const b = await TestClient.connect(port);
      clients.push(b);
      b.send({ type: "pair", token: "not-a-real-token" });
      const ack = await b.nextOfType("paired");
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("not_paired");
    });

    it("rejects pairing from an unapproved browser origin", async () => {
      const { code } = broker.startPairing();
      const client = await TestClient.connect(port, "https://evil.example");
      clients.push(client);
      client.send({ type: "pair", code });
      const ack = await client.next();
      expect(ack).toMatchObject({ type: "paired", ok: false });
    });

    // Staging is a first-party Swebsy app, and QA pairs against it exactly the
    // way a user pairs against production. Uses the default allowlist, not the
    // suite's TEST_ORIGIN override.
    it("allows the staging app origin by default", async () => {
      const defaults = new Broker({ port: 0, agentToken: TEST_AGENT_TOKEN });
      const defaultsPort = await defaults.listen();
      try {
        const { code } = defaults.startPairing();
        const client = await TestClient.connect(
          defaultsPort,
          "https://staging.swebsy.com"
        );
        clients.push(client);
        client.send({ type: "pair", code });
        expect(await client.next()).toMatchObject({ type: "paired", ok: true });
      } finally {
        await defaults.close();
      }
    });

    // start_pairing sends the user to SWEBSY_APP_URL. If the origin allowlist
    // ignored it, local development would hand out a link that always fails to
    // pair, pointing at a second env var nothing in the error mentions.
    it("trusts the origin of the configured pairing destination", async () => {
      const previous = process.env.SWEBSY_APP_URL;
      process.env.SWEBSY_APP_URL = "http://localhost:5174/studio";
      const local = new Broker({ port: 0, agentToken: TEST_AGENT_TOKEN });
      const localPort = await local.listen();
      try {
        const { code } = local.startPairing();
        const client = await TestClient.connect(
          localPort,
          "http://localhost:5174"
        );
        clients.push(client);
        client.send({ type: "pair", code });
        expect(await client.next()).toMatchObject({
          type: "paired",
          ok: true,
        });
      } finally {
        await local.close();
        if (previous === undefined) delete process.env.SWEBSY_APP_URL;
        else process.env.SWEBSY_APP_URL = previous;
      }
    });

    it("rejects an agent that does not know the per-user credential", async () => {
      const socket = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
      const closed = new Promise<number>((resolve) =>
        socket.once("close", (code) => resolve(code))
      );
      socket.send(JSON.stringify({ type: "hello", token: "wrong" }));
      await expect(closed).resolves.toBe(1008);
    });

    it("a new code rotates the token", async () => {
      const first = await pair();
      first.client.close();
      await waitFor(() => !broker.status().connected);
      const second = await pair();
      expect(second.token).not.toBe(first.token);
    });
  });

  describe("command dispatch (browser session)", () => {
    it("round-trips a direct sendCommand through the tab", async () => {
      const { client } = await pair();
      const promise = broker.sendCommand("swebsy_add_section", { at: 1 });
      const cmd = await client.nextOfType("cmd");
      expect(cmd).toMatchObject({
        tool: "swebsy_add_section",
        args: { at: 1 },
      });
      client.send({
        type: "res",
        id: cmd.id,
        ok: true,
        result: { done: true },
      });
      await expect(promise).resolves.toEqual({ done: true });
    });

    it("times out and aborts, keeping the slot locked until settle", async () => {
      const { client } = await pair();
      const p1 = broker.sendCommand("slow", {}, 60);
      const cmd1 = await client.nextOfType("cmd");
      await expect(p1).rejects.toMatchObject({ code: "timeout" });
      expect(await client.nextOfType("abort")).toEqual({
        type: "abort",
        id: cmd1.id,
      });
      expect(broker.status().settlingTimeout).toBe(true);
    });

    it("settles an in-flight command when a new tab replaces the old session", async () => {
      const { client, token } = await pair();
      const pending = broker.sendCommand("edit", {});
      const pendingResult = expect(pending).rejects.toMatchObject({
        code: "not_connected",
        message: "Studio tab session was replaced.",
      });
      await client.nextOfType("cmd");

      const replacement = await TestClient.connect(port);
      clients.push(replacement);
      replacement.send({ type: "pair", token });
      await replacement.nextOfType("paired");

      await pendingResult;
      expect(broker.status().busy).toBe(false);

      const next = broker.sendCommand("status", {});
      const cmd = await replacement.nextOfType("cmd");
      replacement.send({
        type: "res",
        id: cmd.id,
        ok: true,
        result: { connected: true },
      });
      await expect(next).resolves.toEqual({ connected: true });
    });

    it("returns not_connected when never paired", async () => {
      await expect(broker.sendCommand("status", {})).rejects.toBeInstanceOf(
        BridgeError
      );
    });
  });

  // ── Multi-agent ─────────────────────────────────────────────────────────

  describe("agents", () => {
    it("welcomes an agent and lists it in the roster", async () => {
      const { client } = await pair();
      await connectAgent({ name: "claude-code", version: "1.0" });
      const list = await client.waitRoster((l) => l.length === 1);
      expect(list[0]).toMatchObject({ name: "claude-code", busy: false });
    });

    // The clamp is invisible when it bites: the export just dies mid-capture
    // at two minutes with the tool's own allowance saying five.
    it("does not clamp below the longest timeout a tool asks for", () => {
      expect(MAX_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(
        EXPORT_TEMPLATE_TIMEOUT_MS
      );
    });

    it("routes a command from an agent to the tab and back", async () => {
      const { client } = await pair();
      const agent = await connectAgent({ name: "codex" });

      const done = agent.req("cmd", { tool: "add_section", args: { at: 2 } });
      const cmd = await client.nextOfType("cmd");
      expect(cmd).toMatchObject({ tool: "add_section", args: { at: 2 } });
      expect(cmd.agent).toMatchObject({ name: "codex", id: agent.agentId });

      client.send({ type: "res", id: cmd.id, ok: true, result: { ok: 1 } });
      expect(await done).toMatchObject({ ok: true, result: { ok: 1 } });
    });

    it("routes two agents' commands back to the right caller", async () => {
      const { client } = await pair();
      const a = await connectAgent({ name: "claude-code" });
      const b = await connectAgent({ name: "codex" });

      const pa = a.req("cmd", { tool: "first", args: {} });
      const cmdA = await client.nextOfType("cmd");
      client.send({ type: "res", id: cmdA.id, ok: true, result: "A" });
      expect(await pa).toMatchObject({ ok: true, result: "A" });

      const pb = b.req("cmd", { tool: "second", args: {} });
      const cmdB = await client.nextOfType("cmd");
      client.send({ type: "res", id: cmdB.id, ok: true, result: "B" });
      expect(await pb).toMatchObject({ ok: true, result: "B" });
    });

    it("serializes commands across agents (one in flight)", async () => {
      const { client } = await pair();
      const a = await connectAgent();
      const b = await connectAgent();

      a.req("cmd", { tool: "slowA", args: {} });
      const cmdA = await client.nextOfType("cmd");
      expect(cmdA.tool).toBe("slowA");

      b.req("cmd", { tool: "fastB", args: {} });
      // B's command must not dispatch while A's is in flight (skips roster frames).
      const cmdBPromise = client.nextOfType("cmd");
      const early = await Promise.race([
        cmdBPromise.then(() => "got"),
        delay(40).then(() => "none"),
      ]);
      expect(early).toBe("none");
      expect(broker.status().busy).toBe(true);

      client.send({ type: "res", id: cmdA.id, ok: true, result: 1 });
      const cmdB = await cmdBPromise;
      expect(cmdB.tool).toBe("fastB");
    });

    it("forwards artifact frames only to the owning agent", async () => {
      const { client } = await pair();
      const a = await connectAgent({ name: "a" });
      const b = await connectAgent({ name: "b" });

      a.req("cmd", { tool: "capture", args: {} });
      const cmd = await client.nextOfType("cmd");
      // Tab streams an artifact while A's command is in flight.
      client.send({ type: "artifact_begin", id: "art1", kind: "screenshots" });
      await delay(20);
      client.send({ type: "res", id: cmd.id, ok: true, result: {} });

      expect(a.artifacts.some((f) => f.type === "artifact_begin")).toBe(true);
      expect(b.artifacts).toHaveLength(0);
    });

    it("drops an agent from the roster on disconnect", async () => {
      const { client } = await pair();
      const a = await connectAgent({ name: "gone" });
      await client.waitRoster((l) => l.length === 1);
      a.close();
      await client.waitRoster((l) => l.length === 0);
    });

    it("evicts the quietest agent instead of refusing a newcomer", async () => {
      // ponytail: MAX_CONNECTIONS is module-private; 32 is the value it guards.
      const MAX = 32;
      const quietest = await connectAgent({ name: "quietest" });
      const closed = new Promise<number>((resolve) =>
        quietest.ws.once("close", (code: number) => resolve(code))
      );
      for (let i = 1; i < MAX; i++) await connectAgent({ name: `filler${i}` });

      const newcomer = await connectAgent({ name: "newcomer" });

      expect(await closed).toBe(1001);
      expect(newcomer.ws.readyState).toBe(WebSocket.OPEN);
    });

    it("start_pairing over the agent protocol returns a code", async () => {
      const agent = await connectAgent();
      const res = await agent.req("start_pairing");
      expect(res.ok).toBe(true);
      expect(typeof res.result.code).toBe("string");
      expect(res.result.port).toBe(port);
    });
  });

  // ── Pair once, then it just works ────────────────────────────────────────

  async function pairWith(
    frame: Record<string, unknown>
  ): Promise<{ client: TestClient; ack: any }> {
    const client = await TestClient.connect(port);
    clients.push(client);
    client.send({ type: "pair", ...frame });
    return { client, ack: await client.nextOfType("paired") };
  }

  describe("handshake features", () => {
    it("advertises what an agent may send beyond the original protocol", async () => {
      const a = await connectAgent();
      expect(a.features).toEqual(["pair_reuse", "cancel", "deadline"]);
    });
  });

  describe("pairing code reuse", () => {
    it("hands back the live code with reuse, so the browser opens once", () => {
      const first = broker.startPairing({ reuse: true });
      expect(first.fresh).toBe(true);
      const again = broker.startPairing({ reuse: true });
      expect(again).toEqual({ ...first, fresh: false });
      // Without reuse (swebsy_start_pairing, an old agent) it always mints.
      const minted = broker.startPairing();
      expect(minted.fresh).toBe(true);
      expect(minted.code).not.toBe(first.code);
    });

    it("mints again after one recovery's window, since the code may sit unused", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const first = broker.startPairing({ reuse: true });
        vi.advanceTimersByTime(31_000); // the tab resumed its token instead
        const next = broker.startPairing({ reuse: true });
        expect(next.fresh).toBe(true);
        expect(next.code).not.toBe(first.code);
      } finally {
        vi.useRealTimers();
      }
    });

    it("mints again once the live code is spent", async () => {
      const { code } = broker.startPairing({ reuse: true });
      await pairWith({ code });
      const next = broker.startPairing({ reuse: true });
      expect(next.fresh).toBe(true);
      expect(next.code).not.toBe(code);
    });
  });

  describe("slot guard", () => {
    it("refuses an automatic resume while a live tab holds the slot", async () => {
      const { client: live, token } = await pair();
      const { ack } = await pairWith({ token, auto: true });
      expect(ack).toMatchObject({ ok: false, error: { code: "slot_held" } });
      // Nobody was revoked: the working tab still drives the editor.
      const done = broker.sendCommand("status", {});
      const cmd = await live.nextOfType("cmd");
      live.send({ type: "res", id: cmd.id, ok: true, result: 1 });
      await expect(done).resolves.toBe(1);
    });

    it("still lets an explicit take-over revoke the holder", async () => {
      const { client: live, token } = await pair();
      const { ack } = await pairWith({ token });
      expect(ack.ok).toBe(true);
      expect(await live.nextOfType("revoked")).toEqual({ type: "revoked" });
    });

    it("lets an automatic resume replace a holder that stopped answering", async () => {
      const { code } = broker.startPairing();
      const { client: frozen, ack } = await pairWith({
        code,
        features: ["pong"],
      });
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 36_000);
      const second = await pairWith({ token: ack.token, auto: true });
      expect(second.ack.ok).toBe(true);
      expect(await frozen.nextOfType("revoked")).toEqual({ type: "revoked" });
    });
  });

  describe("unresponsive tab", () => {
    it("fails fast with tab_unresponsive once pongs stop, without dispatching", async () => {
      const { code } = broker.startPairing();
      const { client } = await pairWith({ code, features: ["pong"] });
      expect(broker.status().responsive).toBe(true);
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 36_000);
      expect(broker.status()).toMatchObject({
        connected: true,
        responsive: false,
      });
      await expect(broker.sendCommand("edit", {})).rejects.toMatchObject({
        code: "tab_unresponsive",
      });
      vi.restoreAllMocks();
      // A pong brings it back.
      client.send({ type: "pong" });
      await waitFor(() => broker.status().responsive === true);
    });

    it("never marks an old tab (no pong feature) unresponsive", async () => {
      await pair();
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000);
      expect(broker.status().responsive).toBe(true);
    });

    it("drops a silent tab whose command timed out, freeing the slot", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      try {
        const { code } = broker.startPairing();
        const { client } = await pairWith({ code, features: ["pong"] });
        await waitFor(() => broker.status().connected);
        const slow = broker.sendCommand("slow", {}, 60);
        await client.nextOfType("cmd");
        await expect(slow).rejects.toMatchObject({ code: "timeout" });
        expect(broker.status().busy).toBe(true); // held until the tab settles

        vi.advanceTimersByTime(15_000);
        expect(await client.nextOfType("ping")).toEqual({ type: "ping" });
        vi.advanceTimersByTime(46_000); // 61s of silence
        await waitFor(() => !broker.status().connected);
        expect(broker.status().busy).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("cancellation and the queue deadline", () => {
    it("drops a cancelled queued command without ever sending it", async () => {
      const { client } = await pair();
      const first = broker.sendCommand("first", {});
      const cmd1 = await client.nextOfType("cmd");
      const cancel = new AbortController();
      const queued = broker.sendCommand("queued", {}, undefined, undefined, {
        signal: cancel.signal,
      });
      cancel.abort();
      await expect(queued).rejects.toMatchObject({ code: "cancelled" });

      client.send({ type: "res", id: cmd1.id, ok: true, result: 1 });
      await first;
      const third = broker.sendCommand("third", {});
      const cmd3 = await client.nextOfType("cmd");
      expect(cmd3.tool).toBe("third"); // "queued" never reached the tab
      client.send({ type: "res", id: cmd3.id, ok: true, result: 3 });
      await expect(third).resolves.toBe(3);
    });

    it("aborts a dispatched command in the tab and holds the slot until it settles", async () => {
      const { client } = await pair();
      const cancel = new AbortController();
      const running = broker.sendCommand("edit", {}, 5_000, undefined, {
        signal: cancel.signal,
      });
      const cmd = await client.nextOfType("cmd");
      cancel.abort();
      await expect(running).rejects.toMatchObject({ code: "cancelled" });
      expect(await client.nextOfType("abort")).toEqual({
        type: "abort",
        id: cmd.id,
      });
      expect(broker.status()).toMatchObject({
        busy: true,
        settlingTimeout: true,
      });
      client.send({ type: "res", id: cmd.id, ok: true, result: 1 });
      await waitFor(() => !broker.status().busy);
    });

    it("rejects a command still queued at its deadline as busy, unrun", async () => {
      const { client } = await pair();
      const first = broker.sendCommand("first", {}, 5_000);
      const cmd1 = await client.nextOfType("cmd");
      const late = broker.sendCommand("late", {}, undefined, undefined, {
        queueDeadline: Date.now() + 30,
      });
      await expect(late).rejects.toMatchObject({ code: "busy" });
      client.send({ type: "res", id: cmd1.id, ok: true, result: 1 });
      await first;
      expect(broker.status().busy).toBe(false);
    });

    it("cancels an agent's queued command from a cancel frame", async () => {
      const { client } = await pair();
      const a = await connectAgent({ name: "a" });
      const b = await connectAgent({ name: "b" });
      const first = a.req("cmd", { tool: "first", args: {} });
      const cmd1 = await client.nextOfType("cmd");
      const queued = b.req("cmd", { tool: "queued", args: {} });
      await waitFor(() => broker.status().agents?.[1]?.busy === true);
      b.ws.send(JSON.stringify({ type: "cancel", reqId: "r0" }));
      expect(await queued).toMatchObject({
        ok: false,
        error: { code: "cancelled" },
      });
      client.send({ type: "res", id: cmd1.id, ok: true, result: 1 });
      expect(await first).toMatchObject({ ok: true });
    });
  });

  describe("session persistence", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "swebsy-session-test-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function brokerOn(sessionFile: string): Promise<[Broker, number]> {
      const b = new Broker({
        port: 0,
        agentToken: TEST_AGENT_TOKEN,
        browserOrigins: [TEST_ORIGIN],
        sessionFile,
      });
      return [b, await b.listen()];
    }

    async function pairOn(p: number, frame: Record<string, unknown>) {
      const c = await TestClient.connect(p);
      clients.push(c);
      c.send({ type: "pair", ...frame });
      return c.nextOfType("paired");
    }

    it("resumes a token after the broker restarts, until a new code rotates it", async () => {
      const file = join(dir, "sub", "agent.session");
      const [first, p1] = await brokerOn(file);
      const ack = await pairOn(p1, { code: first.startPairing().code });
      await waitFor(() => existsSync(file));
      if (process.platform !== "win32") {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
      await first.close();

      const [second, p2] = await brokerOn(file);
      expect(await pairOn(p2, { token: ack.token, auto: true })).toMatchObject({
        ok: true,
        token: ack.token,
      });
      const rotated = await pairOn(p2, { code: second.startPairing().code });
      await waitFor(() => {
        try {
          return readFileSync(file, "utf8") === rotated.token;
        } catch {
          return false;
        }
      });
      await second.close();

      const [third, p3] = await brokerOn(file);
      expect(await pairOn(p3, { token: ack.token })).toMatchObject({
        ok: false,
        error: { code: "not_paired" },
      });
      await third.close();
    });

    it.runIf(process.platform !== "win32")(
      "ignores a session file other users can read",
      async () => {
        const file = join(dir, "agent.session");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(file, "a".repeat(32), { mode: 0o644 });
        const [b, p] = await brokerOn(file);
        expect(await pairOn(p, { token: "a".repeat(32) })).toMatchObject({
          ok: false,
        });
        await b.close();
      }
    );
  });

  describe("idle lifecycle", () => {
    it("fires onIdle when nothing is attached", async () => {
      const onIdle = vi.fn();
      const idle = new Broker({
        port: 0,
        idleMs: 30,
        onIdle,
        agentToken: TEST_AGENT_TOKEN,
        browserOrigins: [TEST_ORIGIN],
      });
      await idle.listen();
      idle.armIdle();
      await waitFor(() => onIdle.mock.calls.length > 0, 500);
      await idle.close();
    });

    it("does not fire onIdle while an agent is attached", async () => {
      const onIdle = vi.fn();
      const idle = new Broker({
        port: 0,
        idleMs: 30,
        onIdle,
        agentToken: TEST_AGENT_TOKEN,
        browserOrigins: [TEST_ORIGIN],
      });
      const p = await idle.listen();
      const a = await AgentClient.connect(p, { name: "keep" });
      idle.armIdle(); // no-op: an agent is attached
      await delay(80);
      expect(onIdle).not.toHaveBeenCalled();
      a.close();
      await idle.close();
    });
  });
});
