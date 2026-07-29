/**
 * SubagentActivityCategoryChip.test.tsx — pins that a subagent "recent calls" row
 * shows the SAME category mark as the tool card that owns the call.
 *
 * THE BUG THIS CLOSES
 * The activity row rendered a bare `<Icon>` inside a `c="dimmed"` box: right glyph,
 * wrong everything else. The tool card's header wraps the identical glyph in a
 * 16×16 tinted tile whose background and foreground come from the category colour
 * (`lime` for Read, `orange` for Bash, `violet` for Write…). So the same tool read
 * as a grey outline in one place and a coloured chip in the other — and the colour
 * is the whole point of the mark, since it is what lets a reader tell a file edit
 * from a shell run at a glance.
 *
 * WHY PARITY AND NOT A HARD-CODED EXPECTATION
 * Asserting `lime` for Read here would pass while the tool card moved to a
 * different palette, which is precisely the drift that produced the bug. So the
 * assertions compare the activity chip against a REAL `ToolCallCard` header
 * rendered from the same tool call, plus against `getCategoryColor` — the shared
 * source both consult. A future palette change moves all three together or fails.
 *
 * WHAT IS NOT ASSERTED
 * No Mantine internal class names: the chip is a plain `<span>` + CSS module, and
 * the meaningful output is the two custom properties the module's `background` /
 * `color` read from. Those are what these tests read.
 *
 * linkedom has no cascade, so `getComputedStyle` cannot resolve the CSS variables
 * to pixels or colours. The variables themselves ARE the contract — they are what
 * the component writes and what the stylesheet consumes — so the assertions read
 * them off the inline style, exactly as the row's other structural tests do.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const realReactI18nextModule = { ...(await import("react-i18next")) };
const realUseNarratorModule = { ...(await import("../../hooks/useNarrator")) };
const realUsePlatformModule = { ...(await import("../../hooks/usePlatform")) };
const realRouterModule = { ...(await import("@tanstack/react-router")) };

mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
// Neither the row nor the header needs narrator/router data; SubagentCard's module
// graph pulls these in at import time.
mock.module("../../hooks/useNarrator", () => ({
	...realUseNarratorModule,
	useNarrator: () => ({ data: undefined }),
	useToolCallDetail: () => ({ data: undefined }),
	useInterruptNarrator: () => ({ mutate: () => {}, isPending: false }),
	useAskInPassing: () => ({ isPending: false }),
	useCancelAskInPassing: () => ({ isPending: false }),
}));
mock.module("../../hooks/usePlatform", () => ({
	...realUsePlatformModule,
	usePlatform: () => "linux",
	useFileSystemCapability: () => ({ supported: false }),
	useNarratorPermissionsCapability: () => ({ supported: false }),
	useShareCapability: () => ({ supported: false }),
	useNarratorSubagentsCapability: () => ({
		supported: true,
		detachAttach: true,
		background: true,
		staleRecovery: true,
	}),
}));
mock.module("@tanstack/react-router", () => ({
	...realRouterModule,
	useNavigate: () => () => {},
	useSearch: () => ({}),
}));

const { SUBAGENT_CATEGORY_SLOT_SIZE, SubagentActivityRow } = await import("./SubagentCard");
const {
	getCategory,
	getCategoryColor,
	TOOL_CATEGORY_CHIP_GLYPH_SIZE,
	ToolCallCard,
	ToolCategoryChip,
} = await import("./ToolCallCard");
type ToolCallData = import("./ToolCallCard").ToolCallData;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
// `ToolCallCard` reads an execution-device query for its remote-target badge. No
// fetch is needed for a local call, but the hook still requires a client.
let queryClient: QueryClient | undefined;

/**
 * Keys this file publishes on `globalThis`, and their pre-existing descriptors.
 *
 * The realm must not outlive the file: `parseHTML()` mints a fresh `Event` class
 * per call, and a leaked one fails a later file's `dispatchEvent(new Event(…))`
 * instance check. Bun runs every file in one process, so restoring is this file's
 * own responsibility.
 */
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
	const cancelAnimationFrame = (id: number) => clearTimeout(id);
	// linkedom's window is a Proxy over the real globalThis, so `writable: true` is
	// what keeps these from stranding there as readonly and breaking a later file's
	// `Object.assign(window, …)`.
	Object.defineProperties(window, {
		requestAnimationFrame: { configurable: true, writable: true, value: requestAnimationFrame },
		cancelAnimationFrame: { configurable: true, writable: true, value: cancelAnimationFrame },
		matchMedia: { configurable: true, writable: true, value: matchMedia },
	});
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (!savedGlobals.has(key)) savedGlobals.set(key, descriptor);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

