/**
 * ensureBroker.ts — get a live WS connection to the broker daemon, spawning it
 * on first use.
 *
 * Connect-or-spawn: try to reach the port; if nothing answers, spawn
 * `server.js --broker` detached and poll until it's up. Race-safe — if two
 * agents spawn at once, the daemon that loses the bind race exits quietly
 * (EADDRINUSE) and both agents connect to the winner.
 */

import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { DEFAULT_PORT } from "./protocol.ts";

export function resolveBrokerPort(): number {
  const env = process.env.SWEBSY_AGENT_PORT;
  return env ? Number(env) : DEFAULT_PORT;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tryConnect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const onError = (err: unknown) => {
      ws.removeAllListeners();
      reject(err);
    };
    ws.once("error", onError);
    ws.once("open", () => {
      ws.removeListener("error", onError);
      resolve(ws);
    });
  });
}

/** Spawn the bundled entrypoint in broker mode, fully detached. */
function spawnBrokerDaemon(): void {
  const entry = process.argv[1]; // the resolved bin (dist/server.js)
  const child = spawn(process.execPath, [entry, "--broker"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export interface EnsureBrokerOptions {
  port?: number;
  /** Test/embedding override for the per-user broker credential. */
  agentToken?: string;
  /** Overridable for tests (avoid real connects / spawns). */
  connect?: (port: number) => Promise<WebSocket>;
  spawnDaemon?: () => void;
  timeoutMs?: number;
}

export async function ensureBroker(
  opts: EnsureBrokerOptions = {}
): Promise<WebSocket> {
  const port = opts.port ?? resolveBrokerPort();
  const connect = opts.connect ?? tryConnect;
  const spawnDaemon = opts.spawnDaemon ?? spawnBrokerDaemon;
  const timeoutMs = opts.timeoutMs ?? 5000;

  try {
    return await connect(port); // broker already running
  } catch {
    // fall through to spawn
  }

  spawnDaemon();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await delay(100);
    try {
      return await connect(port);
    } catch {
      if (Date.now() > deadline) {
        throw new Error(
          `Broker did not come up on 127.0.0.1:${port} within ${timeoutMs}ms.`
        );
      }
    }
  }
}
