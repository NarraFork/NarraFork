/**
 * RenderSubagent.timing.test.tsx — timing on the vlist subagent card.
 *
 * The chunked SubagentCard renders a ToolTimingArea in TWO places (its header,
 * SubagentCard.tsx:623, and every recent-call row, :684). The vlist copy had
 * neither: its header ended at the status glyph and its activity rows showed only
 * a tool name. These tests pin both slots and, crucially, that the per-row timings
 * pair POSITIONALLY with the row names — a mis-pairing would confidently attribute
 * one tool's duration to another.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { measureSubagentCard } from "../measure/measure-subagent";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { RenderSubagent } from "./RenderSubagent";

let parse: (html: string) => Element;

beforeAll(() => {
	installCanvasStub();
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

const WIDTH = 600;

/** Recognizable label bundle so the aria-label assertions are wording-stable. */
const TIMING_LABELS = {
	title: "TIMING",
	started: "STARTED",
	streamStarted: "STREAM",
	permissionStarted: "PERM",
	executionStarted: "EXEC",
	completed: "DONE",
	total: "TOTAL {duration}",
	permissionWait: "WAIT {duration}",
	execution: "RUN {duration}",
	startedAt: "AT {time}",
	timeoutSeconds: "SECONDS",
	timeoutUpdate: "UPDATE",
};

type SubagentCardData = import("../measure/measure-subagent").SubagentCardData;

/**
 * `recentCallNames` is a RENDER prop (the measure layer only needs the count), so
 * it is passed separately from the measure data — mirroring how the adapter feeds
 * the two layers.
 */
function renderCard(
	data: Partial<SubagentCardData>,
	opts: { recentCallNames?: string[]; isActive?: boolean } = {},
): Element {
	const isActive = opts.isActive ?? false;
	const full: SubagentCardData = {
		agentType: "explore",
		description: "Investigate the auth flow",
		isTerminal: !isActive,
		...data,
	};
	const measured = measureSubagentCard(full, WIDTH, 5, { isActive });
	return parse(
		renderToStaticMarkup(
			<MantineProvider>
				<RenderSubagent
					measured={measured}
					description={full.description}
					agentType={full.agentType}
					recentCallNames={opts.recentCallNames}
					isActive={isActive}
					status={isActive ? "running" : "success"}
					labels={{ timing: TIMING_LABELS }}
				/>
			</MantineProvider>,
		),
	);
}

const activityRows = (root: Element) =>
	Array.from(root.querySelectorAll('[data-testid="subagent-activity"]'));

const ariaLabels = (root: Element) =>
	Array.from(root.querySelectorAll("[aria-label]")).map(
		(node) => node.getAttribute("aria-label") ?? "",
	);

describe("RenderSubagent — header timing", () => {
	it("paints the card's own duration with an accessible start label", () => {
		const root = renderCard({
			timing: {
				createdAt: 1_000,
				executionStartedAt: 2_000,
				completedAt: 5_000,
				durationMs: 3_000,
			},
		});
		expect(root.textContent ?? "").toContain("3s");
		const label = ariaLabels(root).find((value) => value.startsWith("AT "));
		expect(label).toBeDefined();
		expect(label).not.toContain("{time}");
	});

	it("adds no timing slot when the card carries no stamps", () => {
		const root = renderCard({});
		expect(ariaLabels(root).some((value) => value.startsWith("AT "))).toBe(false);
	});
});

describe("RenderSubagent — recent-call row timing", () => {
	const NAMES = ["Read", "Grep", "Bash"];

	it("shows each row's own duration inside that row", () => {
		const root = renderCard(
			{
				recentCallCount: NAMES.length,
				recentCallTimings: [
					{
						status: "success",
						createdAt: 10,
						completedAt: 1_010,
						durationMs: 1_000,
					},
					{ status: "success", createdAt: 20, completedAt: 2_020, durationMs: 2_000 },
					{ status: "success", createdAt: 30, completedAt: 3_030, durationMs: 3_000 },
				],
			},
			{ recentCallNames: NAMES },
		);
		const rows = activityRows(root);
		expect(rows).toHaveLength(3);
		// Each row pairs its NAME with its OWN duration — the mis-pairing guard.
		expect(rows[0]?.textContent ?? "").toContain("Read");
		expect(rows[0]?.textContent ?? "").toContain("1s");
		expect(rows[1]?.textContent ?? "").toContain("2s");
		expect(rows[2]?.textContent ?? "").toContain("3s");
	});

	it("leaves a row plain when no timing arrived for it", () => {
		// Activity headers can predate the timing payload; such a row must look exactly
		// as it did before rather than rendering an empty affordance.
		const root = renderCard({ recentCallCount: NAMES.length }, { recentCallNames: NAMES });
		const rows = activityRows(root);
		expect(rows).toHaveLength(3);
		for (const row of rows) expect(row.querySelector("[aria-label]")).toBeNull();
	});

	it("drops the extra timings the measure layer clipped away", () => {
		// recentCallTimings is sliced to the DRAWN rows, so a 5-entry payload on a
		// 3-row card must not leak a 4th duration into the DOM.
		const root = renderCard(
			{
				recentCallCount: 5,
				recentCallTimings: [
					{ status: "success", createdAt: 1, durationMs: 1_000 },
					{ status: "success", createdAt: 2, durationMs: 2_000 },
					{ status: "success", createdAt: 3, durationMs: 3_000 },
					{ status: "success", createdAt: 4, durationMs: 44_000 },
				],
			},
			{ recentCallNames: NAMES },
		);
		expect(activityRows(root)).toHaveLength(3);
		expect(root.textContent ?? "").not.toContain("44s");
	});
});
