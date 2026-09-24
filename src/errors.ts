/**
 * Structured error model for the MCP bridge.
 *
 * Every failure the bridge returns to the agent carries one of these codes (not
 * a bare string) so an agent can branch on the reason. Shared by the relay, the
 * MCP server, and the artifact receiver.
 */

export type AgentErrorCode =
  | "not_connected" // no paired Studio tab is connected
  | "not_paired" // pairing frame rejected (bad/expired code)
  | "timeout" // command exceeded its per-command deadline
  | "validation_failed" // tool args / settings patch rejected
  | "artifact_failed" // artifact stream failed (size cap, checksum, path)
  | "no_selection" // capture selectionOnly with nothing selected
  | "cancelled" // the agent cancelled the call before it finished
  | "busy" // queued past its deadline behind another command; never ran
  | "tab_unresponsive" // tab is attached but stopped answering heartbeats
  | "slot_held"; // an automatic resume found another live tab in the slot

export interface AgentError {
  code: AgentErrorCode;
  message: string;
}

export class BridgeError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }

  toJSON(): AgentError {
    return { code: this.code, message: this.message };
  }
}

/** Type guard for error frames coming back over the wire. */
export function isAgentError(value: unknown): value is AgentError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === "string" && typeof v.message === "string";
}