function restoreGlobals() {
	for (const [key, descriptor] of savedGlobals) {
		const current = Object.getOwnPropertyDescriptor(globalThis, key);
		if (current && !current.configurable) continue;
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	savedGlobals.clear();
}

/**
 * One tool per distinct category colour that a subagent actually runs, so the
 * colour assertions compare values that really differ instead of coincidentally
 * matching. Read/Bash/Grep/Write cover lime/orange/cyan/violet.
 */
const CASES = [
	{ toolName: "Read", color: "lime" },
	{ toolName: "Bash", color: "orange" },
	{ toolName: "Grep", color: "cyan" },
	{ toolName: "Write", color: "violet" },
] as const;

function toolCall(toolName: string): ToolCallData {
	return {
		toolName,
		toolUseId: `tool-${toolName}`,
		inputJson: {},
		status: "success",
		durationMs: 1_000,
	};
}

async function renderNode(node: React.ReactNode) {
	if (!root || !queryClient) throw new Error("test harness is not initialized");
	const currentRoot = root;
	const currentQueryClient = queryClient;
	await act(async () => {
		currentRoot.render(
			<MantineProvider env="test">
				<QueryClientProvider client={currentQueryClient}>{node}</QueryClientProvider>
			</MantineProvider>,
		);
	});
}

/** The chip inside a subagent activity row. */
function activityChip(): HTMLElement {
	const chips =
		container?.querySelectorAll('[data-testid="subagent-activity-category-chip"]') ?? [];
	// Exactly one per row: a second mark would be a duplicate affordance.
	expect(chips.length).toBe(1);
	return chips[0] as unknown as HTMLElement;
}

/**
 * The chip inside a rendered tool card header. Found by the chip's own marker
 * attribute rather than a Mantine or CSS-module class name, which are build
 * artefacts and were deliberately removed from this suite's assertions.
 */
function cardChip(): HTMLElement {
	const chips = container?.querySelectorAll("[data-tool-category-chip]") ?? [];
	expect(chips.length).toBe(1);
	return chips[0] as unknown as HTMLElement;
}

/** The declarations that decide what the chip LOOKS like. */
function chipAppearance(el: HTMLElement) {
	return {
		category: el.getAttribute("data-tool-category-chip"),
		bg: el.style.getPropertyValue("--tool-header-icon-bg"),
		fg: el.style.getPropertyValue("--tool-header-icon-color"),
		className: el.getAttribute("class"),
		glyph: el.querySelector("svg")?.getAttribute("class") ?? null,
		size: el.querySelector("svg")?.getAttribute("width") ?? null,
	};
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY, refetchOnMount: false },
			mutations: { retry: false },
		},
	});
});

afterEach(async () => {
	const currentRoot = root;
	await act(async () => currentRoot?.unmount());
	queryClient?.clear();
	container?.remove();
	root = undefined;
	container = undefined;
	queryClient = undefined;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.module("../../hooks/useNarrator", () => realUseNarratorModule);
	mock.module("../../hooks/usePlatform", () => realUsePlatformModule);
	mock.module("@tanstack/react-router", () => realRouterModule);
	mock.restore();
	restoreGlobals();
});

