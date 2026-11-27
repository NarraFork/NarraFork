import { beforeAll, describe, expect, it } from "bun:test";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import type { NarratorMsg } from "../narrator-panel-types";
import type { TeamChipLabels, TeamConversationEvent } from "../team-conversation-mode";
import { getSummary } from "../tool-call/tool-display";
import type { MeasuredTeamChip } from "./measure/measure-team-row";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextDocumentLayout } from "./pretext-document-layout";
import { measureElementCached } from "./registry";
import type { AdapterRenderUnit } from "./segment-adapter";
import {
	applyTeamConversationMode,
	chipKeyOf,
	measureRevisionOf,
	mergeTeamEvents,
	parseServerTime,
	teamChipActionKey,
	teamChipKey,
} from "./team-conversation-transform";
import { previewResize } from "./vlist-resize-preview";

beforeAll(() => {
	installCanvasStub();
});

const BASE = Date.parse("2026-11-27T10:00:00.000Z");
const iso = (minute: number) => new Date(BASE + minute * 60_000).toISOString();

const labels: TeamChipLabels = {
	actions: { "work.create": "创建工作项", "work.ready": "标为就绪", checkin: "设定回访" },
	other: "团队操作",
	count: (count) => `×${count}`,
	failed: (count) => `${count} 次失败`,
	cancelled: (count) => `${count} 次取消`,
};

type Msg = { id: string; createdAt: string };
type Item = {
	msg: Msg;
	blockIndex: number;
	tc: { toolName: string; toolUseId: string; inputJson: unknown; status: string };
};

const msg = (id: string, minute: number): Msg => ({ id, createdAt: iso(minute) });
const teamItem = (m: Msg, id: string, action: unknown, status = "success"): Item => ({
	msg: m,
	blockIndex: 0,
	tc: {
		toolName: "Team",
		toolUseId: id,
		inputJson: typeof action === "string" ? { action } : action,
		status,
	},
});
const otherItem = (m: Msg, id: string, status = "success"): Item => ({
	msg: m,
	blockIndex: 0,
	tc: { toolName: "Bash", toolUseId: id, inputJson: { command: "ls" }, status },
});
const textUnit = (m: Msg): AdapterRenderUnit => ({
	kind: "segment",
	seg: { kind: "message", msg: m } as never,
});
const runUnit = (items: Item[]): AdapterRenderUnit => ({
	kind: "segment",
	seg: {
		kind: "tool-run",
		items,
		sourceMessages: [...new Set(items.map((item) => item.msg))],
	} as never,
});

function shape(units: readonly AdapterRenderUnit[]): string[] {
	return units.map((unit) => {
		if (unit.kind === "element") {
			const data = unit.spec.data as { label?: string; countLabel?: string; text?: string };
			return unit.spec.kind === "team-chip"
				? `chip:${data.label}${data.countLabel}`
				: `event:${data.text}`;
		}
		if (unit.kind === "activity") return "activity";
		const seg = unit.seg as unknown as { kind: string; msg?: Msg; items?: Item[] };
		return seg.kind === "message"
			? `text:${seg.msg?.id}`
			: `run:${seg.items?.map((item) => item.tc.toolUseId).join(",")}`;
	});
}

const chips = (
	units: readonly AdapterRenderUnit[],
	ctx: Parameters<typeof applyTeamConversationMode>[2] = { lod: 4 },
) => applyTeamConversationMode(units, { events: [], chipLabels: labels, revision: "r" }, ctx);

