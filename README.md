# @swebsy/mcp — connect your coding agent to Swebsy

**Build and edit real websites with the coding agent you already pay for — no per-token AI fees.**

`@swebsy/mcp` is an [MCP](https://modelcontextprotocol.io) server that lets Claude Code, Codex, Cursor, Windsurf, GitHub Copilot — or any agent that speaks the Model Context Protocol — drive an open [Swebsy](https://swebsy.com) Studio tab. Your agent adds sections, edits content, switches pages, captures screenshots, and exports the finished site, all over a local `127.0.0.1` WebSocket relay. Nothing is proxied through our servers, and Studio redacts secrets (API keys, deploy tokens, chat history) before anything crosses the bridge.

## What is Swebsy?

Swebsy is a **visual website builder** with a real ownership model: you build visually, export real files (HTML/CSS/JS), and publish wherever you want — no lock-in, no proprietary hosting requirement. The free plan runs fully local; no account required.

## Why use an MCP instead of a built-in AI panel?

Most "AI website builders" bolt on a chat panel and **bill you per token** on top of the model you're already subscribed to. Swebsy takes the opposite approach — it exposes the editor as a tool your **own** agent can drive:

- **No per-token API billing.** Swebsy isn't in the loop on model costs. You use the Claude, Cursor, Codex, or Copilot plan you already pay for.
- **Runs on your machine.** The agent talks to your open Studio tab over a local `127.0.0.1` bridge — prompts and content aren't shipped off to be metered.
- **Bring your own agent.** Your model, your custom instructions, your workflow — not a locked-down wrapper. Any MCP-capable agent works.
- **You own the output.** Everything the agent builds exports as real, portable files you can host anywhere.

## Setup

**Claude Code**

```bash
claude mcp add swebsy -- npx -y @swebsy/mcp
```

**Codex**

```bash
codex mcp add swebsy -- npx -y @swebsy/mcp
```

**Cursor** — add to `~/.cursor/mcp.json` (or a project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "swebsy": { "command": "npx", "args": ["-y", "@swebsy/mcp"] }
  }
}
```

**GitHub Copilot (VS Code)**

```bash
code --add-mcp '{"name":"swebsy","command":"npx","args":["-y","@swebsy/mcp"]}'
```

**Windsurf** — add the same JSON block to `~/.codeium/windsurf/mcp_config.json`.

## Pairing

1. Ask your agent to run the `swebsy_start_pairing` tool — it returns a
   single-use pairing link plus the raw code and relay port.
2. Open the pairing link in the browser where Swebsy is running. Swebsy connects
   automatically and strips the code from the address bar after it is used.
3. If your terminal cannot open links, use the fallback fields in **Global
   settings → Coding agents**: paste the raw code, leave the port at **37373**
   unless you changed `SWEBSY_AGENT_PORT`, and click **Connect**.
4. Prompt your agent as usual — it drives the tab through the `swebsy_*` tools.

Full guide: <https://docs.swebsy.com/settings/ai-coding-agent/>

## What your agent can do

Once paired, your agent has tools to read the page tree, add and edit sections,
create and link pages, insert blocks, manage reusable symbols, capture
screenshots at any viewport, and export the project — the same operations you'd
perform by hand in Studio.

## Configuration

| Env var             | Default                     | Purpose                          |
| ------------------- | --------------------------- | -------------------------------- |
| `SWEBSY_AGENT_PORT` | `37373`                     | Port the local relay listens on  |
| `SWEBSY_AGENT_DIR`  | `./swebsy-agent`            | Where screenshots/exports land   |
| `SWEBSY_APP_URL`    | `https://app.swebsy.com`    | Studio origin for the `swebsy_start_pairing` link (set for local/self-host) |

## Links

- Website: <https://swebsy.com>
- Setup guide: <https://docs.swebsy.com/settings/ai-coding-agent/>
- npm: <https://www.npmjs.com/package/@swebsy/mcp>

## License

MIT
