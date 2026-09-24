/**
 * brokerClient.ts — the agent-side handle to the broker daemon.
 *
 * Implements the same `RelayApi` the MCP server dispatch already depends on
 * (startPairing / status / sendCommand), but over a WS to the shared broker
 * instead of an in-process relay. Says `hello` (so the roster can label this
 * agent), correlates `req`/`res`, and feeds forwarded artifact frames into this
 * process's own ArtifactReceiver. Reconnects (re-spawning the daemon if needed)
 * if the broker goes away.
 */

import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { BridgeError } from "./errors.ts";
import { ensureBroker, type EnsureBrokerOptions } from "./ensureBroker.ts";
import { readOrCreateAgentToken } from "./brokerAuth.ts";
import { resolveBrokerPort } from "./ensureBroker.ts";
import type {
  CommandOptions,
  PairingResult,
  RelayApi,
  RelayStatus,
} from "./protocol.ts";

/** Just the frame sink we need — an ArtifactReceiver satisfies it. */
interface FrameSink {
  handleFrame(frame: unknown): void;
}

interface PendingReq {
  resolve: (result: unknown) => void;
  reject: (err: BridgeError) => void;
}

const RECONNECT_DELAY_MS = 1000;
const WELCOME_TIMEOUT_MS = 2000;

export class BrokerClient implements RelayApi {
  private ws: WebSocket | null = null;
  private name?: string;
  private version?: string;
  private connecting: Promise<void> | null = null;
  private closed = false;
  /** From `welcome`; empty until connected, and forever on an old broker. */
  private feats = new Set<string>();
  private readonly reqs = new Map<string, PendingReq>();
  private readonly artifacts: FrameSink;
  private readonly ensureOpts: EnsureBrokerOptions;

  constructor(artifacts: FrameSink, ensureOpts: EnsureBrokerOptions = {}) {
    this.artifacts = artifacts;
    this.ensureOpts = ensureOpts;
  }

  /** Set the agent label (from the MCP client handshake) before connecting. */
  setInfo(name?: string, version?: string): void {
    this.name = name;
    this.version = version;
  }

  /** Eagerly connect; optional — the first request connects lazily anyway. */
  async start(): Promise<void> {
    await this.ensureConnected();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.rejectPending(
      new BridgeError("not_connected", "Broker connection closed.")
    );
  }

  async features(): Promise<Set<string>> {
    await this.ensureConnected();
    return this.feats;
  }

  async startPairing(opts: { reuse?: boolean } = {}): Promise<PairingResult> {
    await this.ensureConnected();
    const reuse = opts.reuse && this.feats.has("pair_reuse");
    return this.req({
      op: "start_pairing",
      ...(reuse ? { reuse: true } : {}),
    }) as Promise<PairingResult>;
  }

  status(): Promise<RelayStatus> {
    return this.req({ op: "status" }) as Promise<RelayStatus>;
  }

  async sendCommand(
    tool: string,
    args: unknown,
    timeoutMs?: number,
    opts: CommandOptions = {}
  ): Promise<unknown> {
    await this.ensureConnected();
    const deadline =
      opts.queueDeadline !== undefined && this.feats.has("deadline")
        ? { queueDeadline: opts.queueDeadline }
        : {};
    return this.req(
      { op: "cmd", tool, args, timeoutMs, ...deadline },
      opts.signal
    );
  }

  // --- internals ----------------------------------------------------------

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (!this.connecting) this.connecting = this.doConnect();
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    let ws: WebSocket | null = null;
    try {
      const socket = await ensureBroker(this.ensureOpts);
      ws = socket;
      this.ws = socket;
      socket.on("message", (data) => this.onMessage(socket, data.toString()));
      socket.on("close", () => this.onClose(socket));
      socket.on("error", () => {});
      const welcome = this.waitForWelcome(socket);
      const token =
        this.ensureOpts.agentToken ??
        (await readOrCreateAgentToken(
          this.ensureOpts.port ?? resolveBrokerPort()
        ));
      this.send({
        type: "hello",
        token,
        name: this.name,
        version: this.version,
        pid: process.pid,
      });
      await welcome;
    } catch (err) {
      if (ws && this.ws === ws) this.ws = null;
      ws?.close();
      throw err;
    } finally {
      this.connecting = null;
    }
  }

  private onMessage(socket: WebSocket, raw: string): void {
    if (socket !== this.ws) return;
    let frame: { type?: string; [k: string]: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.type === "welcome") {
      // Registered; the broker owns our agent id. No list = an old broker.
      this.feats = new Set(
        Array.isArray(frame.features) ? frame.features.map(String) : []
      );
      return;
    }
    if (frame.type === "res") {
      const req = this.reqs.get(String(frame.reqId));
      if (!req) return;
      this.reqs.delete(String(frame.reqId));
      if (frame.ok) {
        req.resolve(frame.result);
      } else {
        const e = frame.error as { code: string; message: string };
        req.reject(new BridgeError(e.code as never, e.message));
      }
      return;
    }
    // Artifact frames forwarded from the tab → this agent's receiver.
    this.artifacts.handleFrame(frame);
  }

  private waitForWelcome(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("message", onMessage);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      const rejectWith = (error: BridgeError) => {
        cleanup();
        reject(error);
      };
      const onMessage = (data: WebSocket.RawData) => {
        let frame: { type?: string };
        try {
          frame = JSON.parse(data.toString());
        } catch {
          rejectWith(
            new BridgeError("not_connected", "Invalid broker handshake.")
          );
          return;
        }
        if (frame.type === "welcome") {
          cleanup();
          resolve();
          return;
        }
        rejectWith(
          new BridgeError("not_connected", "Unexpected broker handshake.")
        );
      };
      const onClose = () =>
        rejectWith(new BridgeError("not_connected", "Broker connection lost."));
      const onError = () =>
        rejectWith(new BridgeError("not_connected", "Broker connection lost."));
      timer = setTimeout(
        () =>
          rejectWith(
            new BridgeError("not_connected", "Broker handshake timed out.")
          ),
        WELCOME_TIMEOUT_MS
      );
      socket.on("message", onMessage);
      socket.once("close", onClose);
      socket.once("error", onError);
    });
  }

  private onClose(socket: WebSocket): void {
    if (socket !== this.ws) return;
    this.ws = null;
    this.rejectPending(
      new BridgeError("not_connected", "Broker connection lost.")
    );
    if (this.closed) return;
    // Broker died (crash / idle-exit race) — re-spawn and reconnect.
    setTimeout(() => {
      if (!this.closed) void this.ensureConnected().catch(() => {});
    }, RECONNECT_DELAY_MS);
  }

  private async req(
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    await this.ensureConnected();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new BridgeError("not_connected", "Broker connection lost.");
    }
    if (signal?.aborted) throw cancelledError();
    const reqId = randomBytes(8).toString("hex");
    return new Promise<unknown>((resolve, reject) => {
      // Answer the caller at once; the broker (if it can) drops the queued
      // command or aborts it in the tab. Any late `res` finds no entry.
      const onAbort = () => {
        if (!this.reqs.delete(reqId)) return;
        if (this.feats.has("cancel")) this.send({ type: "cancel", reqId });
        reject(cancelledError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.reqs.set(reqId, {
        resolve: (result) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      this.send({ type: "req", reqId, ...payload });
    });
  }

  private send(frame: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private rejectPending(error: BridgeError): void {
    for (const [, req] of this.reqs) {
      req.reject(error);
    }
    this.reqs.clear();
  }
}

function cancelledError(): BridgeError {
  return new BridgeError("cancelled", "The agent cancelled this call.");
}