describe("Team call chips", () => {
	it("folds consecutive calls of one action into one chip, keyed on its last call", () => {
		const m = [msg("m1", 1), msg("m2", 2), msg("m3", 3)];
		const units = [
			textUnit(msg("t0", 0)),
			runUnit([
				teamItem(m[0] as Msg, "a", "work.create"),
				teamItem(m[1] as Msg, "b", "work.create"),
				teamItem(m[2] as Msg, "c", "work.create"),
			]),
		];
		const result = chips(units);
		expect(shape(result.units)).toEqual(["text:t0", "chip:创建工作项 ×3"]);
		const chip = result.units[1] as Extract<AdapterRenderUnit, { kind: "element" }>;
		expect(chip.spec.key).toBe(teamChipKey("c"));
		expect(chip.spec.opts).toEqual({ expanded: false });
		expect(result.sources.get(chip.spec.key)?.map((source) => source.id)).toEqual([
			"m1",
			"m2",
			"m3",
		]);
	});

	it("a single settled call is a chip without a count", () => {
		const result = chips([
			runUnit([teamItem(msg("m1", 1), "a", { action: "checkin", minutes: 30 })]),
		]);
		expect(shape(result.units)).toEqual(["chip:设定回访"]);
	});

	it("a different action, another tool or a text message ends the group", () => {
		const m = msg("m", 1);
		const units = [
			runUnit([
				teamItem(m, "a", "work.create"),
				teamItem(m, "b", "work.create"),
				teamItem(m, "c", "work.ready"),
				otherItem(m, "d"),
				teamItem(m, "e", "work.ready"),
			]),
			textUnit(msg("t", 2)),
			runUnit([teamItem(msg("m3", 3), "f", "work.ready")]),
		];
		expect(shape(chips(units).units)).toEqual([
			"chip:创建工作项 ×2",
			"chip:标为就绪",
			"run:d",
			"chip:标为就绪",
			"text:t",
			"chip:标为就绪",
		]);
	});

	it("groups across adjacent tool-run units", () => {
		const units = [
			runUnit([teamItem(msg("m1", 1), "a", "work.create")]),
			runUnit([teamItem(msg("m2", 2), "b", "work.create")]),
		];
		expect(shape(chips(units).units)).toEqual(["chip:创建工作项 ×2"]);
	});

	it("never folds a running, streaming or permission-blocked call: it keeps its card", () => {
		const m = msg("m", 1);
		const streaming = { id: "__streaming__", createdAt: iso(2) };
		const units = [
			runUnit([
				teamItem(m, "a", "work.create"),
				teamItem(m, "b", "work.create", "running"),
				teamItem(m, "c", "work.create"),
				teamItem(m, "p", "cleanup"),
				teamItem(m, "d", "work.create"),
				teamItem(streaming, "s", "work.create"),
			]),
		];
		const result = chips(units, { lod: 4, hasPendingPermission: (id) => id === "p" });
		expect(shape(result.units)).toEqual([
			"chip:创建工作项",
			"run:b",
			"chip:创建工作项",
			"run:p",
			"chip:创建工作项",
			"run:s",
		]);
		expect(chipKeyOf(teamItem(m, "p", "cleanup"), { hasPendingPermission: () => true })).toBeNull();
	});

	it("marks failures on the chip, still in the group", () => {
		const m = msg("m", 1);
		const result = chips([
			runUnit([teamItem(m, "a", "work.ready"), teamItem(m, "b", "work.ready", "fail")]),
		]);
		const chip = result.units[0] as Extract<AdapterRenderUnit, { kind: "element" }>;
		expect(chip.spec.data).toMatchObject({
			label: "标为就绪",
			count: 2,
			failed: 1,
			failedLabel: "1 次失败",
			status: "fail",
		});
	});

	it("folds every finished outcome with its mark; cancelled never reads as success", () => {
		const m = msg("m", 1);
		const result = chips([
			runUnit([
				teamItem(m, "a", "work.ready", "timeout"),
				teamItem(m, "b", "work.ready", "denied"),
				teamItem(m, "c", "work.ready", "aborted"),
				teamItem(m, "d", "work.ready", "failed"),
				teamItem(m, "e", "work.ready", "success"),
			]),
			textUnit(msg("t", 2)),
			runUnit([teamItem(msg("m2", 3), "f", "work.ready", "canceled")]),
			textUnit(msg("t2", 4)),
			runUnit([teamItem(msg("m3", 5), "g", "work.ready", "mystery")]),
		]);
		const [mixed, , cancelledOnly, , unknown] = result.units as Extract<
			AdapterRenderUnit,
			{ kind: "element" }
		>[];
		expect(mixed?.spec.data).toMatchObject({ count: 5, failed: 2, cancelled: 2, status: "fail" });
		expect(cancelledOnly?.spec.data).toMatchObject({
			count: 1,
			cancelled: 1,
			cancelledLabel: "1 次取消",
			status: "cancelled",
		});
		// A status nobody has interpreted keeps its card.
		expect(shape([unknown as AdapterRenderUnit])).toEqual(["run:g"]);
	});

	it("keeps an open chip open as members join or leave, and folds it from any key", () => {
		const run = (ids: string[]) =>
			runUnit(ids.map((id, index) => teamItem(msg(`m${id}`, index), id, "work.create")));
		const state = new Map<string, boolean>();
		const ctx = { lod: 4, isExpanded: (key: string) => state.get(key) };
		const first = chips([run(["b", "c"])], ctx).units[0] as Extract<
			AdapterRenderUnit,
			{ kind: "element" }
		>;
		expect(first.spec.key).toBe(teamChipKey("c"));
		state.set(first.spec.key, true);
		// An older page prepends a member, a live call appends one, the head is trimmed.
		for (const ids of [
			["a", "b", "c"],
			["a", "b", "c", "d"],
			["c", "d"],
		]) {
			const units = chips([run(ids)], ctx).units;
			const chip = units[0] as Extract<AdapterRenderUnit, { kind: "element" }>;
			expect(chip.spec.key).toBe(teamChipKey("c"));
			expect(chip.spec.opts).toEqual({ expanded: true });
			expect(shape(units).slice(1)).toEqual([`run:${ids.join(",")}`]);
		}
		// The shell folds it under the key it now has: closed, though another member said open.
		state.set(teamChipKey("d"), true);
		state.set(teamChipKey("c"), true);
		const reopened = chips([run(["c", "d"])], ctx).units[0] as Extract<
			AdapterRenderUnit,
			{ kind: "element" }
		>;
		expect(reopened.spec.key).toBe(teamChipKey("d"));
		state.set(teamChipKey("d"), false);
		const folded = chips([run(["c", "d"])], ctx).units;
		expect((folded[0] as Extract<AdapterRenderUnit, { kind: "element" }>).spec.opts).toEqual({
			expanded: false,
		});
		expect(folded).toHaveLength(1);
	});

	it("a retried call id gets its own chip key and its own sources", () => {
		const first = teamItem(msg("m1", 1), "same", "work.create");
		const retry = teamItem(msg("m2", 3), "same", "work.create");
		const result = chips([runUnit([first]), textUnit(msg("t", 2)), runUnit([retry])]);
		const keys = result.units
			.filter(
				(unit): unit is Extract<AdapterRenderUnit, { kind: "element" }> => unit.kind === "element",
			)
			.map((unit) => unit.spec.key);
		expect(keys).toEqual([teamChipKey("same"), teamChipKey("same#1")]);
		expect(result.sources.get(teamChipKey("same"))?.map((m) => m.id)).toEqual(["m1"]);
		expect(result.sources.get(teamChipKey("same#1"))?.map((m) => m.id)).toEqual(["m2"]);
	});

	it("expanded, the chip is followed by exactly the calls it folds", () => {
		const m = msg("m", 1);
		const items = [
			teamItem(m, "a", "work.create"),
			teamItem(m, "b", "work.create"),
			otherItem(m, "c"),
		];
		const result = chips([runUnit(items)], {
			lod: 4,
			isExpanded: (key) => (key === teamChipKey("a") ? true : undefined),
		});
		expect(shape(result.units)).toEqual(["chip:创建工作项 ×2", "run:a,b", "run:c"]);
		const chip = result.units[0] as Extract<AdapterRenderUnit, { kind: "element" }>;
		expect(chip.spec.opts).toEqual({ expanded: true });
	});

	it("leaves an untouched tool-run as the very same unit, and does nothing at L1/L2", () => {
		const plain = runUnit([otherItem(msg("m", 1), "x")]);
		expect(chips([plain]).units[0]).toBe(plain);
		const team = runUnit([teamItem(msg("m", 1), "a", "work.create")]);
		expect(chips([team], { lod: 2 }).units).toEqual([team]);
	});

	it("reads the action from a truncated input, and splits brief into read and write", () => {
		expect(
			teamChipActionKey({ _truncated: true, preview: '{"action":"work.review","item":"x"' }),
		).toBe("work.review");
		expect(teamChipActionKey({ action: "brief" })).toBe("brief.read");
		expect(teamChipActionKey({ action: "brief", text: "new" })).toBe("brief.write");
		expect(teamChipActionKey({})).toBeNull();
		expect(teamChipActionKey(null)).toBeNull();
	});
});

