/**
 * protocol.ts — wire contracts shared by the broker daemon, the agent-side
 * BrokerClient, and the MCP server dispatch.
 *
 * Two links share the one port (127.0.0.1:37373):
 *   • browser ⇄ broker — the tab that drives the Studio (pairing, cmd/res,
 *     artifact stream). Additive fields (`agent` on `cmd`, the `agents` roster
 *     frame) keep an old tab working against a new broker and vice-versa.
 *   • agent ⇄ broker  — each `@swebsy/mcp` process. `hello`/`welcome` then
 *     `req`/`res`; artifact frames are forwarded verbatim to the owning agent.
 */

import type { AgentError } from "./errors.ts";

export const DEFAULT_PORT = 37373;

/** Snapshot the MCP server surfaces via swebsy_status. */
export interface RelayStatus {
  connected: boolean;
  busy: boolean;
  /** True when a timed-out command's browser task is still settling. */
  settlingTimeout: boolean;
  port: number | null;
  /**
   * False when the tab stopped answering heartbeats (the browser may have
   * frozen it). Absent on an old broker; true for a tab without heartbeats.
   */
  responsive?: boolean;
  /** Agents currently attached to the broker (empty on the legacy relay). */
  agents?: AgentInfo[];
}

/** One row of the agent roster (broadcast to the browser, and in status). */
export interface AgentInfo {
  id: string;
  name: string;
  version?: string;
  pid?: number;
  busy: boolean;
}

/**
 * The surface the MCP server's dispatch needs. Implemented by both `Broker`
 * (in-process, sync) and `BrokerClient` (over WS, async) — hence the union
 * return types; callers `await`.
 */
export interface RelayApi {
  startPairing(opts?: {
    reuse?: boolean;
  }): PairingResult | Promise<PairingResult>;
  status(): RelayStatus | Promise<RelayStatus>;
  sendCommand(
    tool: string,
    args: unknown,
    timeoutMs?: number,
    opts?: CommandOptions
  ): Promise<unknown>;
  /** Broker features from the handshake. Absent or empty = legacy broker. */
  features?(): Set<string> | Promise<Set<string>>;
}

export interface PairingResult {
  code: string;
  port: number;
  /** False when `reuse` returned the live code (absent on an old broker). */
  fresh?: boolean;
}

export interface CommandOptions {
  signal?: AbortSignal;
  /** Epoch ms. Still queued behind another command then → `busy`, never run. */
  queueDeadline?: number;
}

/**
 * What this broker understands beyond the original protocol. An agent sends a
 * new op or field only when the broker advertised it, because an old broker
 * never answers a `req` it doesn't know — the call would hang.
 */
export const BROKER_FEATURES = ["pair_reuse", "cancel", "deadline"] as const;

// ── agent ⇄ broker frames ────────────────────────────────────────────────

/** Agent → broker. */
export type AgentToBroker =
  | {
      type: "hello";
      token: string;
      name?: string;
      version?: string;
      pid?: number;
    }
  | { type: "req"; reqId: string; op: "start_pairing"; reuse?: boolean }
  | { type: "req"; reqId: string; op: "status" }
  | {
      type: "req";
      reqId: string;
      op: "cmd";
      tool: string;
      args: unknown;
      timeoutMs?: number;
      queueDeadline?: number;
    }
  | { type: "cancel"; reqId: string };

/** Broker → agent. Artifact frames (`artifact_*`) are forwarded verbatim. */
export type BrokerToAgent =
  | { type: "welcome"; agentId: string; features?: string[] }
  | { type: "res"; reqId: string; ok: true; result: unknown }
  | { type: "res"; reqId: string; ok: false; error: AgentError };
