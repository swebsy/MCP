import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The MCP registry rejects a server.json whose version doesn't match the npm
// package it points at, and it reads `mcpName` off the published package to
// prove the npm package owns the io.github.swebsy namespace. Both are easy to
// forget on a version bump, and both fail at publish time rather than here —
// so check them here instead.
//
// ponytail: `../` resolves the same in the monorepo (mcp/src -> mcp/) and in the
// public mirror (src/ -> repo root), so this runs in both.
const read = (relative: string) =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

describe("registry manifest", () => {
  const pkg = read("../package.json");
  const server = read("../server.json");

  it("pins the same version as the npm package", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  it("points at the published package under the claimed namespace", () => {
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].registryType).toBe("npm");
    expect(pkg.mcpName).toBe(server.name);
    expect(server.name.startsWith("io.github.swebsy/")).toBe(true);
  });
});
