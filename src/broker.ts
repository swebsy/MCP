/**
 * broker.ts — the localhost multi-agent bridge daemon.
 *
 * Generalizes the old single-agent relay: one process owns 127.0.0.1:37373 and
 * multiplexes MANY coding-agent processes onto ONE paired Studio tab.
 *
 *   • Browser session (unchanged contract): a single paired tab, a short-lived
 *     single-use pairing code, a long-lived resume token for reload/wake, and a
 *     one-command-in-flight mutex with timeout/abort. Commands never overlap —
 *     agents interleave but the editor only ever runs one at a time.
 *   • Agents: each `@swebsy/mcp` process connects as a client (never binds a
 *     port), says `hello`, gets an id, and issues `req`s. Each `cmd` sent to the
 *     tab is tagged with the originating agent; the tab's `res` and any streamed
 *     artifact frames route back to that agent. The roster is pushed to the tab.
 *   • Lifetime: a standalone daemon (spawned by the first agent), so no single
 *     agent's exit drops the bridge. Self-exits when idle (no agents, no tab).
 *
 * Runs in its own process via `server.js --broker`; agents reach it through
 * BrokerClient. Backward compatible: an old tab ignores the extra `agent`/
 * `agents` fields; a new tab treats their absence as a single unnamed agent.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { BridgeError, type AgentError } from "./errors.ts";
import {
  BROKER_FEATURES,
  DEFAULT_PORT,
  type AgentInfo,
  type CommandOptions,
  type PairingResult,
  type RelayStatus,
} from "./protocol.ts";
import {
  brokerSessionPath,
  readOrCreateAgentToken,
  readSessionToken,
  writeSessionToken,
} from "./brokerAuth.ts";

// Long enough for the user to find the tab or switch browsers; still
// single-use, origin-checked and local to 127.0.0.1.
const PAIRING_TTL_MS = 10 * 60_000;
/** How long `start_pairing({reuse})` hands back the same code: one recovery. */
const REUSE_WINDOW_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_MS = 30_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_CONNECTIONS = 32;
const HANDSHAKE_TIMEOUT_MS = 5_000;
// App-level heartbeat. A WS protocol ping is useless here: the browser answers
// it even while the page's JS is frozen, which is exactly the state to detect.
const PING_INTERVAL_MS = 15_000;
const RESPONSIVE_WINDOW_MS = 35_000;
// A timed-out command holds the slot until the tab settles. If the tab has also
// gone silent this long, drop it so the editor unlocks for everyone else.
const STUCK_SLOT_SILENCE_MS = 60_000;
// Ceiling on an agent-requested timeout. Matches the longest any tool asks
// for — export_template's 5 minutes of headless per-block capture — because
// clamping under it aborted exports the tool's own allowance permits.
export const MAX_COMMAND_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_BROWSER_ORIGINS = [
  "https://swebsy.com",
  "https://www.swebsy.com",
  "https://studio.swebsy.com",
  // Staging is a first-party Swebsy app; QA pairs against it the same way.
  "https://staging.swebsy.com",
];

/** Frames the browser tab sends. Artifact frames pass through to the owner. */
type ClientFrame =
  | {
      type: "pair";
      code?: string;
      token?: string;
      auto?: boolean;
      features?: string[];
    }
  | { type: "res"; id: string; ok: true; result: unknown }
  | { type: "res"; id: string; ok: false; error: AgentError }
  | { type: string; [key: string]: unknown };

/** Frames we send to the browser tab. */
type ServerFrame =
  | { type: "paired"; ok: true; token: string }
  | { type: "paired"; ok: false; error: AgentError }
  | { type: "cmd"; id: string; tool: string; args: unknown; agent?: AgentMeta }
  | { type: "abort"; id: string }
  | { type: "revoked" }
  | { type: "ping" }
  | { type: "agents"; list: AgentInfo[] };

type AgentMeta = { id: string; name: string };

interface AgentConn {
  ws: WebSocket;
  name: string;
  version?: string;
  pid?: number;
  busy: boolean;
  /** Last frame from this agent. Only used to pick an eviction victim. */
  lastSeen: number;
}

