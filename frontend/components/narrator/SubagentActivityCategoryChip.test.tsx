/**
 * SubagentActivityCategoryChip.test.tsx — pins that a subagent "recent calls" row
 * shows the SAME category mark as the low-LOD trace row for the same call.
 *
 * THE BUG THIS CLOSES
 * The activity row rendered a bare `<Icon>` inside a `c="dimmed"` box: right glyph,
 * wrong everything else, so a file edit and a shell run were indistinguishable at a
 * glance. It was then given the tool card header's 16px tinted tile; the row has
 * since become a TRACE row, so its mark is the trace lane's 14px tinted `ThemeIcon`
 * instead. The invariant is unchanged in substance — the chip must be tinted by
 * category and must match the other rendering of the same call — only its parity
 * TARGET moved from the card header to the trace row, which is the shape this row
 * now shares.
 *
 * WHY PARITY AND NOT A HARD-CODED EXPECTATION
 * Asserting `lime` for Read here would pass while the trace row moved to a
 * different palette, which is precisely the drift that produced the bug. So the
 * assertions compare the activity chip against a REAL `CollapsibleTrace` row
 * rendered from the same tool call, plus against `getCategoryColor` — the shared
 * source both consult. A future palette change moves all three together or fails.
 *
 * WHAT IS NOT ASSERTED
 * No Mantine-generated class names: they are build artefacts. What is compared is
 * the ThemeIcon's declared size + colour + the glyph identity, which is what a
 * reader actually sees.
 *
 * linkedom has no cascade, so `getComputedStyle` cannot resolve Mantine's CSS
 * variables to colours. The declared `--ti-color`/`data-variant` pair IS the
 * contract — it is what the component writes and what the stylesheet consumes — so
 * the assertions read it off the element, exactly as the row's other structural
 * tests do.
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

const { SubagentActivityRow } = await import("./SubagentCard");
const { CollapsibleTrace, TRACE_ICON_SLOT_SIZE } = await import("./CollapsibleTrace");
const { getCategory, getCategoryColor, getCategoryIcon } = await import("./ToolCallCard");
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

/**
 * The one chip of whichever row was rendered.
 *
 * Both the activity row and a trace row put their chip in the trace ICON LANE
 * (`data-trace-icon-slot`), which is precisely the point: one selector finds both,
 * so the comparisons below cannot accidentally read two different marks.
 */
function rowChip(): HTMLElement {
	const slots = container?.querySelectorAll("[data-trace-icon-slot]") ?? [];
	// Exactly one per row: a second mark would be a duplicate affordance.
	expect(slots.length).toBe(1);
	const chip = (slots[0] as unknown as HTMLElement).firstElementChild;
	if (!chip) throw new Error("category chip not rendered inside the icon slot");
	return chip as HTMLElement;
}

/**
 * The declarations that decide what the chip LOOKS like.
 *
 * Read generically (every attribute except React/Mantine-generated class names)
 * rather than from a hard-coded list of custom properties: the chip is a Mantine
 * `ThemeIcon` now, and pinning its internal variable names here would make this
 * suite fail on a Mantine version bump for a reason that has nothing to do with the
 * invariant. Whatever it writes, the two rows must write the SAME thing.
 */
function chipAppearance(el: HTMLElement) {
	const attributes: Record<string, string> = {};
	for (const name of el.getAttributeNames()) {
		// `class` carries Mantine's generated module hashes — a build artefact. Test ids
		// differ by call site by design.
		if (name === "class" || name.startsWith("data-testid")) continue;
		attributes[name] = el.getAttribute(name) ?? "";
	}
	const glyph = el.querySelector("svg");
	return {
		attributes,
		// Tabler stamps `tabler-icon-<name>` on the svg, which identifies the GLYPH
		// without depending on Mantine's class names.
		glyph: /tabler-icon-([a-z0-9-]+)/.exec(glyph?.getAttribute("class") ?? "")?.[1] ?? null,
		size: glyph?.getAttribute("width") ?? null,
	};
}

