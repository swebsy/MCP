import { beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchTool, SWEBSY_PROMPT } from "./server.ts";

// Don't launch a real browser during tests.
beforeAll(() => {
  process.env.SWEBSY_NO_OPEN = "1";
});
import { BridgeError } from "./errors.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayApi } from "./protocol.ts";

function fakeRelay(overrides: Partial<RelayApi> = {}) {
  const calls: Array<{ tool: string; args: unknown; timeout?: number }> = [];
  const relay: RelayApi = {
    startPairing: () => ({ code: "abc123", port: 37373 }),
    status: () => ({
      connected: true,
      busy: false,
      settlingTimeout: false,
      port: 37373,
    }),
    sendCommand: async (tool, args, timeout) => {
      calls.push({ tool, args, timeout });
      return { relayed: tool };
    },
    ...overrides,
  };
  return { relay, calls };
}

describe("dispatchTool", () => {
  it("handles start_pairing locally and returns a clickable pairUrl", async () => {
    const { relay, calls } = fakeRelay();
    const res = (await dispatchTool(relay, "swebsy_start_pairing", {})) as any;
    expect(res.code).toBe("abc123");
    expect(res.port).toBe(37373);
    expect(res.pairUrl).toBe(
      "https://studio.swebsy.com/?swebsy_pair=abc123&swebsy_port=37373"
    );
    expect(calls).toHaveLength(0); // never touches the tab
    expect(res.opened).toBe(false); // SWEBSY_NO_OPEN suppresses the auto-open
  });

  it("honors SWEBSY_APP_URL when building the pairUrl", async () => {
    const { relay } = fakeRelay();
    const prev = process.env.SWEBSY_APP_URL;
    process.env.SWEBSY_APP_URL = "http://localhost:5174/";
    try {
      const res = (await dispatchTool(
        relay,
        "swebsy_start_pairing",
        {}
      )) as any;
      expect(res.pairUrl).toBe(
        "http://localhost:5174/?swebsy_pair=abc123&swebsy_port=37373"
      );
    } finally {
      if (prev === undefined) delete process.env.SWEBSY_APP_URL;
      else process.env.SWEBSY_APP_URL = prev;
    }
  });

  it("preserves existing app URL path, query, and hash in pairUrl", async () => {
    const { relay } = fakeRelay();
    const prev = process.env.SWEBSY_APP_URL;
    process.env.SWEBSY_APP_URL =
      "http://localhost:5174/site/demo?dbName=local#panel";
    try {
      const res = (await dispatchTool(
        relay,
        "swebsy_start_pairing",
        {}
      )) as any;
      expect(res.pairUrl).toBe(
        "http://localhost:5174/site/demo?dbName=local&swebsy_pair=abc123&swebsy_port=37373#panel"
      );
    } finally {
      if (prev === undefined) delete process.env.SWEBSY_APP_URL;
      else process.env.SWEBSY_APP_URL = prev;
    }
  });

  it("encodes pairing parameters in pairUrl", async () => {
    const { relay } = fakeRelay({
      startPairing: () => ({ code: "a+b c&d", port: 37373 }),
    });
    const res = (await dispatchTool(relay, "swebsy_start_pairing", {})) as any;
    const url = new URL(res.pairUrl);
    expect(url.searchParams.get("swebsy_pair")).toBe("a+b c&d");
    expect(res.pairUrl).toContain("swebsy_pair=a%2Bb+c%26d");
  });

  it("rejects invalid SWEBSY_APP_URL values", async () => {
    const { relay } = fakeRelay();
    const prev = process.env.SWEBSY_APP_URL;
    process.env.SWEBSY_APP_URL = "localhost:5174";
    try {
      await expect(
        dispatchTool(relay, "swebsy_start_pairing", {})
      ).rejects.toMatchObject({
        code: "validation_failed",
        message: "SWEBSY_APP_URL must use http or https.",
      });
    } finally {
      if (prev === undefined) delete process.env.SWEBSY_APP_URL;
      else process.env.SWEBSY_APP_URL = prev;
    }
  });

  it("rejects unknown tools with validation_failed", async () => {
    const { relay } = fakeRelay();
    await expect(dispatchTool(relay, "swebsy_nope", {})).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("relays a shared tool by its bare wire name with the default timeout", async () => {
    const { relay, calls } = fakeRelay();
    await dispatchTool(relay, "swebsy_add_section", { at: 1 });
    expect(calls[0]).toEqual({
      tool: "add_section",
      args: { at: 1 },
      timeout: 30_000,
    });
  });

  it("gives site creation and capture/export a long timeout", async () => {
    const { relay, calls } = fakeRelay();
    await dispatchTool(relay, "swebsy_create_site", {});
    await dispatchTool(relay, "swebsy_capture", { viewport: "mobile" });
    await dispatchTool(relay, "swebsy_export", {});
    expect(calls[0].timeout).toBe(120_000);
    expect(calls[1].timeout).toBe(120_000);
    expect(calls[2].timeout).toBe(120_000);
  });

  it("gives the dev-only template export a five-minute timeout", async () => {
    const previous = process.env.SWEBSY_AUTHORING;
    process.env.SWEBSY_AUTHORING = "1";
    vi.resetModules();
    try {
      const { dispatchTool: dispatchAuthoringTool } =
        await import("./server.ts");
      const { relay, calls } = fakeRelay();
      await dispatchAuthoringTool(relay, "swebsy_export_template", {
        name: "Portfolio",
      });
      expect(calls[0]).toEqual({
        tool: "export_template",
        args: { name: "Portfolio" },
        timeout: 300_000,
      });
    } finally {
      if (previous === undefined) delete process.env.SWEBSY_AUTHORING;
      else process.env.SWEBSY_AUTHORING = previous;
      vi.resetModules();
    }
  });

  it("resolves capture/export artifact ids to written absolute paths", async () => {
    const { relay } = fakeRelay({
      sendCommand: async () => ({
        viewport: "mobile",
        artifacts: [{ id: "art-1", kind: "screenshots", filename: "s/m.png" }],
      }),
    });
    const artifacts = { result: async (id: string) => `/abs/${id}.png` };
    const res = (await dispatchTool(
      relay,
      "swebsy_capture",
      { viewport: "mobile" },
      artifacts
    )) as any;
    expect(res.artifacts[0]).toEqual({
      id: "art-1",
      kind: "screenshots",
      filename: "s/m.png",
      path: "/abs/art-1.png",
    });
  });

  it("surfaces a failed artifact write as a rejected tool call", async () => {
    const { relay } = fakeRelay({
      sendCommand: async () => ({
        artifacts: [{ id: "art-2", kind: "exports", filename: "p.json" }],
      }),
    });
    const artifacts = {
      result: async () => {
        throw new BridgeError("artifact_failed", "Checksum mismatch.");
      },
    };
    await expect(
      dispatchTool(relay, "swebsy_export", {}, artifacts)
    ).rejects.toMatchObject({ code: "artifact_failed" });
  });

  it("collapses an export to outDir + pages + counts", async () => {
    const files = [
      "index.html",
      "pricing.html",
      "css/site.css",
      "js/main.js",
      "fonts/inter.woff2",
      "assets/logo.svg",
      "project.json",
    ];
    const { relay } = fakeRelay({
      sendCommand: async () => ({
        includeStatic: true,
        artifacts: files.map((f, i) => ({
          id: `a${i}`,
          kind: "exports",
          filename: f,
        })),
      }),
    });
    const artifacts = {
      result: async (id: string) =>
        `/root/exports/site/ts/${files[Number(id.slice(1))]}`,
    };

    const res = (await dispatchTool(
      relay,
      "swebsy_export",
      {},
      artifacts
    )) as any;
    expect(res.outDir).toBe("/root/exports/site/ts");
    expect(res.pages).toEqual(["index.html", "pricing.html"]);
    expect(res.counts).toEqual({
      pages: 2,
      css: 1,
      js: 1,
      json: 1,
      fonts: 1,
      assets: 1,
    });
    expect(res.projectJson).toBe("project.json");
    expect(res.artifacts).toBeUndefined();

    const verbose = (await dispatchTool(
      relay,
      "swebsy_export",
      { verbose: true },
      artifacts
    )) as any;
    expect(verbose.artifacts).toHaveLength(files.length);
  });

  it("leaves non-artifact results untouched (no resolver call)", async () => {
    const { relay } = fakeRelay();
    let called = false;
    const artifacts = {
      result: async () => {
        called = true;
        return "/never";
      },
    };
    const res = await dispatchTool(relay, "swebsy_add_section", {}, artifacts);
    expect(res).toEqual({ relayed: "add_section" });
    expect(called).toBe(false);
  });

  it("status without a tab returns the relay view + tool list, no round-trip", async () => {
    const { relay, calls } = fakeRelay({
      status: () => ({
        connected: false,
        busy: false,
        settlingTimeout: false,
        port: 37373,
      }),
    });
    const res = (await dispatchTool(relay, "swebsy_status", {})) as any;
    expect(res.connected).toBe(false);
    expect(res.tab).toBeNull();
    expect(res.tools).toContain("swebsy_add_section");
    expect(calls).toHaveLength(0);
  });

  it("status with a connected tab merges the tab's view", async () => {
    const { relay } = fakeRelay({
      status: () => ({
        connected: true,
        busy: false,
        settlingTimeout: false,
        port: 37373,
      }),
      sendCommand: async () => ({
        siteId: "s1",
        siteName: "Internal name",
        editorReady: true,
        title: "My Site",
      }),
    });
    const res = (await dispatchTool(relay, "swebsy_status", {})) as any;
    expect(res.connected).toBe(true);
    expect(res.tab).toEqual({
      siteId: "s1",
      siteName: "Internal name",
      editorReady: true,
      title: "My Site",
    });
  });

  it("status while busy stays local so it cannot block behind a command", async () => {
    const { relay, calls } = fakeRelay({
      status: () => ({
        connected: true,
        busy: true,
        settlingTimeout: true,
        port: 37373,
      }),
    });
    const res = (await dispatchTool(relay, "swebsy_status", {})) as any;
    expect(res.busy).toBe(true);
    expect(res.settlingTimeout).toBe(true);
    expect(res.tab).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("upload_asset", () => {
  const tmp = mkdtempSync(join(tmpdir(), "swebsy-upload-"));
  const png = join(tmp, "shot.png");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));

  it("reads the file and relays filename, mime, and base64 bytes", async () => {
    const { relay, calls } = fakeRelay();
    await dispatchTool(relay, "swebsy_upload_asset", { path: png });
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("upload_asset");
    expect(calls[0].args).toEqual({
      filename: "shot.png",
      mimeType: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString(
        "base64"
      ),
    });
    // long-running: must not use the 30s default
    expect(calls[0].timeout).toBe(120_000);
  });

  it("honors an explicit display filename", async () => {
    const { relay, calls } = fakeRelay();
    await dispatchTool(relay, "swebsy_upload_asset", {
      path: png,
      filename: "  Hero mockup  ",
    });
    expect((calls[0].args as { filename: string }).filename).toBe(
      "Hero mockup.png" // extension appended so the exporter emits a sane file
    );
  });

  it("does not double up an extension the caller already supplied", async () => {
    const { relay, calls } = fakeRelay();
    await dispatchTool(relay, "swebsy_upload_asset", {
      path: png,
      filename: "hero.PNG",
    });
    expect((calls[0].args as { filename: string }).filename).toBe("hero.PNG");
  });

  it("rejects a relative path rather than resolving it against some cwd", async () => {
    const { relay, calls } = fakeRelay();
    await expect(
      dispatchTool(relay, "swebsy_upload_asset", { path: "shot.png" })
    ).rejects.toThrow(/absolute path/i);
    expect(calls).toHaveLength(0);
  });

  it("relays SVG — the tab sanitizes it on the way into storage", async () => {
    const logo = join(tmp, "logo.svg");
    const markup = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h9v9H0z"/></svg>`;
    writeFileSync(logo, markup);
    const { relay, calls } = fakeRelay();
    await dispatchTool(relay, "swebsy_upload_asset", { path: logo });
    expect(calls[0].args).toEqual({
      filename: "logo.svg",
      mimeType: "image/svg+xml",
      data: Buffer.from(markup).toString("base64"),
    });
  });

  it("rejects a file type outside the allowed image set", async () => {
    const evil = join(tmp, "payload.html");
    writeFileSync(evil, "<script>alert(1)</script>");
    const { relay, calls } = fakeRelay();
    await expect(
      dispatchTool(relay, "swebsy_upload_asset", { path: evil })
    ).rejects.toThrow(/Unsupported image type/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing file with the path in the message", async () => {
    const { relay } = fakeRelay();
    await expect(
      dispatchTool(relay, "swebsy_upload_asset", {
        path: join(tmp, "nope.png"),
      })
    ).rejects.toThrow(/Cannot read/i);
  });

  it("rejects a file over the 10 MB frame budget", async () => {
    const big = join(tmp, "big.png");
    writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
    const { relay, calls } = fakeRelay();
    await expect(
      dispatchTool(relay, "swebsy_upload_asset", { path: big })
    ).rejects.toThrow(/limit is 10 MB/i);
    expect(calls).toHaveLength(0);
  });
});

describe("automatic recovery when no tab is attached", () => {
  const NEW_BROKER = new Set(["pair_reuse", "cancel", "deadline"]);
  const off = { busy: false, settlingTimeout: false, port: 37373 };

  /** A relay whose tab attaches after `attachAfter` status polls. */
  function recoveringRelay(attachAfter: number, features = NEW_BROKER) {
    let polls = 0;
    const pairings: unknown[] = [];
    const sent: Array<{ tool: string; opts?: any }> = [];
    const relay: RelayApi = {
      features: () => features,
      startPairing: (opts) => {
        pairings.push(opts);
        return { code: "c0de", port: 37373, fresh: true };
      },
      status: () => ({ ...off, connected: polls++ >= attachAfter }),
      sendCommand: async (tool, _args, _timeout, opts) => {
        sent.push({ tool, opts });
        return { ok: tool };
      },
    };
    return { relay, pairings, sent };
  }

  it("opens Studio with a reusable code, waits for the tab, then dispatches", async () => {
    const { relay, pairings, sent } = recoveringRelay(2);
    const before = Date.now();
    await expect(
      dispatchTool(relay, "swebsy_add_section", {}, undefined, {
        recoveryBudgetMs: 5_000,
      })
    ).resolves.toEqual({ ok: "add_section" });
    expect(pairings).toEqual([{ reuse: true }]);
    // Queue wait ends 25s after the call started; with 30s to run, a normal
    // tool stays under Codex's 60s default.
    const deadline = sent[0].opts.queueDeadline;
    expect(deadline - before).toBeGreaterThanOrEqual(25_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(25_000);
  });

  it("fails with the one next step, never dispatching late, past the budget", async () => {
    const { relay, sent } = recoveringRelay(Infinity);
    const err = (await dispatchTool(
      relay,
      "swebsy_add_section",
      {},
      undefined,
      { recoveryBudgetMs: 600 }
    ).catch((e: BridgeError) => e)) as BridgeError;
    expect(err).toMatchObject({ code: "not_connected" });
    expect(err.message).toContain("click the Swebsy tab");
    expect(err.message).toContain("swebsy_auto=1&swebsy_pair=c0de");
    expect(sent).toHaveLength(0);
  });

  it("stops at once, sending nothing, when the call is cancelled mid-recovery", async () => {
    const { relay, sent } = recoveringRelay(Infinity);
    const cancel = new AbortController();
    const call = dispatchTool(relay, "swebsy_add_section", {}, undefined, {
      signal: cancel.signal,
      recoveryBudgetMs: 20_000,
    });
    setTimeout(() => cancel.abort(), 50);
    await expect(call).rejects.toMatchObject({ code: "cancelled" });
    expect(sent).toHaveLength(0);
  });

  it("does not auto-pair through an old broker (it would mint a code per call)", async () => {
    const { relay, pairings, sent } = recoveringRelay(Infinity, new Set());
    await expect(
      dispatchTool(relay, "swebsy_add_section", {})
    ).rejects.toMatchObject({
      code: "not_connected",
      message: expect.stringContaining("swebsy_start_pairing"),
    });
    expect(pairings).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("passes the caller's cancel signal through to the command", async () => {
    const { relay, sent } = recoveringRelay(0);
    const cancel = new AbortController();
    await dispatchTool(relay, "swebsy_add_section", {}, undefined, {
      signal: cancel.signal,
    });
    expect(sent[0].opts.signal).toBe(cancel.signal);
  });

  it("leaves swebsy_start_pairing as the explicit path: always a fresh code", async () => {
    const { relay, pairings } = recoveringRelay(Infinity);
    const res = (await dispatchTool(relay, "swebsy_start_pairing", {})) as any;
    expect(pairings).toEqual([undefined]);
    expect(res.pairUrl).not.toContain("swebsy_auto");
  });
});

describe("swebsy prompt", () => {
  it("walks the agent from pairing to an editor-ready site", () => {
    expect(SWEBSY_PROMPT.name).toBe("swebsy");
    for (const step of [
      "swebsy_status",
      "swebsy_start_pairing",
      "swebsy_get_builder_guide",
      "swebsy_list_sites",
      "swebsy_open_site",
      "editorReady",
    ]) {
      expect(SWEBSY_PROMPT.text).toContain(step);
    }
  });
});
