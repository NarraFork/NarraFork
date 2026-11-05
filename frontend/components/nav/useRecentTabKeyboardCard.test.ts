import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { keyboardCardRect, keyboardCardRow } from "./useRecentTabKeyboardCard";

type Rect = { top: number; bottom: number; left: number; right: number };

/** The sidebar as AuthenticatedAppLayout builds it; `panel` is the content box's attribute. */
function sidebar(panel: "closed" | "open" | null) {
	const { document } = parseHTML(`<!doctype html><html><body>
		<nav class="mantine-AppShell-navbar">
			<div id="panel" ${panel ? `data-nav-hover-panel="${panel}"` : ""}>
				<div class="nf-nav-tabs">
					<div id="list">
						<div data-tab-sort-id="narrator:a"></div>
						<div data-folder-unit="f1"><div data-tab-sort-id="folder:f1"></div></div>
					</div>
				</div>
			</div>
		</nav>
	</body></html>`);
	const at = (selector: string, rect: Rect) => {
		const el = document.querySelector(selector) as HTMLElement;
		el.getBoundingClientRect = () => rect as DOMRect;
	};
	at(".mantine-AppShell-navbar", { top: 0, bottom: 800, left: 0, right: 73 });
	at(".nf-nav-tabs", { top: 60, bottom: 700, left: 16, right: 233 });
	at('[data-tab-sort-id="narrator:a"]', { top: 100, bottom: 136, left: 16, right: 233 });
	at('[data-tab-sort-id="folder:f1"]', { top: 140, bottom: 176, left: 16, right: 233 });
	return document.getElementById("list") as HTMLElement;
}

describe("keyboard card row and anchor", () => {
	test("collapsed: the card anchors at the row's height against the rail", () => {
		const list = sidebar("closed");
		const row = keyboardCardRow(list, "narrator:a", null);
		expect(row?.getAttribute("data-tab-sort-id")).toBe("narrator:a");
		expect(keyboardCardRect(row as HTMLElement)).toEqual({
			top: 100,
			bottom: 136,
			left: 16,
			right: 73,
		});
	});

	test("open on hover: the row is not clipped, so the card goes next to the full row", () => {
		const list = sidebar("open");
		const row = keyboardCardRow(list, "narrator:a", null) as HTMLElement;
		expect(keyboardCardRect(row)?.right).toBe(233);
	});

	test("expanded (or the phone drawer): no keyboard card", () => {
		expect(keyboardCardRow(sidebar(null), "narrator:a", null)).toBeNull();
	});

	test("a member of a collapsed folder anchors on its folder header", () => {
		const list = sidebar("closed");
		const row = keyboardCardRow(list, "narrator:hidden", "f1");
		expect(row?.getAttribute("data-tab-sort-id")).toBe("folder:f1");
		expect(keyboardCardRect(row as HTMLElement)?.top).toBe(140);
	});

	test("a tab with no row in this list has no card", () => {
		expect(keyboardCardRow(sidebar("closed"), "narrator:elsewhere", null)).toBeNull();
	});
});
