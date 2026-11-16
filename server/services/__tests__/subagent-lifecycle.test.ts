import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const narrators = new Map<
	string,
	{
		id: string;
		parentNarratorId: string | null;
		variant: string;
		type: string;
		status: string;
		title: string | null;
	}
>();
const statusUpdates: Array<{ id: string; status: string }> = [];
const cancelled: string[] = [];
const runControls: Array<{ id: string; kind: string }> = [];
const closed: string[] = [];

const realModules: Record<string, unknown> = {};
let interruptAndArchiveSubagent: typeof import("../subagent-lifecycle").interruptAndArchiveSubagent;
let archiveRetiredSubagents: typeof import("../subagent-lifecycle").archiveRetiredSubagents;

beforeAll(async () => {
	realModules.narratorService = await import("../narrator-service");
	realModules.narratorSession = await import("../narrator-session");
	realModules.subagentRunner = await import("../subagent-runner");
	realModules.agentRuntimeRun = await import("../agent-runtime/run");

	mock.module("../narrator-service", () => ({
		narratorService: {
			async getById(id: string) {
				const n = narrators.get(id);
				if (!n) throw new Error("narrator not found");
				return n;
			},
			async updateStatus(id: string, status: string) {
				statusUpdates.push({ id, status });
				const n = narrators.get(id);
				if (n) n.status = status;
			},
		},
	}));
	mock.module("../narrator-session", () => ({
		closeNarrator: (id: string) => {
			closed.push(id);
		},
		isNarratorActive: (id: string) => narrators.get(id)?.status === "working",
	}));
	mock.module("../subagent-runner", () => ({
		cancelBackgroundTask: async (id: string) => {
			cancelled.push(id);
			return true;
		},
	}));
	// Retiring ends the run itself (and any hold) through the one run control.
	mock.module("../agent-runtime/run", () => ({
		controlRun: async (id: string, command: { kind: string }) => {
			runControls.push({ id, kind: command.kind });
			return narrators.get(id)?.status === "working";
		},
		stopSubagentHelpers: async () => 0,
	}));

	({ interruptAndArchiveSubagent, archiveRetiredSubagents } = await import(
		"../subagent-lifecycle"
	));
});

afterAll(() => {
	mock.module("../narrator-service", () => realModules.narratorService as never);
	mock.module("../narrator-session", () => realModules.narratorSession as never);
	mock.module("../subagent-runner", () => realModules.subagentRunner as never);
	mock.module("../agent-runtime/run", () => realModules.agentRuntimeRun as never);
	mock.restore();
});

function seed() {
	narrators.clear();
	statusUpdates.length = 0;
	cancelled.length = 0;
	runControls.length = 0;
	closed.length = 0;
	narrators.set("sub-1", {
		id: "sub-1",
		parentNarratorId: "parent",
		variant: "subagent:general",
		type: "subagent",
		status: "working",
		title: "Worker",
	});
	narrators.set("sub-2", {
		id: "sub-2",
		parentNarratorId: "parent",
		variant: "subagent:explore",
		type: "subagent",
		status: "idle",
		title: "Explorer",
	});
	narrators.set("primary", {
		id: "primary",
		parentNarratorId: null,
		variant: "primary",
		type: "primary",
		status: "working",
		title: "Main",
	});
}

describe("interruptAndArchiveSubagent", () => {
	test("interrupts running work and archives a subagent", async () => {
		seed();
		const result = await interruptAndArchiveSubagent("sub-1");
		expect(result.ok).toBe(true);
		expect(result.archived).toBe(true);
		expect(result.interrupted).toBe(true);
		expect(closed).toEqual(["sub-1"]);
		expect(runControls).toEqual([{ id: "sub-1", kind: "cancel" }]);
		expect(statusUpdates).toEqual([{ id: "sub-1", status: "archived" }]);
		expect(narrators.get("sub-1")?.status).toBe("archived");
	});

	test("is idempotent for already-archived subagents", async () => {
		seed();
		const existing = narrators.get("sub-1");
		if (existing) existing.status = "archived";
		const result = await interruptAndArchiveSubagent("sub-1");
		expect(result.ok).toBe(true);
		expect(result.alreadyArchived).toBe(true);
		expect(result.archived).toBe(false);
		expect(statusUpdates).toEqual([]);
	});

	test("archives an authorized ordinary session through run control; unknown ids write nothing", async () => {
		seed();
		const primary = await interruptAndArchiveSubagent("primary");
		expect(primary.ok).toBe(true);
		expect(primary.archived).toBe(true);
		expect(runControls).toEqual([{ id: "primary", kind: "cancel" }]);
		expect(closed).toEqual(["primary"]);
		expect(statusUpdates).toEqual([{ id: "primary", status: "archived" }]);
		statusUpdates.length = 0;
		const missing = await interruptAndArchiveSubagent("nope");
		expect(missing.ok).toBe(false);
		expect(missing.error).toBe("not_found");
		expect(statusUpdates).toEqual([]);
	});
	// Who may archive is the controller grant (narrator-control.ts), checked by the
	// Agent tool before this mechanism runs; see narrator-unified-runtime-contract.test.ts.
});

describe("archiveRetiredSubagents", () => {
	test("archives each unique subagent once and continues past failures", async () => {
		seed();
		const results = await archiveRetiredSubagents(["sub-1", "sub-1", "missing", "sub-2"]);
		expect(results.map((r) => r.id)).toEqual(["sub-1", "missing", "sub-2"]);
		expect(results[0]?.archived).toBe(true);
		expect(results[1]?.ok).toBe(false);
		expect(results[2]?.archived).toBe(true);
		expect(narrators.get("sub-1")?.status).toBe("archived");
		expect(narrators.get("sub-2")?.status).toBe("archived");
	});
});