describe("activity row category chip carries the category colour", () => {
	test("writes the colour variables the chip's background and text read from", async () => {
		// The bug was a chip with NO colour of its own, inheriting the row's dimmed
		// text. Both variables present and pointing at the category's palette entry is
		// what distinguishes the fix from that state.
		for (const { toolName, color } of CASES) {
			await render(toolName);
			const { bg, fg } = chipAppearance(activityChip());
			expect(bg).toBe(`var(--mantine-color-${color}-light, var(--mantine-color-${color}-1))`);
			expect(fg).toBe(`var(--mantine-color-${color}-light-color, var(--mantine-color-${color}-6))`);
		}
	});

	test("the colour is the one getCategoryColor answers for that tool", async () => {
		// Derived, not transcribed: the literals in CASES above are a readability aid,
		// this is the assertion that survives a palette change.
		for (const { toolName } of CASES) {
			await render(toolName);
			const expected = getCategoryColor(getCategory(toolName));
			expect(chipAppearance(activityChip()).bg).toContain(`--mantine-color-${expected}-light`);
		}
	});

	test("different categories really do get different colours", async () => {
		// Guards the degenerate fix where every chip is tinted the same (a hard-coded
		// colour, or a fallback swallowing the lookup) — each assertion above would
		// still pass one at a time.
		const seen = new Set<string>();
		for (const { toolName } of CASES) {
			await render(toolName);
			seen.add(chipAppearance(activityChip()).bg);
		}
		expect(seen.size).toBe(CASES.length);
	});

	test("an unknown tool falls back to the generic colour rather than no colour", async () => {
		// A tool this frontend has never heard of is the case that used to look
		// identical to the bug (grey), so it needs the explicit assertion: grey is now
		// a real category tint, not an absence of one.
		await render("TotallyUnknownTool");
		const generic = getCategoryColor(getCategory("TotallyUnknownTool"));
		expect(chipAppearance(activityChip()).bg).toContain(`--mantine-color-${generic}-light`);
	});
});

describe("activity row chip matches the tool card header chip", () => {
	test("identical appearance for the same tool call", async () => {
		// The point of the whole change: not "the row has A colour" but "the row has the
		// SAME mark as the card". Compared against a real ToolCallCard render, so glyph,
		// size, tint and the CSS-module class are all held together — a change to the
		// header that missed the row fails here.
		for (const { toolName } of CASES) {
			const call = toolCall(toolName);

			await renderNode(<SubagentActivityRow call={call} />);
			const rowAppearance = chipAppearance(activityChip());

			await renderNode(<ToolCallCard toolCall={call} />);
			const headerAppearance = chipAppearance(cardChip());

			expect(rowAppearance).toEqual(headerAppearance);
		}
	});

	test("both render the shared chip component", async () => {
		// A copy that happens to agree today is the state this change removed. Rendering
		// ToolCategoryChip directly and matching it proves both call sites go through
		// the one definition rather than two that currently coincide.
		for (const { toolName } of CASES) {
			await renderNode(<SubagentActivityRow call={toolCall(toolName)} />);
			const rowAppearance = chipAppearance(activityChip());

			await renderNode(<ToolCategoryChip category={getCategory(toolName)} toolName={toolName} />);
			const direct = chipAppearance(cardChip());

			// The row passes a test id the bare chip does not, so compare everything else.
			expect({ ...rowAppearance, className: undefined }).toEqual({
				...direct,
				className: undefined,
			});
			expect(rowAppearance.className).toContain(direct.className ?? "");
		}
	});

	test("the glyph is inset inside the chip, not drawn to its edge", async () => {
		// A 10px glyph in a 16px slot is what makes the tint read as a chip. Equal
		// numbers would render a tinted box tight around the icon — technically
		// coloured, visually a different mark from the card's.
		await render("Read");
		expect(chipAppearance(activityChip()).size).toBe(String(TOOL_CATEGORY_CHIP_GLYPH_SIZE));
		expect(TOOL_CATEGORY_CHIP_GLYPH_SIZE).toBeLessThan(SUBAGENT_CATEGORY_SLOT_SIZE);
	});
});

async function render(toolName: string) {
	await renderNode(<SubagentActivityRow call={toolCall(toolName)} />);
}
