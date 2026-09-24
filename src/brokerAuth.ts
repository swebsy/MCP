import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function brokerTokenPath(port: number): string {
  const override = process.env.SWEBSY_AGENT_AUTH_FILE;
  if (override) return override;
  const user = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `swebsy-agent-${user}`, `${port}.token`);
}

/**
 * Where the browser resume token outlives the broker. The broker exits after
 * 30s idle; without this every restart forced the user to re-pair.
 */
export function brokerSessionPath(port: number): string {
  return (
    process.env.SWEBSY_AGENT_SESSION_FILE ??
    join(homedir(), ".swebsy", `agent-${port}.session`)
  );
}

const SESSION_PATTERN = /^[a-f0-9]{32}$/;

/** The saved resume token, or null when none (or it isn't safe to trust). */
export async function readSessionToken(path: string): Promise<string | null> {
  try {
    await assertPrivatePath(path, "file");
    const token = (await readFile(path, "utf8")).trim();
    return SESSION_PATTERN.test(token) ? token : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Atomic (temp + rename) so a crash never leaves a half-written token. */
export async function writeSessionToken(
  path: string,
  token: string
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivatePath(directory, "directory");
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, token, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

async function assertPrivatePath(path: string, kind: "file" | "directory") {
  const stat = await lstat(path);
  const expected = kind === "file" ? stat.isFile() : stat.isDirectory();
  if (!expected || stat.isSymbolicLink()) {
    throw new Error(`Unsafe Swebsy broker credential ${kind}: ${path}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(
      `Swebsy broker credential ${kind} has another owner: ${path}`
    );
  }
  // Windows ACLs are not represented by POSIX mode bits. Its temp directory
  // is user-scoped; Unix must reject any group/world-accessible credential.
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`Swebsy broker credential ${kind} is not private: ${path}`);
  }
}

/**
 * Shared secret for agent processes owned by the current OS user. The file is
 * created atomically with user-only permissions; browsers never receive it.
 */
export async function readOrCreateAgentToken(port: number): Promise<string> {
  const path = brokerTokenPath(port);
  if (!process.env.SWEBSY_AGENT_AUTH_FILE) {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPrivatePath(directory, "directory");
  }
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      const token = randomBytes(32).toString("hex");
      await handle.writeFile(token, { encoding: "utf8" });
      await handle.sync();
      return token;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  await assertPrivatePath(path, "file");
  // A second process can observe EEXIST after the creator's atomic open but
  // before its write completes. Retry that tiny window instead of failing a
  // legitimate concurrent MCP startup. A persistently malformed credential is
  // still rejected rather than replaced with an attacker-known token.
  for (let attempt = 0; attempt < 20; attempt++) {
    const token = (await readFile(path, "utf8")).trim();
    if (TOKEN_PATTERN.test(token)) return token;
    if (attempt < 19) await delay(25);
  }
  throw new Error(`Invalid Swebsy broker credential file: ${path}`);
}
