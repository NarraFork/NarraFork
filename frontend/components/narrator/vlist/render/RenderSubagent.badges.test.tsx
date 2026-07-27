/**
 * RenderSubagent.badges.test.tsx — the header badge row of the vlist subagent card.
 *
 * The chunked SubagentCard draws four header badges (agentType, background, model,
 * reasoning effort). The vlist copy carried only the first three, so a virtual-list
 * card silently dropped the thinking-effort badge that the chunked card showed for
 * the same subagent. These tests pin the full row on the render path, and the
 * adapter/registry suites pin the data that feeds it.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { measureSubagentCard, type SubagentCardData } from "../measure/measure-subagent";
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
const DATA: SubagentCardData = {
	agentType: "explore",
	description: "Investigate the auth flow",
	isTerminal: true,
};

function renderCard(badges: { model?: string; reasoningEffort?: string }): Element {
	const measured = measureSubagentCard({ ...DATA, ...badges }, WIDTH, 5, {});
	return parse(
		renderToStaticMarkup(
			<MantineProvider>
				<RenderSubagent
					measured={measured}
					description={DATA.description}
					agentType={DATA.agentType}
					model={badges.model}
					reasoningEffort={badges.reasoningEffort}
					isActive={false}
				/>
			</MantineProvider>,
		),
	);
}

const badgeText = (root: Element, testId: string) =>
	root.querySelector(`[data-testid="${testId}"]`)?.textContent;

describe("RenderSubagent — header badges", () => {
	it("paints the reasoning-effort badge alongside the model badge", () => {
		const root = renderCard({ model: "sonnet", reasoningEffort: "high" });
		expect(badgeText(root, "subagent-model")).toBe("sonnet");
		expect(badgeText(root, "subagent-reasoning-effort")).toBe("high");
	});

	it("paints the reasoning-effort badge even when no model is resolved yet", () => {
		const root = renderCard({ reasoningEffort: "xhigh" });
		expect(root.querySelector('[data-testid="subagent-model"]')).toBeNull();
		expect(badgeText(root, "subagent-reasoning-effort")).toBe("xhigh");
	});

	it("omits the badge when no effort is known (no placeholder text)", () => {
		const root = renderCard({ model: "sonnet" });
		expect(root.querySelector('[data-testid="subagent-reasoning-effort"]')).toBeNull();
	});

	it("stays height-neutral: the badge rides the existing fixed badge row", () => {
		const withBadge = measureSubagentCard(
			{ ...DATA, model: "sonnet", reasoningEffort: "high" },
			WIDTH,
			5,
			{},
		);
		const without = measureSubagentCard({ ...DATA, model: "sonnet" }, WIDTH, 5, {});
		expect(withBadge.height).toBe(without.height);
	});
});