const ev = (id: string, minute: number): TeamConversationEvent => ({
	id,
	at: BASE + minute * 60_000,
	text: `E${id}`,
	tone: "ok",
});

describe("team event dividers", () => {
	const units = () => [textUnit(msg("a", 0)), textUnit(msg("b", 10)), textUnit(msg("c", 20))];

	it("places each event before the first unit that started after it; a tie stays after", () => {
		const sources = new Map();
		const out = mergeTeamEvents(
			units(),
			[ev("1", 5), ev("2", 10), ev("3", 10), ev("4", 25)],
			false,
			sources,
		);
		expect(shape(out)).toEqual([
			"text:a",
			"event:E1",
			"text:b",
			"event:E2",
			"event:E3",
			"text:c",
			"event:E4",
		]);
		// A divider is owned by the unit before it, so source seqs stay monotone.
		expect(sources.get("team-event-1").map((m: Msg) => m.id)).toEqual(["a"]);
		expect(sources.get("team-event-4").map((m: Msg) => m.id)).toEqual(["c"]);
	});

	it("with older history unloaded, an event before the first message waits for its page", () => {
		const early = [ev("0", -5), ev("1", 5)];
		expect(shape(mergeTeamEvents(units(), early, true, new Map()))).toEqual([
			"text:a",
			"event:E1",
			"text:b",
			"text:c",
		]);
		// The older page arrives: the same event now has its place.
		const older = [textUnit(msg("z", -10)), ...units()];
		expect(shape(mergeTeamEvents(older, early, false, new Map())).slice(0, 3)).toEqual([
			"text:z",
			"event:E0",
			"text:a",
		]);
	});

	it("a timeless unit mid-list carries the previous time; only a trailing one is +∞", () => {
		const timeless = textUnit({ id: "x", createdAt: "" });
		const out = mergeTeamEvents(
			[textUnit(msg("a", 0)), timeless, textUnit(msg("b", 10))],
			[ev("1", 5), ev("2", 15)],
			false,
			new Map(),
		);
		// Event 1 (minute 5) is after `a` and the timeless row that follows it, before `b`.
		expect(shape(out)).toEqual(["text:a", "text:x", "event:E1", "text:b", "event:E2"]);
		// With older history unloaded, a leading timeless row takes the first known time.
		expect(
			shape(mergeTeamEvents([timeless, textUnit(msg("a", 10))], [ev("0", 5)], true, new Map())),
		).toEqual(["text:x", "text:a"]);
	});

	it("a unit without a time lets earlier events pass before it", () => {
		const live = textUnit({ id: "__streaming__", createdAt: "" });
		expect(
			shape(mergeTeamEvents([textUnit(msg("a", 0)), live], [ev("1", 3)], false, new Map())),
		).toEqual(["text:a", "event:E1", "text:__streaming__"]);
	});

	it("dividers apply at every level and after chips", () => {
		const out = applyTeamConversationMode(
			[textUnit(msg("a", 0)), runUnit([teamItem(msg("m", 5), "x", "work.create")])],
			{ events: [ev("1", 3)], chipLabels: labels, revision: "r", hasPrev: false },
			{ lod: 1 },
		);
		expect(shape(out.units)).toEqual(["text:a", "event:E1", "run:x"]);
	});

	it("parses ISO and SQLite times", () => {
		expect(parseServerTime("2026-11-27 10:00:00")).toBe(BASE);
		expect(parseServerTime(iso(0))).toBe(BASE);
		expect(parseServerTime("")).toBeNaN();
	});
});

