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

const activityRows = (root: Element) =>
	Array.from(root.querySelectorAll('[data-testid="subagent-activity"]'));

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
