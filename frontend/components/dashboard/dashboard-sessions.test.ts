import { describe, expect, it } from "bun:test";
import type { HumanAttentionItem } from "@shared/human-attention";
import type { NarratorActivity } from "./dashboard-activity";
import {
	buildDashboardSessions,
	type DashboardNarrator,
	directoryLabel,
	parseSubstatus,
} from "./dashboard-sessions";

function narrator(id: string, extra: Partial<DashboardNarrator> = {}): DashboardNarrator {
	return { id, title: `title-${id}`, status: "idle", lastMessageAt: null, ...extra };
}

function decision(narratorId: string, extra: Partial<HumanAttentionItem> = {}): HumanAttentionItem {
	return {
		id: `permission:${narratorId}:${Math.random()}`,
		kind: "permission",
		source: "permission",
		requestId: "r",
		toolCallId: "t",
		toolName: "Bash",
		narratorId,
		narratorTitle: `owner-${narratorId}`,
		parentNarratorId: null,
		rootNarratorId: null,
		createdAt: "2026-01-01T00:00:00Z",
		blocking: false,
		canAct: true,
		summary: "",
		...extra,
	};
}

function build(
	narrators: DashboardNarrator[],
	attentionItems: HumanAttentionItem[] = [],
	activity: Map<string, NarratorActivity> = new Map(),
) {
	return buildDashboardSessions({ narrators, attentionItems, activity });
}

const ids = (rows: { narratorId: string }[]) => rows.map((row) => row.narratorId);

describe("buildDashboardSessions", () => {
	it("puts a working session with an open decision under attention, not running", () => {
		const groups = build(
			[narrator("a", { status: "working" }), narrator("b", { status: "working" })],
			[decision("a", { blocking: true })],
		);
		expect(ids(groups.attention)).toEqual(["a"]);
		expect(groups.attention[0]?.title).toBe("title-a");
		expect(ids(groups.running)).toEqual(["b"]);
	});

	it("keeps a waiting session without a human decision (reflection) under running", () => {
		const groups = build([
			narrator("r", { status: "waiting", substatus: '["reflecting"]' }),
			narrator("q", { status: "waiting" }),
		]);
		expect(groups.attention).toEqual([]);
		expect(ids(groups.running).sort()).toEqual(["q", "r"]);
		expect(groups.running.find((s) => s.narratorId === "r")?.substatus).toEqual(["reflecting"]);
	});

	it("treats an idle session with background work as running", () => {
		const groups = build([
			narrator("bg", { activeBackgroundWorkCount: 2 }),
			narrator("done", { activeBackgroundWorkCount: 0 }),
		]);
		expect(ids(groups.running)).toEqual(["bg"]);
		expect(ids(groups.recent)).toEqual(["done"]);
	});

	it("attributes subagent decisions to the root session and counts them", () => {
		const groups = build(
			[],
			[
				decision("sub1", { rootNarratorId: "root" }),
				decision("sub2", { rootNarratorId: "root", blocking: true, summary: "rm -rf build" }),
			],
		);
		expect(groups.attention).toHaveLength(1);
		expect(groups.attention[0]).toMatchObject({
			narratorId: "root",
			decision: { count: 2, blocking: true, summary: "rm -rf build" },
		});
	});

	it("orders blocking decisions, then other decisions, then errored, then unread sessions", () => {
		const groups = build(
			[
				narrator("u", { substatus: ["unread"], lastMessageAt: "2026-01-03T00:00:00Z" }),
				narrator("e", { substatus: ["error"], lastMessageAt: "2026-01-02T00:00:00Z" }),
				narrator("d1"),
				narrator("d2"),
			],
			[decision("d1"), decision("d2", { blocking: true })],
		);
		expect(ids(groups.attention)).toEqual(["d2", "d1", "e", "u"]);
		expect(groups.attention[2]?.errored).toBe(true);
		expect(groups.attention[3]?.unread).toBe(true);
	});

	it("puts a finished unread session under attention until it is read", () => {
		const narrators = [
			narrator("u", { substatus: '["unread"]' }),
			narrator("bg", { substatus: ["unread"], activeBackgroundWorkCount: 1 }),
			narrator("read"),
		];
		const groups = build(narrators);
		expect(ids(groups.attention)).toEqual(["u"]);
		expect(ids(groups.running)).toEqual(["bg"]);
		expect(ids(groups.recent)).toEqual(["read"]);

		const live = new Map([["u", { tools: [], substatus: [] }]]);
		const afterRead = build(narrators, [], live);
		expect(afterRead.attention).toEqual([]);
		expect(ids(afterRead.recent).sort()).toEqual(["read", "u"]);
	});

	it("lets live activity move a session between groups", () => {
		const narrators = [narrator("x", { status: "working" })];
		expect(ids(build(narrators).running)).toEqual(["x"]);
		const live = new Map([["x", { tools: [], status: "idle", substatus: [] }]]);
		const groups = build(narrators, [], live);
		expect(groups.running).toEqual([]);
		expect(ids(groups.recent)).toEqual(["x"]);
	});
});

describe("parseSubstatus", () => {
	it("accepts arrays and JSON strings", () => {
		expect(parseSubstatus(["a", 1])).toEqual(["a"]);
		expect(parseSubstatus('["reasoning"]')).toEqual(["reasoning"]);
		expect(parseSubstatus("not json")).toEqual([]);
	});
});

describe("directoryLabel", () => {
	it("returns the last path segment", () => {
		expect(directoryLabel("/home/me/repo/")).toBe("repo");
		expect(directoryLabel("C:\\work\\app")).toBe("app");
		expect(directoryLabel("/")).toBe("/");
	});
});