// ── Through the real document build ──────────────────────────────────────────

function textMessage(id: string, seq: number, minute: number, text: string): NarratorMsg {
	return rowWithElements(
		{
			id,
			narratorId: "n1",
			seq,
			role: "assistant",
			contentText: text,
			toolCalls: [],
			parentToolUseId: null,
			createdAt: iso(minute),
		},
		[{ type: "text", text }],
	) as unknown as NarratorMsg;
}

function teamMessage(
	id: string,
	seq: number,
	minute: number,
	toolUseId: string,
	status = "success",
) {
	const input = { action: "work.create", title: `Item ${toolUseId}` };
	const call = { toolUseId, toolName: "Team", status, inputJson: input, outputJson: { ok: true } };
	return rowWithElements(
		{
			id,
			narratorId: "n1",
			seq,
			role: "assistant",
			contentText: "",
			toolCalls: [call],
			parentToolUseId: null,
			createdAt: iso(minute),
		},
		[{ type: "tool_use", id: toolUseId, name: "Team", input }],
	) as unknown as NarratorMsg;
}

describe("buildPretextDocumentLayout with and without team mode", () => {
	const messages = [
		textMessage("t1", 1, 0, "拆成 3 项"),
		teamMessage("c1", 2, 1, "u1"),
		teamMessage("c2", 3, 2, "u2"),
		teamMessage("c3", 4, 3, "u3"),
		teamMessage("c4", 5, 4, "u4", "running"),
		textMessage("t2", 6, 10, "好的"),
	];
	const base = {
		layoutRevision: "team",
		documentRevision: 1,
		lod: 4 as const,
		contentWidth: 640,
		widthBucket: "640",
	};
	const team = {
		events: [ev("e1", 6)],
		chipLabels: labels,
		revision: "r1",
		hasPrev: false,
	};

	it("the session page (no team mode) renders every Team call as its own card", () => {
		const plain = buildPretextDocumentLayout(messages, base);
		const kinds = plain.items.map((item) => item.spec.kind);
		expect(kinds).not.toContain("team-chip");
		expect(kinds).not.toContain("team-event");
		expect(kinds.filter((kind) => kind === "tool-call")).toHaveLength(4);
		// Explicitly absent and undefined build the same document.
		const again = buildPretextDocumentLayout(messages, { ...base, teamConversation: undefined });
		expect(again.manifest).toEqual(plain.manifest);
	});

	it("team mode: one chip, the running call as a card, the event at its time", () => {
		const built = buildPretextDocumentLayout(messages, { ...base, teamConversation: team });
		expect(built.items.map((item) => item.spec.kind)).toEqual([
			"markdown",
			"team-chip",
			"tool-call",
			"team-event",
			"markdown",
		]);
		const chip = built.items[1]?.measured as MeasuredTeamChip;
		expect(chip.data.countLabel).toBe(" ×3");
		expect(chip.expanded).toBe(false);
		// Fixed one-line rows.
		expect(built.items[1]?.measured.height).toBeGreaterThan(20);
		expect(built.items[1]?.measured.height).toBeLessThan(30);
		expect(built.items[3]?.measured.height).toBeGreaterThan(16);
		expect(built.items[3]?.measured.height).toBeLessThan(26);
		// Sources: the chip owns its calls' messages, the divider the unit before it.
		expect(built.manifest.items[1]?.sourceMessageIds).toEqual(["c1", "c2", "c3"]);
		expect(built.manifest.items[3]?.sourceMessageIds).toEqual(["c4"]);
		const seqs = built.manifest.items.map((item) => item.firstSeq);
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		// The manifest moves with the events; the rest of the document measures as before.
		const plain = buildPretextDocumentLayout(messages, base);
		expect(built.items[0]?.measured).toBe(plain.items[0]?.measured);
	});

	it("an expanded chip shows the ordinary cards it folds", () => {
		const built = buildPretextDocumentLayout(messages, {
			...base,
			teamConversation: team,
			isExpanded: (key) => (key === teamChipKey("u1") ? true : undefined),
		});
		expect(built.items.map((item) => item.spec.kind)).toEqual([
			"markdown",
			"team-chip",
			"tool-call",
			"tool-call",
			"tool-call",
			"tool-call",
			"team-event",
			"markdown",
		]);
		expect((built.items[1]?.measured as MeasuredTeamChip).expanded).toBe(true);
		expect(built.items[2]?.spec.key).toBe("tool-u1");
	});

	it("team mode keeps the measure cache: the manifest moves, the measure revision does not", () => {
		const revisions: unknown[] = [];
		const spy: typeof measureElementCached = (kind, data, width, lod, opts, key, revision) => {
			revisions.push(revision);
			return measureElementCached(kind, data, width, lod, opts, key, revision);
		};
		const built = buildPretextDocumentLayout(messages, {
			...base,
			measure: spy,
			teamConversation: team,
		});
		expect(String(built.manifest.documentRevision)).toContain("~team:r1");
		expect(revisions.length).toBeGreaterThan(0);
		expect(revisions.every((revision) => revision === "1")).toBe(true);
		expect(measureRevisionOf(built.manifest.documentRevision)).toBe("1");
		expect(measureRevisionOf(7)).toBe(7);
		// A resize preview re-measures under the same (team-free) revision, so it hits the cache.
		revisions.length = 0;
		previewResize({
			index: built.index,
			items: built.items,
			committedWidth: 640,
			width: 520,
			lod: 4,
			view: { scrollTop: 0, viewportHeight: 2000, pinnedToBottom: false },
			measure: spy,
		});
		expect(revisions.length).toBeGreaterThan(0);
		expect(revisions.every((revision) => revision === "1")).toBe(true);
		const plain = buildPretextDocumentLayout(messages, { ...base, measure: spy });
		const cachedText = plain.items[0]?.measured;
		const teamText = buildPretextDocumentLayout(messages, {
			...base,
			measure: spy,
			teamConversation: { ...team, revision: "r2", events: [] },
		}).items[0]?.measured;
		expect(teamText).toBe(cachedText);
	});

	it("a pending permission keeps its card even when settled-looking", () => {
		const built = buildPretextDocumentLayout(messages, {
			...base,
			teamConversation: team,
			resolveHasPendingPermission: (id) => id === "u2",
		});
		expect(built.items.map((item) => item.spec.key).slice(1, 4)).toEqual([
			teamChipKey("u1"),
			"tool-u2",
			teamChipKey("u3"),
		]);
	});
});

