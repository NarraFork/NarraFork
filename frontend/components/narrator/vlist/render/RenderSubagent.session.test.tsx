/**
 * RenderSubagent.session.test.tsx — the vlist subagent card's in-card routes to
 * the child session.
 *
 * The chunked SubagentCard exposes TWO in-card affordances (SubagentCard.tsx):
 * the "open full session" button in the recent-calls header, and every recent
 * activity row (an UnstyledButton). The vlist copy drew the rows as inert divs
 * and its header button was never wired, so a virtual-list card could only be
 * reached through the right-click menu. These tests pin both back.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { CommunicationBubbleData } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { measureCommunicationBubble } from "../measure/measure-communication-bubble";
import { measureSubagentCard, type SubagentCardData } from "../measure/measure-subagent";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { type AdapterToolItem, adaptSegments } from "../segment-adapter";
import {
	resolveSubagentViewTargets,
	resolveToolDetailModelTargets,
	type VListViewTarget,
} from "../vlist-content-view-target";
import { RenderCommunicationBubble } from "./RenderCommunicationBubble";
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
const RECENT_NAMES = ["Read", "Grep", "Bash"];

function renderCard(opts: { onOpenSession?: () => void; hasButton?: boolean }): Element {
	const measured = measureSubagentCard(
		{
			agentType: "explore",
			description: "Investigate the auth flow",
			isTerminal: true,
			recentCallCount: RECENT_NAMES.length,
			hasRecentCallsButton: opts.hasButton ?? true,
		},
		WIDTH,
		5,
		{},
	);
	return parse(
		renderToStaticMarkup(
			<MantineProvider>
				<RenderSubagent
					measured={measured}
					description="Investigate the auth flow"
					agentType="explore"
					recentCallNames={RECENT_NAMES}
					onOpenSession={opts.onOpenSession}
				/>
			</MantineProvider>,
		),
	);
}

it("hides background protocol output without a notice row", () => {
	const measured = measureSubagentCard(
		{
			agentType: "general",
			description: "Background work",
			isBackground: true,
			resultBody: {
				kind: "capped",
				id: "background-result",
				source: "output.main",
				cap: "agent-result",
				text: "<background_task_id>child</background_task_id>\nUse Await to get results.",
				format: "markdown",
				live: false,
				followTarget: { kind: "end" },
			},
		},
		WIDTH,
		5,
		{ opened: true },
	);
	const root = parse(
		renderToStaticMarkup(
			<MantineProvider>
				<RenderSubagent
					measured={measured}
					description="Background work"
					isBackground
					onOpenSession={() => {}}
				/>
			</MantineProvider>,
		),
	);
	expect(root.querySelector('[data-testid="subagent-background-notice"]')).toBeNull();
	expect(root.textContent).not.toContain("background_task_id");
	expect(root.textContent).not.toContain("Use Await");
});

const activityRows = (root: Element) =>
	Array.from(root.querySelectorAll('[data-testid="subagent-activity"]'));

function actualToolSpec(toolName: "Agent" | "Send", streaming: boolean, message = "hello") {
	const field = toolName === "Send" ? "message" : "prompt";
	const inputJson = streaming
		? {
				_streamingChars: 5,
				_streamingFieldName: field,
				_streamingFieldValue: message,
				description: "inspect",
			}
		: { [field]: message, description: "inspect" };
	const item: AdapterToolItem = {
		blockIndex: 0,
		isSubagent: true,
		tc: {
			toolUseId: "actual-call",
			toolName,
			status: "running",
			inputJson,
			outputJson: "# result",
		},
	};
	const specs = adaptSegments([{ kind: "tool-run", items: [item], sourceMessages: [] }], {
		lod: 5,
		isPromptOpen: () => true,
	});
	expect(specs).toHaveLength(1);
	const spec = specs[0];
	if (!spec) throw new Error("actual tool route not found");
	return spec;
}

function actualSubagent(streaming: boolean) {
	const spec = actualToolSpec("Agent", streaming);
	expect(spec.kind).toBe("subagent-card");
	const data = spec.data as SubagentCardData;
	const measured = measureSubagentCard(data, WIDTH, 5, { opened: true });
	const targets = resolveSubagentViewTargets(spec.key, measured);
	const seen: VListViewTarget[] = [];
	const html = renderToStaticMarkup(
		<MantineProvider>
			<RenderSubagent
				measured={measured}
				description={data.description}
				isActive
				viewTargets={targets}
				viewControls={{
					isWrapped: (target) => {
						seen.push(target);
						return true;
					},
					isSourceShown: () => false,
					toggleWrap() {},
					toggleSource() {},
					openFullscreen() {},
				}}
			/>
		</MantineProvider>,
	);
	return { data, measured, seen, root: parse(html) };
}

describe("RenderSubagent — canonical prompt and result wiring", () => {
	it("Agent uses its real source and forwards the right target to its viewport", () => {
		const { measured, root, seen } = actualSubagent(true);
		expect(measured.promptMeasured?.model.source).toBe("input.prompt");
		expect(measured.promptMeasured?.model.live).toBe(true);
		expect(seen.some((target) => target.slot === "input.prompt")).toBe(true);
		const ports = [...root.querySelectorAll("[data-content-scrollport]")];
		expect(ports).toHaveLength(2);
		expect(ports[0]?.getAttribute("data-content-scrollport")).toBe(
			measured.promptMeasured?.model.id ?? null,
		);
		expect(ports[0]?.textContent).toContain("hello");
		expect(ports[1]?.querySelector("[data-tool-markdown]")).not.toBeNull();
	});
	it("Agent does not treat child execution as prompt streaming", () => {
		const { measured, root } = actualSubagent(false);
		expect(measured.promptMeasured?.model.live).toBe(false);
		expect(root.querySelector("[data-content-scrollport]")?.getAttribute("data-following")).toBe(
			"false",
		);
	});
});

// Send is communication, even when legacy records incorrectly mark it isSubagent.
// Its bounded inline markdown is not a prompt/result pair, while the full-message
// viewer must retain input.message identity and its real input-stream lifecycle.
describe("Send — communication body and full-message target", () => {
	for (const streaming of [true, false]) {
		it(`keeps the message source and live=${streaming} without rendering a child result`, () => {
			const spec = actualToolSpec("Send", streaming, "**hello**");
			expect(spec.kind).toBe("communication-bubble");
			const data = spec.data as CommunicationBubbleData;
			expect(data.message).toBe("**hello**");
			expect(data.messageBody?.source).toBe("input.message");
			expect(data.messageBody?.live).toBe(streaming);
			if (!data.messageBody) throw new Error("missing full-message body");
			const targets = resolveToolDetailModelTargets(spec.key, {
				kind: "sections",
				sections: [{ key: "input.message", label: "message", body: data.messageBody }],
			});
			expect(targets).toHaveLength(1);
			expect(targets[0]?.slot).toBe("input.message");
			expect(targets[0]?.model).toBe(data.messageBody);
			expect(targets[0]?.text).toBe("**hello**");
			const measured = measureCommunicationBubble(data, WIDTH, 5);
			const root = parse(
				renderToStaticMarkup(
					<MantineProvider>
						<RenderCommunicationBubble measured={measured} data={data} />
					</MantineProvider>,
				),
			);
			expect(root.querySelector("[data-vlist-communication-body]")?.textContent).toBe("hello");
			expect(root.querySelector("[data-content-scrollport]")).toBeNull();
			expect(root.textContent).not.toContain("# result");
			expect(root.querySelector("[data-testid='subagent-activity']")).toBeNull();
		});
	}
});

describe("RenderSubagent — recent-call rows open the child session", () => {
	it("renders one interactive row per recent call when a handler is supplied", () => {
		const root = renderCard({ onOpenSession: () => {} });
		const rows = activityRows(root);
		expect(rows).toHaveLength(RECENT_NAMES.length);
		// Buttons, not bare divs — that is what made them unclickable.
		for (const row of rows) {
			expect(row.tagName.toLowerCase()).toBe("button");
			expect(row.hasAttribute("disabled")).toBe(false);
		}
	});

	it("disables the rows when no child session can be opened", () => {
		const root = renderCard({});
		const rows = activityRows(root);
		expect(rows).toHaveLength(RECENT_NAMES.length);
		for (const row of rows) expect(row.hasAttribute("disabled")).toBe(true);
	});

	it("still draws the header open-session button (measure gate)", () => {
		const withButton = renderCard({ onOpenSession: () => {} });
		expect(withButton.textContent ?? "").toContain("Open full session");
		// The measure layer decides whether the button row exists at all; without it
		// the header must not claim the taller compact-xs row.
		const withoutButton = renderCard({ onOpenSession: () => {}, hasButton: false });
		expect(withoutButton.textContent ?? "").not.toContain("Open full session");
	});
});
