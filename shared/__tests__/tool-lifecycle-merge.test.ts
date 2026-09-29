/**
 * tool-lifecycle-merge.test.ts — a late snapshot must not erase a finished tool.
 *
 * The defect this pins: `message` upserts / catch-up merges used to replace a
 * live-patched `success` with a stale `running`, so the spinner stayed on the
 * previous call until the next structural reload — "status lags by one tool call".
 */

import { describe, expect, it } from "bun:test";
import { isLiveToolStatusRegression, mergeToolLifecycleRecord } from "../tool-row-status";

describe("isLiveToolStatusRegression", () => {
	it("treats terminal → in-flight as a regression", () => {
		expect(isLiveToolStatusRegression("success", "running")).toBe(true);
		expect(isLiveToolStatusRegression("failed", "initializing")).toBe(true);
		expect(isLiveToolStatusRegression("success", "pending")).toBe(true);
	});

	it("allows forward transitions and unknown statuses", () => {
		expect(isLiveToolStatusRegression("running", "success")).toBe(false);
		expect(isLiveToolStatusRegression("initializing", "running")).toBe(false);
		expect(isLiveToolStatusRegression("success", "somethingNew")).toBe(false);
		expect(isLiveToolStatusRegression(undefined, "running")).toBe(false);
	});

	it("treats pending → initializing as a regression (the gate never moves back)", () => {
		// A partial-message broadcast that read the row before the permission gate wrote
		// `pending` must not put an awaiting row back to "setting up".
		expect(isLiveToolStatusRegression("pending", "initializing")).toBe(true);
		expect(isLiveToolStatusRegression("initializing", "pending")).toBe(false);
		expect(isLiveToolStatusRegression("pending", "running")).toBe(false);
	});
});

describe("mergeToolLifecycleRecord — the permission gate", () => {
	it("keeps pending when a stale initializing snapshot of the same attempt arrives", () => {
		const merged = mergeToolLifecycleRecord(
			{ status: "pending", executionAttempt: 1, permissionStartedAt: 10 },
			{ status: "initializing", executionAttempt: 1 },
		);
		expect(merged.status).toBe("pending");
	});

	it("still admits a NEW attempt that starts over at initializing", () => {
		// allow-retry inserts attempt 2 at `initializing`; that is the present state.
		const merged = mergeToolLifecycleRecord(
			{ status: "pending", executionAttempt: 1 },
			{ status: "initializing", executionAttempt: 2 },
		);
		expect(merged.status).toBe("initializing");
	});
});

describe("mergeToolLifecycleRecord", () => {
	it("keeps a live-patched success when a stale running snapshot arrives", () => {
		const previous = {
			status: "success",
			durationMs: 15_000,
			outputJson: [{ type: "text", text: "ok" }],
			completedAt: 100,
		};
		const incoming = {
			status: "running",
			toolName: "Edit",
			inputJson: { file_path: "a.css" },
		};
		const merged = mergeToolLifecycleRecord(previous, incoming);
		expect(merged.status).toBe("success");
		expect(merged.durationMs).toBe(15_000);
		expect(merged.outputJson).toEqual(previous.outputJson);
		expect(merged.completedAt).toBe(100);
		// Non-lifecycle snapshot fields still land.
		expect(merged.toolName).toBe("Edit");
	});

	it("accepts a forward completion and fills missing stamps from previous", () => {
		const previous = { status: "running", startedAt: 50, toolName: "Edit" };
		const incoming = { status: "success", durationMs: 3, toolName: "Edit" };
		const merged = mergeToolLifecycleRecord(previous, incoming);
		expect(merged.status).toBe("success");
		expect(merged.durationMs).toBe(3);
		expect(merged.startedAt).toBe(50);
	});

	it("keeps previous status when incoming omits it", () => {
		const merged = mergeToolLifecycleRecord(
			{ status: "success", durationMs: 8 },
			{ toolName: "Edit" },
		);
		expect(merged.status).toBe("success");
		expect(merged.durationMs).toBe(8);
	});
});

/**
 * allow-retry inserts a NEW `narrator_tool_calls` row: higher `executionAttempt`,
 * `status: "initializing"`, every result column cleared. Projected onto the same
 * `tool_use` block it looks like `fail → initializing`, i.e. a regression — so the
 * guard used to keep the old failure and its output, and the user saw nothing
 * happen after asking to retry.
 */
describe("mergeToolLifecycleRecord — a retry is not a regression", () => {
	const failedAttempt = {
		status: "fail",
		executionAttempt: 1,
		durationMs: 1200,
		outputJson: "denied by user",
		errorMessage: "Permission denied",
		permissionDenyMessage: "not this time",
		completedAt: 500,
	};

	it("adopts a newer attempt's cleared lifecycle instead of preserving the old failure", () => {
		const retry = {
			status: "initializing",
			executionAttempt: 2,
			toolName: "Bash",
			inputJson: { command: "ls" },
		};
		const merged = mergeToolLifecycleRecord(failedAttempt, retry);
		expect(merged.status).toBe("initializing");
		expect(merged.executionAttempt).toBe(2);
		// The previous attempt's verdict must not bleed into the new one.
		expect(merged.durationMs).toBeUndefined();
		expect(merged.outputJson).toBeUndefined();
		expect(merged.errorMessage).toBeUndefined();
		expect(merged.permissionDenyMessage).toBeUndefined();
		expect(merged.completedAt).toBeUndefined();
	});

	it("still guards a SAME-attempt regression", () => {
		const stale = { status: "running", executionAttempt: 1 };
		const merged = mergeToolLifecycleRecord({ ...failedAttempt, status: "success" }, stale);
		expect(merged.status).toBe("success");
		expect(merged.durationMs).toBe(1200);
	});

	it("does not treat an OLDER attempt as a retry", () => {
		const older = { status: "initializing", executionAttempt: 1 };
		const merged = mergeToolLifecycleRecord({ ...failedAttempt, executionAttempt: 2 }, older);
		expect(merged.status).toBe("fail");
		expect(merged.outputJson).toBe("denied by user");
	});

	it("keeps the regression guard when either side has no attempt number", () => {
		// Live streaming entries and legacy rows carry none; absence is unknown, not 0.
		expect(
			mergeToolLifecycleRecord({ status: "success", durationMs: 4 }, { status: "running" }).status,
		).toBe("success");
		expect(
			mergeToolLifecycleRecord(
				{ status: "success", durationMs: 4 },
				{ status: "running", executionAttempt: 7 },
			).status,
		).toBe("success");
		expect(
			mergeToolLifecycleRecord(
				{ status: "success", durationMs: 4, executionAttempt: 1 },
				{ status: "running" },
			).status,
		).toBe("success");
	});

	it("ignores a non-integer attempt rather than trusting it", () => {
		const merged = mergeToolLifecycleRecord(
			{ status: "fail", executionAttempt: 1, outputJson: "old" },
			{ status: "initializing", executionAttempt: Number.NaN },
		);
		expect(merged.status).toBe("fail");
		expect(merged.outputJson).toBe("old");
	});
});
