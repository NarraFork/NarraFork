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
const hardInterrupts: string[] = [];
const closed: string[] = [];

const realModules: Record<string, unknown> = {};
let interruptAndArchiveSubagent: typeof import("../subagent-lifecycle").interruptAndArchiveSubagent;
let archiveRetiredSubagents: typeof import("../subagent-lifecycle").archiveRetiredSubagents;

beforeAll(async () => {
	realModules.narratorService = await import("../narrator-service");
	realModules.narratorSession = await import("../narrator-session");
	realModules.subagentRunner = await import("../subagent-runner");
	realModules.narratorSubagent = await import("../narrator-subagent");

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
	mock.module("../narrator-subagent", () => ({
		interruptForegroundSubagent(id: string, options?: { hard?: boolean }) {
			if (options?.hard) hardInterrupts.push(id);
			return true;
		},
	}));

	({ interruptAndArchiveSubagent, archiveRetiredSubagents } = await import(
		"../subagent-lifecycle"
	));
});

afterAll(() => {
	mock.module("../narrator-service", () => realModules.narratorService as never);
	mock.module("../narrator-session", () => realModules.narratorSession as never);
	mock.module("../subagent-runner", () => realModules.subagentRunner as never);
	mock.module("../narrator-subagent", () => realModules.narratorSubagent as never);
	mock.restore();
});

function seed() {
	narrators.clear();
	statusUpdates.length = 0;
	cancelled.length = 0;
	hardInterrupts.length = 0;
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
		expect(cancelled).toEqual(["sub-1"]);
		expect(hardInterrupts).toEqual(["sub-1"]);
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

	test("refuses primary narrators and unknown ids without status writes", async () => {
		seed();
		const primary = await interruptAndArchiveSubagent("primary");
		expect(primary.ok).toBe(false);
		expect(primary.error).toBe("not_subagent");
		const missing = await interruptAndArchiveSubagent("nope");
		expect(missing.ok).toBe(false);
		expect(missing.error).toBe("not_found");
		expect(statusUpdates).toEqual([]);
	});

	test("enforces parentNarratorId when provided", async () => {
		seed();
		const foreign = await interruptAndArchiveSubagent("sub-1", { parentNarratorId: "other" });
		expect(foreign.ok).toBe(false);
		expect(foreign.error).toBe("not_direct_child");
		expect(narrators.get("sub-1")?.status).toBe("working");
	});
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
