import { describe, expect, it } from "bun:test";
import type { PendingPermission } from "../narrator-panel-types";
import { findPendingForKey, toolUseIdFromSpecKey } from "./vlist-permission-match";

const perm = (overrides: Partial<PendingPermission>): PendingPermission => ({
	id: overrides.id ?? "req-1",
	toolName: overrides.toolName ?? "Bash",
	toolUseId: overrides.toolUseId,
	inputJson: overrides.inputJson ?? {},
	...overrides,
});

describe("toolUseIdFromSpecKey", () => {
	it("extracts the tool use id from a tool- key", () => {
		expect(toolUseIdFromSpecKey("tool-abc123")).toBe("abc123");
	});

	it("strips the dedup #dupN suffix", () => {
		expect(toolUseIdFromSpecKey("tool-abc123#dup1")).toBe("abc123");
	});

	it("returns null for non-tool keys", () => {
		expect(toolUseIdFromSpecKey("msg-xyz")).toBeNull();
		expect(toolUseIdFromSpecKey("activity-foo-0")).toBeNull();
	});

	it("returns null for an empty tool id", () => {
		expect(toolUseIdFromSpecKey("tool-")).toBeNull();
	});
});

describe("findPendingForKey", () => {
	const pendings = [
		perm({ id: "r1", toolUseId: "tu-1", toolName: "Bash" }),
		perm({ id: "r2", toolUseId: "tu-2", toolName: "ExitPlanMode" }),
	];

	it("matches the pending permission by tool use id", () => {
		expect(findPendingForKey("tool-tu-2", pendings)?.id).toBe("r2");
	});

	it("matches through a dedup suffix", () => {
		expect(findPendingForKey("tool-tu-1#dup2", pendings)?.id).toBe("r1");
	});

	it("returns null when no permission matches", () => {
		expect(findPendingForKey("tool-tu-9", pendings)).toBeNull();
	});

	it("returns null for a non-tool key", () => {
		expect(findPendingForKey("msg-abc", pendings)).toBeNull();
	});

	it("returns null against an empty pending list", () => {
		expect(findPendingForKey("tool-tu-1", [])).toBeNull();
	});
});
