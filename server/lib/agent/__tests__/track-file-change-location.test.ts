import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Run actual trackFileChange AND actual recordTeamFileChange in a subprocess.
 * Only the DB membership read, attribution writer and unrelated services are
 * stubbed. No DB is opened, and process-global Bun mocks cannot leak to siblings.
 */
describe("trackFileChange team location forwarding", () => {
	it("forwards backend identity and the real local/remote workspace, including unknown", () => {
		expect(process.env.NARRAFORK_TEST).toBe("1");
		const source = `
			import { mock } from "bun:test";
			import assert from "node:assert/strict";
			const membership = {
				select() { return this; }, from() { return this; }, where() { return this; },
				get() { return { type: "subagent", variant: "subagent:general", parentId: "parent" }; },
			};
			mock.module("@server/db", () => ({ db: membership }));
			mock.module("@server/websocket/narrator-ws", () => ({ broadcastToNarrator() {} }));
			mock.module("@server/lib/event-bus", () => ({ eventBus: { emit() {} } }));
			mock.module("@server/lib/logger", () => ({ logger: { debug() {}, warn() {}, info() {} } }));
			const attributed = [];
			mock.module("@server/services/file-attribution-service", () => ({
				recordAttribution: async (entry) => { attributed.push(entry); },
			}));
			const backend = (kind, deviceId, defaultCwd) => ({
				kind, deviceId, defaultCwd, paths: { identityKey: (path) => path },
			});
			const local = backend("local", "local", "/ignored-local-default");
			mock.module("@server/lib/agent/execution/local-backend", () => ({ localBackend: local }));
			const team = await import("@server/services/subagent-team");
			const calls = [];
			mock.module("@server/services/narrator-subagent", () => ({
				recordTeamFileChange(...args) {
					calls.push(args);
					team.recordTeamFileChange(...args);
				},
			}));
			const { trackFileChange } = await import("@server/lib/agent/tools/track-file-change");
			const { normalizeWorkspacePath } = await import("@server/services/git-workspace");
			const ctx = { narratorId: "child", parentNarratorId: "parent", cwd: "/local-root" };
			const path = "/same/file.ts";
			await trackFileChange({ ...ctx, executionTarget: { cwd: "/stale-target" } }, path, "edit", local);
			await trackFileChange({ ...ctx, executionTarget: { deviceId: "stale", cwd: "/actual" } }, path, "write", backend("remote", "device-a", "/default"));
			await trackFileChange({ ...ctx, executionTarget: { cwd: "/actual" } }, path, "edit", backend("remote", "device-b", "/default"));
			await trackFileChange(ctx, path, "bash", backend("remote", "device-default", "/default"));
			await trackFileChange(ctx, path, "edit", backend("remote", "device-unknown", undefined));
			await trackFileChange({ ...ctx, executionTarget: { cwd: null } }, path, "edit", backend("remote", "device-null", null));
			await trackFileChange({ ...ctx, executionTarget: { cwd: "/other" } }, path, "edit", backend("remote", "device-a", "/default"));
			const expected = [
				{ deviceId: "local", workspacePath: "/local-root" },
				{ deviceId: "device-a", workspacePath: "/actual" },
				{ deviceId: "device-b", workspacePath: "/actual" },
				{ deviceId: "device-default", workspacePath: "/default" },
				{ deviceId: "device-unknown", workspacePath: null },
				{ deviceId: "device-null", workspacePath: null },
				{ deviceId: "device-a", workspacePath: "/other" },
			];
			assert.deepEqual(calls, expected.map((location) => ["parent", "child", path, location]));
			assert.deepEqual(team.getTeamFileChangeEntries("parent").get("child"), expected.map((location) => ({
				...location,
				workspacePath: location.deviceId === "local" ? normalizeWorkspacePath(location.workspacePath) : location.workspacePath,
				filePath: path,
				attributionScope: "legacy_unscoped",
			})));
			// Missing parent is still a no-op for team tracking, not for attribution.
			await trackFileChange({ ...ctx, parentNarratorId: undefined }, path, "edit", local);
			assert.equal(calls.length, expected.length);
			assert.equal(attributed.length, expected.length + 1);
			console.log("isolated team location forwarding passed");
		`;
		const result = spawnSync(process.execPath, ["--eval", source], {
			cwd: resolve(import.meta.dir, "../../../.."),
			env: { ...process.env },
			encoding: "utf8",
			timeout: 20_000,
			maxBuffer: 64 * 1024,
		});
		expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({
			status: 0,
			error: undefined,
			stderr: "",
		});
		expect(result.stdout).toContain("isolated team location forwarding passed");
	});
});
