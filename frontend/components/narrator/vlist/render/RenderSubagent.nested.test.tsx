/**
 * RenderSubagent.nested.test.tsx — the subagent card's one nested level.
 *
 * A first-level `worker` may launch helpers. On the primary's page its card lists them:
 * a row each (bounded), an overflow row for the rest, and a badge on a helper whose
 * permission request waits for a person. These tests pin the chain end to end on the
 * pure path: activity summary → adapter card data → measured height → painted rows,
 * plus the live patch that replaces the rows and the cache key that must move with it.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import en from "@frontend/locales/en/narrator.json";
import zh from "@frontend/locales/zh-CN/narrator.json";
import { MantineProvider } from "@mantine/core";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import type { AdapterSegment } from "@shared/pretext-layout/segment-adapter";
import {
	normalizeSubagentNestedSummary,
	SUBAGENT_NESTED_CARD_LIMIT,
	type SubagentNestedSummary,
} from "@shared/subagent-nested";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { measureSubagentCard, type SubagentCardData } from "../measure/measure-subagent";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { extractDataRevision } from "../measure-cache";
import { adaptSegment } from "../segment-adapter";
import { patchSubagentNested } from "../vlist-live-patch";
import { RenderSubagent } from "./RenderSubagent";

beforeAll(() => installCanvasStub());

const WIDTH = 600;
const BASE: SubagentCardData = {
	agentType: "worker",
	description: "Implement it",
	isTerminal: false,
};
const NESTED: SubagentNestedSummary = {
	total: 7,
	agents: [
		{
			subagentNarratorId: "h1",
			title: "write tests",
			subagentType: "general",
			status: "working",
			awaitingPermission: true,
		},
		{ subagentNarratorId: "h2", title: null, subagentType: "review", status: "idle" },
	],
};

function cardData(nested: unknown): SubagentCardData {
	const seg: AdapterSegment = {
		kind: "tool-run",
		sourceMessages: [],
		items: [
			{
				blockIndex: 0,
				isSubagent: true,
				tc: {
					toolName: "Agent",
					status: "running",
					toolUseId: "agent-1",
					inputJson: { subagent_type: "worker", description: "Implement it" },
					_subagentActivity: { latestToolCalls: [], model: null, subagentNarratorId: "w1", nested },
				},
			},
		],
	};
	const spec = adaptSegment(seg, { lod: 5 })[0];
	expect(spec?.kind).toBe("subagent-card");
	return spec?.data as SubagentCardData;
}

function render(data: SubagentCardData, opened: string[], labels?: Record<string, string>) {
	const measured = measureSubagentCard(data, WIDTH, 5, {});
	const html = renderToStaticMarkup(
		<MantineProvider>
			<RenderSubagent
				measured={measured}
				description={data.description}
				agentType={data.agentType}
				nestedAgents={data.nestedAgents}
				nestedTotal={data.nestedTotal}
				onOpenNestedSession={(id) => opened.push(id)}
				labels={labels}
				isActive
			/>
		</MantineProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document;
}

describe("subagent card — nested helpers", () => {
	it("the adapter carries the helpers; a card without helpers carries nothing", () => {
		const data = cardData(NESTED);
		expect(data.nestedAgents?.map((a) => a.subagentNarratorId)).toEqual(["h1", "h2"]);
		expect(data.nestedTotal).toBe(7);
		expect("nestedAgents" in cardData(undefined)).toBe(false);
		expect("nestedAgents" in cardData({ agents: [], total: 0 })).toBe(false);
	});

	it("each helper row and the overflow row add one trace row of height", () => {
		const without = measureSubagentCard(BASE, WIDTH, 5, {});
		const one = measureSubagentCard(
			{ ...BASE, nestedAgents: NESTED.agents.slice(0, 1), nestedTotal: 1 },
			WIDTH,
			5,
			{},
		);
		const two = measureSubagentCard(
			{ ...BASE, nestedAgents: NESTED.agents, nestedTotal: 2 },
			WIDTH,
			5,
			{},
		);
		const overflow = measureSubagentCard(
			{ ...BASE, nestedAgents: NESTED.agents, nestedTotal: 7 },
			WIDTH,
			5,
			{},
		);
		expect(without.nestedHeight).toBe(0);
		expect(one.nestedHeight).toBeGreaterThan(0);
		expect(one.height - without.height).toBe(one.nestedHeight);
		const row = two.nestedHeight - one.nestedHeight;
		expect(row).toBeGreaterThan(0);
		expect(overflow.nestedHeight - two.nestedHeight).toBeCloseTo(row, 6);
		expect(overflow.hasNestedOverflowRow).toBe(true);
		// Shown on a folded card too: a helper waiting for approval must stay visible.
		const folded = measureSubagentCard(
			{ ...BASE, isTerminal: true, nestedAgents: NESTED.agents, nestedTotal: 2 },
			WIDTH,
			1,
			{ opened: false },
		);
		expect(folded.effectiveExpanded).toBe(false);
		expect(folded.nestedHeight).toBe(two.nestedHeight);
	});

	it("paints one row per helper, the awaiting badge and the rest as a count; rows open the helper", () => {
		const opened: string[] = [];
		const doc = render(cardData(NESTED), opened);
		const rows = [...doc.querySelectorAll('[data-testid="subagent-nested-row"]')];
		expect(rows).toHaveLength(2);
		expect(rows[0]?.getAttribute("data-awaiting")).toBe("true");
		expect(rows[0]?.textContent).toContain("write tests");
		expect(rows[0]?.textContent).toContain(en.subagentNestedAwaiting);
		expect(rows[1]?.getAttribute("data-awaiting")).toBeNull();
		expect(rows[1]?.textContent).toContain("review");
		const region = doc.querySelector('[data-testid="subagent-nested"]');
		expect(region?.textContent).toContain("5 more helpers");
	});

	it("a failed or stopped helper shows the red or orange mark, a finished one the check", () => {
		const data = cardData({
			total: 3,
			agents: [
				{
					subagentNarratorId: "f",
					title: "f",
					subagentType: "general",
					status: "idle",
					ended: "failed",
				},
				{
					subagentNarratorId: "s",
					title: "s",
					subagentType: "general",
					status: "idle",
					ended: "stopped",
				},
				{ subagentNarratorId: "d", title: "d", subagentType: "general", status: "idle" },
			],
		});
		const rows = [...render(data, []).querySelectorAll('[data-testid="subagent-nested-row"]')];
		const icon = (row: Element | undefined) =>
			[...(row?.querySelectorAll("svg") ?? [])].map((svg) => svg.getAttribute("class")).join(" ");
		expect(rows.map((row) => row.getAttribute("data-ended"))).toEqual(["failed", "stopped", null]);
		expect(icon(rows[0])).toContain("circle-x");
		expect(icon(rows[1])).toContain("ban");
		expect(icon(rows[2])).toContain("circle-check");
		expect(icon(rows[2])).not.toContain("circle-x");
		// The end state is painted from the cached payload, so it must move the key.
		const before = extractDataRevision({
			...BASE,
			nestedAgents: [{ ...NESTED.agents[1] }],
			nestedTotal: 1,
		});
		const after = extractDataRevision({
			...BASE,
			nestedAgents: [{ ...NESTED.agents[1], ended: "failed" as const }],
			nestedTotal: 1,
		});
		expect(after).not.toBe(before);
	});

	it("uses the zh-CN strings when given", () => {
		const doc = render(cardData(NESTED), [], {
			nestedTitle: zh.subagentNestedTitle,
			nestedMore: zh.subagentNestedMore,
			nestedAwaiting: zh.subagentNestedAwaiting,
		});
		const region = doc.querySelector('[data-testid="subagent-nested"]');
		expect(region?.textContent).toContain(zh.subagentNestedTitle);
		expect(region?.textContent).toContain(zh.subagentNestedAwaiting);
		expect(region?.textContent).toContain("还有 5 个帮手");
	});

	it("the live patch replaces the rows on the matching card only, and the cache key moves", () => {
		const message = rowWithElements(
			{ id: "m1", role: "assistant", narratorId: "p1", createdAt: "2026-11-17T00:00:00Z" },
			[
				{
					type: "tool_use",
					id: "agent-1",
					name: "Agent",
					input: {},
					_subagentActivity: { subagentNarratorId: "w1", model: null, latestToolCalls: [] },
				},
			],
		);
		const patched = patchSubagentNested([message] as never, "agent-1", "w1", NESTED);
		expect(patched.changed).toBe(true);
		const block = messageBody(patched.messages[0] as never)[0] as {
			_subagentActivity?: { nested?: unknown };
		};
		expect(normalizeSubagentNestedSummary(block._subagentActivity?.nested)?.total).toBe(7);
		// Another card's child never receives this subagent's helpers.
		expect(patchSubagentNested([message] as never, "agent-1", "other", NESTED).changed).toBe(false);
		expect(patchSubagentNested([message] as never, "agent-x", "w1", NESTED).changed).toBe(false);

		const before = extractDataRevision({ ...BASE, nestedAgents: NESTED.agents, nestedTotal: 2 });
		const after = extractDataRevision({
			...BASE,
			nestedAgents: [{ ...NESTED.agents[0], awaitingPermission: undefined }, NESTED.agents[1]],
			nestedTotal: 2,
		});
		expect(after).not.toBe(before);
	});

	it("the shared bound caps what a summary can carry", () => {
		const many = normalizeSubagentNestedSummary({
			total: 20,
			agents: Array.from({ length: 20 }, (_, i) => ({
				subagentNarratorId: `h${i}`,
				status: "idle",
			})),
		});
		expect(many?.agents).toHaveLength(SUBAGENT_NESTED_CARD_LIMIT);
		expect(many?.total).toBe(20);
	});
});