describe("Team call summaries on the session page (no team mode)", () => {
	const labels: Record<string, string> = {};
	for (const [key, value] of Object.entries(
		(zhNarrator as { teamTool: Record<string, string> }).teamTool,
	))
		labels[`teamTool_${key}`] = value.replace("{{count}}", "{count}");
	const resolveToolSummary = (raw: unknown) => {
		const tc = raw as { toolName: string; inputJson?: unknown };
		return getSummary(tc.toolName, tc.inputJson, undefined, labels);
	};
	const messages = [teamMessage("c1", 1, 1, "u1"), teamMessage("c2", 2, 2, "u2")];
	const base = {
		layoutRevision: "summary",
		documentRevision: 1,
		contentWidth: 640,
		widthBucket: "640",
		resolveToolSummary,
	};

	it("a card header names the action and the item title, not `Team Team`", () => {
		const built = buildPretextDocumentLayout(messages, { ...base, lod: 4 });
		const data = built.items.map((item) => item.spec.data as { summary?: string });
		expect(built.items.map((item) => item.spec.kind)).toEqual(["tool-call", "tool-call"]);
		expect(data.map((card) => card.summary)).toEqual([
			"建立工作项 · Item u1",
			"建立工作项 · Item u2",
		]);
	});

	it("L1/L2 trace rows read the same", () => {
		for (const lod of [1, 2] as const) {
			const built = buildPretextDocumentLayout(messages, { ...base, lod });
			const trace = built.items[0]?.spec.data as { items: { title: string }[] };
			expect(trace.items.map((row) => row.title)).toEqual([
				"Team · 建立工作项 · Item u1",
				"Team · 建立工作项 · Item u2",
			]);
		}
	});
});