/** The declared Mantine colour of a chip, whichever attribute carries it. */
function chipColorSignature(el: HTMLElement): string {
	const style = el.getAttribute("style") ?? "";
	const color = el.getAttribute("data-color") ?? "";
	return `${color}|${style}`;
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
	test("declares the category's own colour rather than inheriting the row's", async () => {
		// The bug was a chip with NO colour of its own, inheriting the row's dimmed
		// text. A declared per-category colour is what distinguishes the fix from that
		// state; which attribute Mantine writes it into is its business, so the
		// assertion reads whatever the element declares.
		for (const { toolName, color } of CASES) {
			await render(toolName);
			expect(chipColorSignature(rowChip())).toContain(color);
		}
	});

	test("the colour is the one getCategoryColor answers for that tool", async () => {
		// Derived, not transcribed: the literals in CASES above are a readability aid,
		// this is the assertion that survives a palette change.
		for (const { toolName } of CASES) {
			await render(toolName);
			const expected = getCategoryColor(getCategory(toolName));
			expect(chipColorSignature(rowChip())).toContain(expected);
		}
	});

	test("different categories really do get different colours", async () => {
		// Guards the degenerate fix where every chip is tinted the same (a hard-coded
		// colour, or a fallback swallowing the lookup) — each assertion above would
		// still pass one at a time.
		const seen = new Set<string>();
		for (const { toolName } of CASES) {
			await render(toolName);
			seen.add(chipColorSignature(rowChip()));
		}
		expect(seen.size).toBe(CASES.length);
	});

	test("an unknown tool falls back to the generic colour rather than no colour", async () => {
		// A tool this frontend has never heard of is the case that used to look
		// identical to the bug (grey), so it needs the explicit assertion: grey is now
		// a real category tint, not an absence of one.
		await render("TotallyUnknownTool");
		const generic = getCategoryColor(getCategory("TotallyUnknownTool"));
		expect(chipColorSignature(rowChip())).toContain(generic);
	});

	test("the glyph is inset inside the chip, not drawn to its edge", async () => {
		// A 9px glyph in the 14px trace lane is what makes the tint read as a chip.
		// Equal numbers would render a tinted box tight around the icon — technically
		// coloured, visually a different mark from the trace row's.
		await render("Read");
		const size = Number(chipAppearance(rowChip()).size);
		expect(size).toBeGreaterThan(0);
		expect(size).toBeLessThan(TRACE_ICON_SLOT_SIZE);
	});
});

describe("activity row chip matches the folded TRACE row chip", () => {
	test("identical appearance for the same tool call", async () => {
		// The point of the whole change: not "the row has A colour" but "the row has the
		// SAME mark as the trace row it is now shaped like". Compared against a real
		// CollapsibleTrace render fed the same tool call, so glyph, size and tint are
		// held together — a change to the trace row that missed this one fails here.
		for (const { toolName } of CASES) {
			const call = toolCall(toolName);

			await renderNode(<SubagentActivityRow call={call} />);
			const rowAppearance = chipAppearance(rowChip());

			await renderNode(traceRowFor(call));
			const traceAppearance = chipAppearance(rowChip());

			expect(rowAppearance).toEqual(traceAppearance);
		}
	});

	test("the chip sits in the SAME lane, at the same reserved size", async () => {
		// Two chips can look identical while sitting in differently-sized lanes, which
		// would make the rows different heights — the other half of "same shape".
		for (const { toolName } of CASES) {
			const call = toolCall(toolName);

			await renderNode(<SubagentActivityRow call={call} />);
			const rowLane = laneGeometry();

			await renderNode(traceRowFor(call));
			expect(laneGeometry()).toEqual(rowLane);
			expect(rowLane.width).toBe(`${TRACE_ICON_SLOT_SIZE}px`);
		}
	});
});

/** The trace icon lane's reserved geometry (what pins the row's height). */
function laneGeometry() {
	const slots = container?.querySelectorAll("[data-trace-icon-slot]") ?? [];
	expect(slots.length).toBe(1);
	const lane = slots[0] as unknown as HTMLElement;
	return { width: lane.style.width, height: lane.style.height, minWidth: lane.style.minWidth };
}

/**
 * A real `CollapsibleTrace` row for one tool call, built exactly the way
 * `ActivityTrace` builds its rows (category → glyph + colour). Rendering the real
 * component — rather than restating the expected markup — is what makes this a
 * parity test instead of a snapshot of today's implementation.
 */
function traceRowFor(call: ToolCallData) {
	const category = getCategory(call.toolName);
	const Icon = getCategoryIcon(category, call.toolName);
	return (
		<CollapsibleTrace
			items={[
				{
					key: call.toolUseId ?? "row",
					icon: <Icon size={9} />,
					iconColor: getCategoryColor(category),
					title: call.toolName,
					body: null,
					status: call.status,
				},
			]}
			headerIcon={null}
			headerColor="gray"
			headerLabel="tools"
			headerCount="1"
			showEarlierLabel={() => "earlier"}
			hideEarlierLabel="hide"
		/>
	);
}

async function render(toolName: string) {
	await renderNode(<SubagentActivityRow call={toolCall(toolName)} />);
}
