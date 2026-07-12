import { describe, expect, test } from "bun:test";
import { markRecentlyAttributed, wasRecentlyAttributed } from "./file-attribution-service";

describe("file-attribution recently-attributed shadowing", () => {
	test("marks and detects a path as recently attributed", () => {
		const ws = "/tmp/workspace-a";
		markRecentlyAttributed(ws, ["src/foo.ts"]);
		expect(wasRecentlyAttributed(ws, "src/foo.ts")).toBe(true);
		expect(wasRecentlyAttributed(ws, "src/bar.ts")).toBe(false);
	});

	test("normalizes the workspace key so different path forms match", () => {
		const ws = "/tmp/workspace-b";
		markRecentlyAttributed(`${ws}/`, ["a.ts"]);
		// Trailing slash should normalize to the same key.
		expect(wasRecentlyAttributed(ws, "a.ts")).toBe(true);
	});

	test("isolates paths per workspace", () => {
		markRecentlyAttributed("/tmp/ws-1", ["shared.ts"]);
		expect(wasRecentlyAttributed("/tmp/ws-2", "shared.ts")).toBe(false);
	});

	test("isolates the same workspace and path across devices", () => {
		markRecentlyAttributed("/workspace", ["/workspace/shared.ts"], "remote-a");
		expect(wasRecentlyAttributed("/workspace", "/workspace/shared.ts", "remote-a")).toBe(true);
		expect(wasRecentlyAttributed("/workspace", "/workspace/shared.ts", "local")).toBe(false);
		expect(wasRecentlyAttributed("/workspace", "/workspace/shared.ts", "remote-b")).toBe(false);
	});
});