interface Pending {
  id: string;
  tool: string;
  resolve: (result: unknown) => void;
  reject: (err: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
  timedOut: boolean;
}

export interface BrokerOptions {
  port?: number;
  commandTimeoutMs?: number;
  idleMs?: number;
  /** Called when idle (no agents, no tab) for `idleMs`. Daemon exits here. */
  onIdle?: () => void;
  agentToken?: string;
  browserOrigins?: string[];
  /** Persist the browser resume token here so it survives a broker restart. */
  sessionFile?: string;
}

export class Broker {
  private wss: WebSocketServer | null = null;
  private port: number | null = null;
  private readonly requestedPort: number;
  private readonly commandTimeoutMs: number;
  private readonly idleMs: number;
  private readonly onIdle?: () => void;
  private readonly configuredAgentToken?: string;
  private agentToken: string | null = null;
  private readonly browserOrigins: Set<string>;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly origins = new WeakMap<WebSocket, string | undefined>();
  private readonly handshakeTimers = new WeakMap<
    WebSocket,
    ReturnType<typeof setTimeout>
  >();

  // Browser session (single paired tab).
  private paired: WebSocket | null = null;
  private pairingCode: { code: string; expiresAt: number } | null = null;
  private sessionToken: string | null = null;
  private readonly sessionFile?: string;
  private pending: Pending | null = null;
  private busy = false;
  private readonly waiters: Array<() => void> = [];
  // Heartbeat state for the paired tab; only a tab that advertised `pong`.
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private readonly cancels = new Map<string, AbortController>();
  /** Agent that owns the in-flight command's artifact stream (serialized). */
  private artifactOwner: string | null = null;

  // Agents.
  private readonly agents = new Map<string, AgentConn>();
  private readonly agentIdBySocket = new WeakMap<WebSocket, string>();

  constructor(opts: BrokerOptions = {}) {
    const envPort = process.env.SWEBSY_AGENT_PORT;
    this.requestedPort =
      opts.port ?? (envPort ? Number(envPort) : DEFAULT_PORT);
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.onIdle = opts.onIdle;
    this.configuredAgentToken = opts.agentToken;
    this.sessionFile = opts.sessionFile;
    const configuredOrigins = opts.browserOrigins ??
      process.env.SWEBSY_APP_ORIGINS?.split(",").map((v) => v.trim()) ??
        // SWEBSY_APP_URL is where start_pairing sends the user, so its origin is
        // already trusted by the same process. Trusting it here too keeps local
        // development from failing at pair time on a second, undiscoverable knob.
        [...DEFAULT_BROWSER_ORIGINS, appUrlOrigin()];
    this.browserOrigins = new Set(configuredOrigins.filter(Boolean));
  }

