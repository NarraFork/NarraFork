import { describe, expect, it } from "bun:test";
import type { PendingPermission } from "../narrator-panel-types";
import {
	decidePermissionSlot,
	findPendingForKey,
	isPermissionHostRow,
	toolUseIdFromSpecKey,
} from "./vlist-permission-match";
import type { VListReflectionSource } from "./vlist-reflection-index";

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

describe("decidePermissionSlot", () => {
	const KEY = "tool-tu-1";
	const pending = perm({ id: "req-1", toolUseId: "tu-1" });
	const pendings = [pending];

	/** A reflection index holding one `tu-1` entry at the given status. */
	function reflections(status: string, extra: Partial<VListReflectionSource> = {}) {
		return new Map<string, VListReflectionSource>([
			[
				"tu-1",
				{
					toolName: "Bash",
					suggestions: [{ type: "danger_reflection", status, requestId: "req-1" }],
					...extra,
				},
			],
		]);
	}

	// The precedence table (mirrors ToolCallCard.tsx:5419).
	const TABLE: Array<{
		name: string;
		specKind: string;
		reflectionStatus?: string;
		hasPending: boolean;
		expected: "reflection" | "permission" | "none";
	}> = [
		{ name: "tool-call, nothing", specKind: "tool-call", hasPending: false, expected: "none" },
		{
			name: "tool-call, pending only",
			specKind: "tool-call",
			hasPending: true,
			expected: "permission",
		},
		{
			name: "tool-call, running reflection + pending",
			specKind: "tool-call",
			reflectionStatus: "running",
			hasPending: true,
			expected: "reflection",
		},
		{
			name: "tool-call, awaiting_user + pending",
			specKind: "tool-call",
			reflectionStatus: "awaiting_user",
			hasPending: true,
			expected: "permission",
		},
		{
			name: "tool-call, awaiting_user without pending",
			specKind: "tool-call",
			reflectionStatus: "awaiting_user",
			hasPending: false,
			expected: "none",
		},
		{
			name: "tool-call, confirmed without pending",
			specKind: "tool-call",
			reflectionStatus: "confirmed",
			hasPending: false,
			expected: "reflection",
		},
		{
			name: "tool-call, cancelled without pending",
			specKind: "tool-call",
			reflectionStatus: "cancelled",
			hasPending: false,
			expected: "reflection",
		},
		{
			name: "tool-call, aborted without pending",
			specKind: "tool-call",
			reflectionStatus: "aborted",
			hasPending: false,
			expected: "reflection",
		},
		{
			name: "tool-call, confirmed + pending",
			specKind: "tool-call",
			reflectionStatus: "confirmed",
			hasPending: true,
			expected: "reflection",
		},
		{
			name: "subagent-card, running reflection + pending",
			specKind: "subagent-card",
			reflectionStatus: "running",
			hasPending: true,
			expected: "permission",
		},
		{
			name: "subagent-card, confirmed without pending",
			specKind: "subagent-card",
			reflectionStatus: "confirmed",
			hasPending: false,
			expected: "none",
		},
		{
			name: "markdown row, confirmed + pending",
			specKind: "markdown",
			reflectionStatus: "confirmed",
			hasPending: true,
			expected: "none",
		},
	];

	for (const row of TABLE) {
		it(`${row.name} → ${row.expected}`, () => {
			const decision = decidePermissionSlot(
				row.specKind,
				KEY,
				row.hasPending ? pendings : [],
				row.reflectionStatus ? reflections(row.reflectionStatus) : undefined,
			);
			expect(decision.kind).toBe(row.expected);
			if (row.expected === "reflection") {
				expect(decision.reflection?.kind).toBe("danger_reflection");
				expect(decision.toolUseId).toBe("tu-1");
			}
			if (row.expected === "permission") expect(decision.pending?.id).toBe("req-1");
			if (row.expected === "none") {
				expect(decision.reflection).toBeUndefined();
				expect(decision.pending).toBeUndefined();
			}
		});
	}

	it("renders a historical reflection with no permCb at all", () => {
		// Archived / read-only sessions: no pending list, no callbacks. The notice takes
		// no permission callbacks, so it must still be offered.
		const decision = decidePermissionSlot(
			"tool-call",
			KEY,
			undefined,
			reflections("confirmed", { status: "success" }),
		);
		expect(decision.kind).toBe("reflection");
		expect(decision.pending).toBeUndefined();
	});

	it("carries the pending permission alongside a running reflection", () => {
		const decision = decidePermissionSlot("tool-call", KEY, pendings, reflections("running"));
		expect(decision.kind).toBe("reflection");
		expect(decision.pending?.id).toBe("req-1");
	});

	it("matches a reflection through the dedup #dupN suffix", () => {
		const decision = decidePermissionSlot(
			"tool-call",
			"tool-tu-1#dup2",
			[],
			reflections("confirmed"),
		);
		expect(decision.kind).toBe("reflection");
	});

	it("prefers the live permission's reflection suggestions", () => {
		const livePending = perm({
			id: "req-1",
			toolUseId: "tu-1",
			suggestions: [{ type: "plan_reflection", status: "running", requestId: "req-live" }],
		});
		const decision = decidePermissionSlot(
			"tool-call",
			KEY,
			[livePending],
			reflections("confirmed"),
		);
		expect(decision.kind).toBe("reflection");
		expect(decision.reflection?.kind).toBe("plan_reflection");
		expect(decision.reflection?.status).toBe("running");
	});

	it("downgrades an orphaned active reflection on a failed tool call", () => {
		const decision = decidePermissionSlot(
			"tool-call",
			KEY,
			[],
			reflections("running", { status: "fail", errorMessage: "Narrator aborted" }),
		);
		expect(decision.kind).toBe("reflection");
		expect(decision.reflection?.status).toBe("aborted");
		expect(decision.reflection?.reason).toBe("Narrator aborted");
	});

	it("returns none for a key that encodes no tool use id", () => {
		expect(
			decidePermissionSlot("tool-call", "msg-abc", pendings, reflections("confirmed")).kind,
		).toBe("none");
	});
});

/**
 * The host-kind rule has a second caller now: the bridge offers a row's slot to an
 * open ASYNC question when no permission claimed it, and it derives the tool_use id
 * from the spec key directly. Without re-checking the kind there, a non-hosting row
 * (a user bubble, an injection card) could mount an answer form.
 */
describe("isPermissionHostRow", () => {
	it("accepts exactly the two card kinds that host an interaction area", () => {
		expect(isPermissionHostRow("tool-call")).toBe(true);
		expect(isPermissionHostRow("subagent-card")).toBe(true);
	});

	it("rejects every other row kind", () => {
		for (const kind of ["markdown", "user-bubble", "injection-bubble", "origin_notice", ""]) {
			expect(isPermissionHostRow(kind)).toBe(false);
		}
	});
});