  /** Bind the socket. Rejects (fails fast) if the port is already in use. */
  async listen(): Promise<number> {
    this.agentToken =
      this.configuredAgentToken ??
      (await readOrCreateAgentToken(this.requestedPort));
    if (this.sessionFile) {
      this.sessionToken = await readSessionToken(this.sessionFile).catch(
        (err) => {
          console.error("[swebsy-broker] ignoring saved session:", err);
          return null;
        }
      );
    }
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: this.requestedPort,
        maxPayload: MAX_FRAME_BYTES,
      });
      wss.once("error", reject); // EADDRINUSE → fail fast
      wss.once("listening", () => {
        wss.removeListener("error", reject);
        wss.on("error", () => {});
        this.wss = wss;
        this.port = (wss.address() as AddressInfo).port;
        wss.on("connection", (socket, request) =>
          this.onConnection(socket, request)
        );
        resolve(this.port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stopPing();
    for (const socket of this.wss?.clients ?? []) socket.terminate();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }

  portNumber(): number | null {
    return this.port;
  }

  // --- Pairing (browser) --------------------------------------------------

  /**
   * `reuse` hands back a code minted in the last REUSE_WINDOW_MS
   * (`fresh: false`) instead of minting one, so parallel auto-recoveries open
   * the browser only once. An older code may have gone unused (the tab
   * resumed its token instead), so a later recovery must open a tab again.
   */
  startPairing(opts: { reuse?: boolean } = {}): PairingResult {
    if (this.port === null) {
      throw new BridgeError("not_connected", "Broker is not listening yet.");
    }
    const live = this.pairingCode;
    if (
      opts.reuse &&
      live &&
      Date.now() < live.expiresAt &&
      Date.now() < live.expiresAt - PAIRING_TTL_MS + REUSE_WINDOW_MS
    ) {
      return { code: live.code, port: this.port, fresh: false };
    }
    const code = randomBytes(4).toString("hex");
    this.pairingCode = { code, expiresAt: Date.now() + PAIRING_TTL_MS };
    return { code, port: this.port, fresh: true };
  }

  status(): RelayStatus {
    return {
      connected: this.paired !== null,
      responsive: this.isResponsive(),
      busy: this.busy,
      settlingTimeout: this.pending?.timedOut ?? false,
      port: this.port,
      agents: this.roster(),
    };
  }

  /** True unless a heartbeat-capable tab has gone quiet. */
  private isResponsive(): boolean {
    if (!this.pingTimer) return true;
    return Date.now() - this.lastPong < RESPONSIVE_WINDOW_MS;
  }

  private roster(): AgentInfo[] {
    return [...this.agents.entries()].map(([id, a]) => ({
      id,
      name: a.name,
      version: a.version,
      pid: a.pid,
      busy: a.busy,
    }));
  }

  // --- Command dispatch (serialized across all agents) --------------------

  /**
   * Send a command to the paired tab and await its response. Serialized: one in
   * flight at a time, shared across every agent. `agent` tags the `cmd` for the
   * tab's activity feed and owns any artifact frames the command streams back.
   */
  async sendCommand(
    tool: string,
    args: unknown,
    timeoutMs = this.commandTimeoutMs,
    agent?: AgentMeta,
    opts: CommandOptions = {}
  ): Promise<unknown> {
    const { signal } = opts;
    if (!this.isPairedOpen()) {
      throw new BridgeError(
        "not_connected",
        "No paired Studio tab is connected."
      );
    }
    if (!this.isResponsive()) throw tabUnresponsive();
    if (signal?.aborted) throw cancelled();
    await this.acquireSlot(signal, opts.queueDeadline);

    const socket = this.paired;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.releaseSlot();
      throw new BridgeError(
        "not_connected",
        "No paired Studio tab is connected."
      );
    }
    if (signal?.aborted) {
      this.releaseSlot();
      throw cancelled();
    }

    const id = randomBytes(8).toString("hex");
    this.artifactOwner = agent?.id ?? null;
    return new Promise<unknown>((resolve, reject) => {
      // Timeout and cancel end the same way: tell the tab to abort, answer the
      // agent now, and keep the slot until the tab settles. Never replayed.
      const giveUp = (error: BridgeError) => {
        if (this.pending?.id !== id || this.pending.timedOut) return;
        this.pending.timedOut = true;
        signal?.removeEventListener("abort", onAbort);
        this.send(socket, { type: "abort", id });
        reject(error);
      };
      const onAbort = () => giveUp(cancelled());
      const timer = setTimeout(
        () =>
          giveUp(
            new BridgeError(
              "timeout",
              `Command "${tool}" timed out after ${timeoutMs}ms. It may still have run — read the page before retrying. The editor stays locked until the tab responds or disconnects.`
            )
          ),
        timeoutMs
      );
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending = {
        id,
        tool,
        resolve: (result) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
        timer,
        timedOut: false,
      };
      this.send(socket, {
        type: "cmd",
        id,
        tool,
        args,
        ...(agent ? { agent } : {}),
      });
    });
  }

  private onResponse(frame: Extract<ClientFrame, { type: "res" }>): void {
    const p = this.pending;
    if (!p || p.id !== frame.id) return;
    clearTimeout(p.timer);
    this.pending = null;
    this.artifactOwner = null;
    this.releaseSlot();
    if (p.timedOut) return;
    if (frame.ok) p.resolve(frame.result);
    else p.reject(new BridgeError(frame.error.code, frame.error.message));
  }

  private acquireSlot(
    signal?: AbortSignal,
    queueDeadline?: number
  ): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const leave = (error: BridgeError) => {
        const i = this.waiters.indexOf(waiter);
        if (i === -1) return; // already handed the slot
        this.waiters.splice(i, 1);
        cleanup();
        reject(error);
      };
      const onAbort = () => leave(cancelled());
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter = () => {
        cleanup();
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (queueDeadline !== undefined) {
        timer = setTimeout(
          () =>
            leave(
              new BridgeError(
                "busy",
                "Studio was still busy with an earlier command (this agent's or another's), so this one was not run. Retry it."
              )
            ),
          Math.max(0, queueDeadline - Date.now())
        );
      }
    });
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.busy = false;
  }

  // --- Connections --------------------------------------------------------

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    if ((this.wss?.clients.size ?? 0) > MAX_CONNECTIONS) {
      // ponytail: make room by dropping the quietest agent instead of refusing
      // the newcomer. A hard cap fails in the worst direction — the agent that
      // gets locked out is the one someone is actively waiting on, while the
      // slot-holders are idle. Eviction is safe: brokerClient reconnects on
      // close, so a live agent is back within RECONNECT_DELAY_MS.
      if (!this.evictQuietestAgent()) {
        socket.close(1013, "Too many connections");
        return;
      }
    }
    this.origins.set(socket, request.headers.origin);
    const timer = setTimeout(() => {
      if (!this.agentIdBySocket.has(socket) && socket !== this.paired) {
        socket.close(1008, "Handshake required");
      }
    }, HANDSHAKE_TIMEOUT_MS);
    this.handshakeTimers.set(socket, timer);
    socket.on("message", (data) => this.onMessage(socket, data.toString()));
    socket.on("close", () => this.onClose(socket));
    socket.on("error", () => {});
  }

  private onMessage(socket: WebSocket, raw: string): void {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw) as ClientFrame;
    } catch {
      socket.close();
      return;
    }

    // Known agent socket → agent protocol.
    if (this.agentIdBySocket.has(socket)) {
      this.onAgentFrame(socket, frame as Record<string, unknown>);
      return;
    }
    // First frame decides the role.
    if (frame.type === "hello") {
      if (!this.validAgentToken((frame as Record<string, unknown>).token)) {
        socket.close(1008, "Agent authentication failed");
        return;
      }
      this.registerAgent(socket, frame as Record<string, unknown>);
      return;
    }

    // Browser path.
    if (frame.type === "pair") {
      this.onPair(socket, frame as Extract<ClientFrame, { type: "pair" }>);
      return;
    }
    if (socket !== this.paired) {
      socket.close();
      return;
    }
    if (frame.type === "pong") {
      this.lastPong = Date.now();
      return;
    }
    if (frame.type === "res") {
      this.onResponse(frame as Extract<ClientFrame, { type: "res" }>);
      return;
    }
    // Artifact stream → forward to the agent that owns the in-flight command.
    this.forwardArtifact(frame);
  }

  private onClose(socket: WebSocket): void {
    this.clearHandshakeTimer(socket);
    if (this.agentIdBySocket.has(socket)) {
      this.deregisterAgent(socket);
      return;
    }
    if (socket !== this.paired) return;
    this.paired = null;
    this.stopPing();
    this.settlePendingSession("Studio tab disconnected.");
    this.armIdle();
  }

  // --- Agent registry -----------------------------------------------------

  private registerAgent(socket: WebSocket, f: Record<string, unknown>): void {
    this.clearHandshakeTimer(socket);
    const id = randomBytes(4).toString("hex");
    this.agents.set(id, {
      ws: socket,
      name:
        typeof f.name === "string" && f.name ? f.name.slice(0, 80) : "agent",
      version: typeof f.version === "string" ? f.version : undefined,
      pid: typeof f.pid === "number" ? f.pid : undefined,
      busy: false,
      lastSeen: Date.now(),
    });
    this.agentIdBySocket.set(socket, id);
    this.cancelIdle();
    this.sendAgent(socket, {
      type: "welcome",
      agentId: id,
      features: [...BROKER_FEATURES],
    });
    this.broadcastRoster();
  }

  /**
   * Close the longest-idle non-busy agent so a new one can connect. Returns
   * false when every slot is busy — then the newcomer really must wait.
   *
   * This is a backstop, not the cure: an abandoned agent reconnects like any
   * other, so it can reclaim a slot. What stops orphans accumulating is the
   * stdin-EOF exit in server.ts; this only guarantees a live agent can always
   * get in.
   */
  private evictQuietestAgent(): boolean {
    let victim: AgentConn | null = null;
    for (const conn of this.agents.values()) {
      if (conn.busy) continue;
      if (!victim || conn.lastSeen < victim.lastSeen) victim = conn;
    }
    if (!victim) return false;
    victim.ws.close(1001, "Evicted: connection table full");
    return true;
  }

  private deregisterAgent(socket: WebSocket): void {
    const id = this.agentIdBySocket.get(socket);
    this.agentIdBySocket.delete(socket);
    if (id) this.agents.delete(id);
    this.broadcastRoster();
    this.armIdle();
  }

  private onAgentFrame(socket: WebSocket, f: Record<string, unknown>): void {
    const seenId = this.agentIdBySocket.get(socket);
    const seen = seenId ? this.agents.get(seenId) : undefined;
    if (seen) seen.lastSeen = Date.now();
    if (f.type === "cancel") {
      this.cancels.get(this.cancelKey(socket, String(f.reqId)))?.abort();
      return;
    }
    if (f.type !== "req") return;
    const reqId = String(f.reqId);
    const op = String(f.op);
    if (op === "start_pairing") {
      try {
        this.sendAgent(socket, {
          type: "res",
          reqId,
          ok: true,
          result: this.startPairing({ reuse: f.reuse === true }),
        });
      } catch (err) {
        this.replyAgentError(socket, reqId, err);
      }
      return;
    }
    if (op === "status") {
      this.sendAgent(socket, {
        type: "res",
        reqId,
        ok: true,
        result: this.status(),
      });
      return;
    }
    if (op === "cmd") {
      void this.runAgentCmd(socket, reqId, f);
    }
  }

  private async runAgentCmd(
    socket: WebSocket,
    reqId: string,
    f: Record<string, unknown>
  ): Promise<void> {
    const agentId = this.agentIdBySocket.get(socket);
    const agent = agentId ? this.agents.get(agentId) : undefined;
    if (!agentId || !agent) return;
    const key = this.cancelKey(socket, reqId);
    const cancel = new AbortController();
    this.cancels.set(key, cancel);
    agent.busy = true;
    this.broadcastRoster();
    try {
      const result = await this.sendCommand(
        String(f.tool),
        f.args,
        typeof f.timeoutMs === "number"
          ? Math.max(1_000, Math.min(f.timeoutMs, MAX_COMMAND_TIMEOUT_MS))
          : undefined,
        { id: agentId, name: agent.name },
        {
          signal: cancel.signal,
          queueDeadline:
            typeof f.queueDeadline === "number" ? f.queueDeadline : undefined,
        }
      );
      this.sendAgent(socket, { type: "res", reqId, ok: true, result });
    } catch (err) {
      this.replyAgentError(socket, reqId, err);
    } finally {
      this.cancels.delete(key);
      const a = this.agents.get(agentId);
      if (a) {
        a.busy = false;
        this.broadcastRoster();
      }
    }
  }

  private cancelKey(socket: WebSocket, reqId: string): string {
    return `${this.agentIdBySocket.get(socket)}:${reqId}`;
  }

  private replyAgentError(
    socket: WebSocket,
    reqId: string,
    err: unknown
  ): void {
    const error: AgentError =
      err instanceof BridgeError
        ? err.toJSON()
        : { code: "validation_failed", message: String(err) };
    this.sendAgent(socket, { type: "res", reqId, ok: false, error });
  }

  private forwardArtifact(frame: ClientFrame): void {
    const ownerId = this.artifactOwner;
    if (!ownerId) return;
    const owner = this.agents.get(ownerId);
    if (owner && owner.ws.readyState === WebSocket.OPEN) {
      owner.ws.send(JSON.stringify(frame));
    }
  }

  private broadcastRoster(): void {
    if (this.isPairedOpen()) {
      this.send(this.paired!, { type: "agents", list: this.roster() });
    }
  }

  // --- Browser pairing ----------------------------------------------------

  private onPair(
    socket: WebSocket,
    frame: Extract<ClientFrame, { type: "pair" }>
  ): void {
    const { code, token } = frame;
    const pong =
      Array.isArray(frame.features) && frame.features.includes("pong");
    const origin = this.origins.get(socket);
    if (!origin || !this.browserOrigins.has(origin)) {
      this.rejectPair(socket, "This browser origin is not allowed to pair.");
      return;
    }
    if (token) {
      if (!this.sessionToken || !safeEqual(token, this.sessionToken)) {
        this.rejectPair(socket, "Session expired — re-pair with a new code.");
        return;
      }
      // An automatic resume never takes the slot from a live tab — only a
      // user action (Take over, a manual code) may. A frozen holder that has
      // stopped answering heartbeats doesn't count as live.
      if (
        frame.auto === true &&
        this.isPairedOpen() &&
        this.paired !== socket &&
        this.isResponsive()
      ) {
        this.rejectPair(
          socket,
          "Another Swebsy tab is connected to your agent.",
          "slot_held"
        );
        return;
      }
      this.attach(socket, this.sessionToken, pong);
      return;
    }
    const pc = this.pairingCode;
    if (
      !pc ||
      !code ||
      !safeEqual(pc.code, code) ||
      Date.now() > pc.expiresAt
    ) {
      this.rejectPair(socket, "Invalid or expired pairing code.");
      return;
    }
    this.pairingCode = null;
    this.sessionToken = randomBytes(16).toString("hex");
    if (this.sessionFile) {
      void writeSessionToken(this.sessionFile, this.sessionToken).catch((err) =>
        console.error("[swebsy-broker] could not save session:", err)
      );
    }
    this.attach(socket, this.sessionToken, pong);
  }

  private rejectPair(
    socket: WebSocket,
    message: string,
    code: AgentError["code"] = "not_paired"
  ): void {
    this.send(socket, {
      type: "paired",
      ok: false,
      error: { code, message },
    });
    socket.close();
  }

  private attach(socket: WebSocket, token: string, pong = false): void {
    this.clearHandshakeTimer(socket);
    if (this.paired && this.paired !== socket) {
      const old = this.paired;
      this.paired = null;
      this.send(old, { type: "revoked" });
      old.close();
      this.settlePendingSession("Studio tab session was replaced.");
    }
    this.paired = socket;
    this.stopPing();
    if (pong) this.startPing(socket);
    this.cancelIdle();
    this.send(socket, { type: "paired", ok: true, token });
    this.broadcastRoster(); // hand the freshly-paired tab the current roster
  }

  private settlePendingSession(message: string): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    this.artifactOwner = null;
    if (!p.timedOut) {
      p.reject(new BridgeError("not_connected", message));
    }
    this.releaseSlot();
  }

  private startPing(socket: WebSocket): void {
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      if (socket !== this.paired) return;
      const silentFor = Date.now() - this.lastPong;
      if (this.pending?.timedOut && silentFor >= STUCK_SLOT_SILENCE_MS) {
        // onClose settles the pending command and frees the slot. The tab
        // aborts that command when it reconnects, so nothing overlaps.
        socket.terminate();
        return;
      }
      this.send(socket, { type: "ping" });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private isPairedOpen(): boolean {
    return this.paired?.readyState === WebSocket.OPEN;
  }

  private send(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }

  private sendAgent(
    socket: WebSocket,
    frame: { type: string; [k: string]: unknown }
  ): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }

  private validAgentToken(value: unknown): boolean {
    return (
      typeof value === "string" &&
      this.agentToken !== null &&
      safeEqual(value, this.agentToken)
    );
  }

  private clearHandshakeTimer(socket: WebSocket): void {
    const timer = this.handshakeTimers.get(socket);
    if (timer) clearTimeout(timer);
    this.handshakeTimers.delete(socket);
  }

  // --- Idle lifecycle -----------------------------------------------------

  /** Start the idle countdown if nothing is attached; a no-op otherwise. */
  armIdle(): void {
    if (this.idleTimer) return;
    if (this.agents.size > 0 || this.isPairedOpen()) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.agents.size === 0 && !this.isPairedOpen()) this.onIdle?.();
    }, this.idleMs);
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/** Origin of the configured pairing destination, or "" when unset/invalid. */
function appUrlOrigin(): string {
  const raw = process.env.SWEBSY_APP_URL;
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

function cancelled(): BridgeError {
  return new BridgeError("cancelled", "The agent cancelled this call.");
}

function tabUnresponsive(): BridgeError {
  return new BridgeError(
    "tab_unresponsive",
    "The Swebsy tab isn't responding — the browser may have put it to sleep. Ask the user to click the Swebsy tab, then retry."
  );
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Entry point for `server.js --broker`: own the port or bow out quietly. */
export async function runBroker(): Promise<void> {
  let broker: Broker;
  broker = new Broker({
    sessionFile: brokerSessionPath(
      Number(process.env.SWEBSY_AGENT_PORT) || DEFAULT_PORT
    ),
    onIdle: () => {
      void broker.close().then(() => process.exit(0));
    },
  });
  try {
    await broker.listen();
  } catch (err) {
    // Another agent won the bind race and hosts the broker — that's fine.
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") process.exit(0);
    throw err;
  }
  console.error(
    `[swebsy-broker] listening on 127.0.0.1:${broker.portNumber()}`
  );
  broker.armIdle(); // exit if no agent/tab ever attaches
}
