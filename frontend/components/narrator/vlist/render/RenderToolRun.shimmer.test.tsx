/**
 * RenderToolRun.shimmer.test.tsx — a folded trace row PAINTS which of the five
 * shimmer states it is in.
 *
 * WHY THIS EXISTS
 * A folded row's only animation used to be a single neutral text shimmer meaning
 * "something here is live". Everything else was indistinguishable: a call that was
 * executing, one whose risk was being deliberated, one that had just succeeded and
 * one that had just FAILED all rendered the same. Dropping to a low LOD therefore
 * cost the reader the one thing a glance is for. The row now carries all five states
 * from `@shared/tool-shimmer`, which is what these tests pin.
 *
 * Two layers are covered:
 *   1. the STATIC class per status (renderToStaticMarkup — cheap and faithful,
 *      since a settled row's class is pure output of `measured.rows`);
 *   2. the TIMED closing sweep, which only exists across a status transition and so
 *      needs a live root (`act` + `createRoot`).
 *
 * The paired height-neutrality assertion lives in `measure-tool-run.test.ts`: the
 * shimmer must never move a row, which is why it recolours text instead of adding a
 * box (see `frontend/styles/trace-shimmer.css`).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MantineProvider } from "@mantine/core";
import { CARD_SHIMMER_CLASS, TRACE_SHIMMER_CLASS } from "@shared/tool-shimmer";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { measureActivityTrace } from "../measure/measure-tool-run";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { RenderToolRun } from "./RenderToolRun";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

const WIDTH = 700;

let parse: (html: string) => Element;

beforeAll(() => {
	const { window: win, document: doc } = parseHTML(
		"<!doctype html><html><body><div id='host'></div></body></html>",
	);
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = doc;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	if (typeof g.matchMedia !== "function") {
		g.matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		});
	}
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

interface RowInput {
	status?: string;
	shimmer?: boolean;
	title?: string;
	reflectionStatus?: string;
}

function traceOf(rows: RowInput[]) {
	return measureActivityTrace(
		rows.map((row, i) => ({
			title: row.title ?? `Read · file${i}.ts`,
			hasIcon: true,
			iconColor: "gray",
			key: `t-${i}`,
			...row,
		})),
		WIDTH,
	);
}

/** Static markup of a trace, parsed. */
function trace(rows: RowInput[]): Element {
	return parse(
		renderToStaticMarkup(
			<MantineProvider defaultColorScheme="dark">
				<RenderToolRun measured={traceOf(rows)} />
			</MantineProvider>,
		),
	);
}

/** Which of the five shimmer classes appear in a rendered trace, in document order. */
function shimmerClasses(root: Element): string[] {
	const found: string[] = [];
	for (const el of Array.from(root.querySelectorAll("[class]"))) {
		const cls = String((el as unknown as HTMLElement).getAttribute("class") ?? "");
		for (const name of Object.values(TRACE_SHIMMER_CLASS)) {
			if (cls.split(/\s+/).includes(name)) found.push(name);
		}
	}
	return found;
}

describe("a folded trace row paints its shimmer state", () => {
	it("sweeps NEUTRAL while the call's input is still streaming", () => {
		expect(shimmerClasses(trace([{ status: "streaming" }]))).toEqual([
			TRACE_SHIMMER_CLASS.streaming,
		]);
	});

	it("sweeps BLUE only while the call actually executes", () => {
		// The state that was entirely missing before: a folded row said nothing about
		// a tool actually running.
		expect(shimmerClasses(trace([{ status: "running" }]))).toEqual([TRACE_SHIMMER_CLASS.running]);
	});

	it("keeps `initializing` NEUTRAL rather than claiming execution", () => {
		// `initializing` means the arguments are in but the permission gate has not been
		// passed. Painting it blue is the bug: a row whose input was still arriving
		// animated exactly like one mid-execution.
		expect(shimmerClasses(trace([{ status: "initializing" }]))).toEqual([
			TRACE_SHIMMER_CLASS.streaming,
		]);
	});

	it("goes SILENT when the row is waiting on the user", () => {
		// `pending` is "awaiting a person" at every server write site. A folded row has no
		// permission-list side channel, so the silence has to come from the status — which
		// is exactly what used to make an approval prompt shimmer blue.
		expect(shimmerClasses(trace([{ status: "pending" }]))).toEqual([]);
	});

	it("sweeps PURPLE when a gate is deliberating about the row's tool", () => {
		// The disambiguation `pending` alone cannot express. A running gate parks its tool
		// at `pending`, so without the gate's own status the row would fall silent (the
		// "awaiting a person" reading) — wrong in the opposite direction from the blue it
		// used to show.
		expect(shimmerClasses(trace([{ status: "pending", reflectionStatus: "running" }]))).toEqual([
			TRACE_SHIMMER_CLASS.reflecting,
		]);
	});

	it("falls back to the tool's own phase once the gate resolves", () => {
		// Only a RUNNING gate is deliberating. A resolved one has handed control back, so
		// the tool's status decides again — otherwise a settled row would stay purple.
		expect(shimmerClasses(trace([{ status: "running", reflectionStatus: "confirmed" }]))).toEqual([
			TRACE_SHIMMER_CLASS.running,
		]);
		expect(
			shimmerClasses(trace([{ status: "pending", reflectionStatus: "awaiting_user" }])),
		).toEqual([]);
	});

	it("stays QUIET once a call has settled", () => {
		// A looping sweep on finished rows would make a whole folded history shimmer at
		// once — the animation has to mean "right now".
		for (const status of ["success", "completed", "fail", "cancelled"]) {
			expect(shimmerClasses(trace([{ status }]))).toEqual([]);
		}
	});

	it("stays QUIET for an unrecognised status instead of guessing", () => {
		// A provider can send a status this frontend has never heard of. Any sweep would
		// be a claim; nothing merely admits we do not know.
		for (const status of ["", "somethingNew"]) {
			expect(shimmerClasses(trace([{ status }]))).toEqual([]);
		}
	});

	it("keeps a REASONING row on the neutral sweep (it has no lifecycle)", () => {
		// Reasoning steps carry no status at all — the adapter marks the live one with
		// `shimmer`, and that must keep meaning "streaming" rather than falling silent.
		expect(shimmerClasses(trace([{ shimmer: true }]))).toEqual([TRACE_SHIMMER_CLASS.streaming]);
		expect(shimmerClasses(trace([{}]))).toEqual([]);
	});

	it("lets a real status OVERRIDE the caller's streaming marker", () => {
		// Both can legitimately be set on a live tool row (the adapter marks the latest
		// live item while the tool reports `running`). The status is the specific fact,
		// so blue must win over neutral — otherwise every live tool row reads as merely
		// "arriving".
		expect(shimmerClasses(trace([{ status: "running", shimmer: true }]))).toEqual([
			TRACE_SHIMMER_CLASS.running,
		]);
	});

	it("paints each row's OWN state, not its neighbour's", () => {
		// A positional mix-up would confidently animate a settled row as running. Read
		// as an ordered list rather than as a set.
		const root = trace([
			{ status: "running" },
			{ status: "success" },
			{ status: "streaming" },
			{ status: "fail" },
		]);
		expect(shimmerClasses(root)).toEqual([
			TRACE_SHIMMER_CLASS.running,
			TRACE_SHIMMER_CLASS.streaming,
		]);
	});

	it("separates the four in-flight phases in one fold", () => {
		// The whole point of the five states, read in one pass: only the executing row is
		// blue, the two pre-execution phases are neutral, and the one waiting on a person
		// is silent. Before this they were all blue.
		const root = trace([
			{ status: "initializing" },
			{ status: "pending" },
			{ status: "running" },
			{ status: "streaming" },
		]);
		expect(shimmerClasses(root)).toEqual([
			TRACE_SHIMMER_CLASS.streaming,
			TRACE_SHIMMER_CLASS.running,
			TRACE_SHIMMER_CLASS.streaming,
		]);
	});
});

/**
 * The row shimmer is a gradient CLIPPED TO TEXT, and these tests exist because
 * getting that wrong is not subtle — it is catastrophic and it already happened.
 *
 * The failure: a per-state rule written with the `background` shorthand resets every
 * background longhand it omits, including the `background-clip: text` and
 * `background-size` declared in the shared rule above it. The gradient then paints
 * the whole row box while `-webkit-text-fill-color: transparent` keeps the glyphs
 * invisible — so instead of shimmering text the reader gets a SOLID GREY BAR with a
 * coloured blob sliding through it, and the row's actual content is gone.
 *
 * No class-name assertion can see this: the markup is identical either way. The
 * check has to be on the stylesheet, which is also where the DiffBody tests put
 * their palette contract for the same reason.
 */
describe("the row shimmer keeps its gradient clipped to the text", () => {
	const traceCss = readFileSync(
		join(import.meta.dir, "..", "..", "..", "..", "styles", "trace-shimmer.css"),
		"utf8",
	);
	const cardCss = readFileSync(
		join(import.meta.dir, "..", "..", "..", "..", "styles", "card-shimmer.css"),
		"utf8",
	);

	it("declares every state's gradient with `background-image`, never the shorthand", () => {
		// The shorthand is what un-clips the gradient and blanks the row (see above).
		const shorthand = /^\s*background:\s/m;
		expect(shorthand.test(traceCss)).toBe(false);
		// The card sweep is a separate carrier whose shared rule sets no background
		// longhands, so a shorthand there is currently harmless — held to the same rule
		// anyway, so that adding one later cannot quietly become a live trap.
		expect(shorthand.test(cardCss)).toBe(false);
	});

	it("gives every trace class both a gradient and the text clip", () => {
		// A class present in the table but absent from the stylesheet renders a row with
		// NO shimmer; one with a gradient but no clip renders the solid-bar failure.
		for (const name of Object.values(TRACE_SHIMMER_CLASS)) {
			expect(traceCss).toContain(`.${name}`);
			// Its own gradient…
			expect(new RegExp(`\\.${name}\\s*\\{[^}]*background-image:`).test(traceCss)).toBe(true);
		}
		// …and the clip, applied once to the whole set.
		expect(traceCss).toContain("background-clip: text");
		expect(traceCss).toContain("-webkit-text-fill-color: transparent");
	});

	it("gives every card class an ::after overlay gradient", () => {
		// The card carrier's mirror check: a missing rule means a silently unlit card.
		for (const name of Object.values(CARD_SHIMMER_CLASS)) {
			expect(cardCss).toContain(`.${name}`);
			expect(new RegExp(`\\.${name}::after\\s*\\{[^}]*background-image:`).test(cardCss)).toBe(true);
		}
	});

	it("still paints the row's TEXT when it shimmers", () => {
		// The user-visible symptom, asserted directly: the words must survive. A blanked
		// row keeps its class and its height, so this is the only check that speaks to
		// what the reader actually loses.
		const root = trace([{ status: "running", title: "Read · shimmering.ts" }]);
		expect(root.textContent ?? "").toContain("Read · shimmering.ts");
	});

	it("restores the text fill under reduced motion", () => {
		// Dropping only the animation would freeze the gradient mid-sweep and leave the
		// row permanently half-transparent — a stationary version of the same bug.
		const reduced = traceCss.slice(traceCss.indexOf("prefers-reduced-motion"));
		expect(reduced).toContain("-webkit-text-fill-color: currentColor");
		for (const name of Object.values(TRACE_SHIMMER_CLASS)) {
			expect(reduced).toContain(`.${name}`);
		}
	});
});

/**
 * COLOUR IS NOT ENOUGH, and neither is a click handler on a div.
 *
 * The five shimmer states raised how much a folded row says, but colour was their only
 * carrier: a colour-blind reader cannot tell the green sweep from the red one, and a
 * screen reader is told nothing at all. Likewise every fold here is a `Group` (a div)
 * with an `onClick` — no role, no tab stop, no announced expanded state, so the whole
 * fold hierarchy was keyboard-unreachable.
 *
 * All of it is ATTRIBUTES, which is why it is free: the paired height assertions live
 * in `measure-tool-run.test.ts` ("the five-state SHIMMER cannot move the row").
 */
describe("a folded trace row is reachable without colour or a mouse", () => {
	function expandableTrace(): Element {
		const measured = measureActivityTrace(
			[
				{
					title: "Read · file.ts",
					hasIcon: true,
					iconColor: "gray",
					key: "t-0",
					// `canDrillDown` rather than a markdown `body`: it makes the row
					// expandable without measuring any prose, which keeps this block about
					// the row's attributes alone.
					canDrillDown: true,
					status: "running",
				},
			],
			WIDTH,
		);
		return parse(
			renderToStaticMarkup(
				<MantineProvider defaultColorScheme="dark">
					<RenderToolRun measured={measured} onToggleRow={() => {}} />
				</MantineProvider>,
			),
		);
	}

	it("gives an expandable row a button role, a tab stop and an expanded state", () => {
		const row = expandableTrace().querySelector('[role="button"][aria-expanded]');
		expect(row).not.toBeNull();
		expect(row?.getAttribute("tabindex")).toBe("0");
		expect(row?.getAttribute("aria-expanded")).toBe("false");
	});

	it("NAMES the shimmer state so it is not colour-only", () => {
		// The row above is `running`; its accessible name must say so.
		const row = expandableTrace().querySelector('[role="button"][aria-label]');
		expect(row?.getAttribute("aria-label") ?? "").toContain("running");
		expect(row?.getAttribute("title") ?? "").toContain("running");
	});

	it("uses the caller's localized state names when supplied", () => {
		// The render layer stays i18n-free: the names arrive through `labels`.
		const measured = measureActivityTrace(
			[{ title: "Read · file.ts", hasIcon: true, iconColor: "gray", key: "t-0", status: "fail" }],
			WIDTH,
		);
		const root = parse(
			renderToStaticMarkup(
				<MantineProvider defaultColorScheme="dark">
					<RenderToolRun measured={measured} labels={{ shimmerState: { failed: "已失败" } }} />
				</MantineProvider>,
			),
		);
		// A settled `fail` row paints no shimmer, so nothing is named — the label only
		// describes a state the row is actually IN.
		expect(root.querySelector("[aria-label]")).toBeNull();

		const live = measureActivityTrace(
			[
				{
					title: "Read · file.ts",
					hasIcon: true,
					iconColor: "gray",
					key: "t-0",
					status: "pending",
					reflectionStatus: "running",
				},
			],
			WIDTH,
		);
		const liveRoot = parse(
			renderToStaticMarkup(
				<MantineProvider defaultColorScheme="dark">
					<RenderToolRun measured={live} labels={{ shimmerState: { reflecting: "正在审查" } }} />
				</MantineProvider>,
			),
		);
		expect(liveRoot.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "").toContain(
			"正在审查",
		);
	});

	it("leaves a NON-expandable row out of the tab order", () => {
		// A plain dot row does nothing when activated; giving it a tab stop would make
		// walking a long fold a sequence of dead stops.
		const measured = measureActivityTrace(
			[{ title: "Read · file.ts", hasIcon: true, iconColor: "gray", key: "t-0" }],
			WIDTH,
		);
		const root = parse(
			renderToStaticMarkup(
				<MantineProvider defaultColorScheme="dark">
					<RenderToolRun measured={measured} />
				</MantineProvider>,
			),
		);
		expect(root.querySelector('[role="button"]')).toBeNull();
	});
});

describe("the one-shot closing sweep", () => {
	/** Mount a trace, then re-render it with new row statuses. */
	function mountThenUpdate(before: RowInput[], after: RowInput[]): { classes: string[] } {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const reactRoot = createRoot(host);
		const draw = (rows: RowInput[]) => (
			<MantineProvider defaultColorScheme="dark">
				<RenderToolRun measured={traceOf(rows)} />
			</MantineProvider>
		);
		act(() => {
			reactRoot.render(draw(before));
		});
		act(() => {
			reactRoot.render(draw(after));
		});
		const classes = shimmerClasses(host as unknown as Element);
		act(() => {
			reactRoot.unmount();
		});
		host.remove();
		return { classes };
	}

	it("flashes GREEN when a running row reaches success", () => {
		expect(mountThenUpdate([{ status: "running" }], [{ status: "success" }]).classes).toEqual([
			TRACE_SHIMMER_CLASS.success,
		]);
	});

	it("flashes RED when a running row fails", () => {
		// The distinction that motivated this whole change: a failure in a fold used to
		// look exactly like a success.
		expect(mountThenUpdate([{ status: "running" }], [{ status: "fail" }]).classes).toEqual([
			TRACE_SHIMMER_CLASS.failed,
		]);
	});

	it("does NOT flash on a fresh mount that is already settled", () => {
		// The invariant that keeps scrolling quiet: virtual-list rows mount constantly,
		// so a mount-triggered flash would light up whole screens of old history.
		expect(mountThenUpdate([{ status: "success" }], [{ status: "success" }]).classes).toEqual([]);
	});

	it("does NOT flash on cancellation", () => {
		// The user stopped it. That is not a failure to report back to them, and it
		// already carries its own orange ban glyph.
		expect(mountThenUpdate([{ status: "running" }], [{ status: "cancelled" }]).classes).toEqual([]);
	});

	/**
	 * The stale-flash regression, which was the one user-visible wrong BEHAVIOUR here.
	 *
	 * A flash is cleared by a 650ms timer that the effect's own cleanup tears down on
	 * the next status change. So when a live `phase` outranked a flash (a retry landing
	 * inside the window), the flash stayed in state with no timer left to clear it —
	 * and the next status that produced neither a phase nor a new flash UNCOVERED it.
	 * The reader then saw a sweep for a transition that must not have one.
	 */
	function mountThenUpdateSequence(sequence: RowInput[][]): string[] {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const reactRoot = createRoot(host);
		const draw = (rows: RowInput[]) => (
			<MantineProvider defaultColorScheme="dark">
				<RenderToolRun measured={traceOf(rows)} />
			</MantineProvider>
		);
		for (const rows of sequence) {
			act(() => {
				reactRoot.render(draw(rows));
			});
		}
		const classes = shimmerClasses(host as unknown as Element);
		act(() => {
			reactRoot.unmount();
		});
		host.remove();
		return classes;
	}

	it("does not replay a covered RED flash when the row later cancels", () => {
		// running → fail → running → cancelled. The red flash was covered by the retry's
		// blue phase; on `cancelled` the row went quiet AND the buried red re-appeared —
		// claiming a failure for a stop the user asked for, the very transition
		// `resolveToolShimmerOutcome` refuses to flash.
		expect(
			mountThenUpdateSequence([
				[{ status: "running" }],
				[{ status: "fail" }],
				[{ status: "running" }],
				[{ status: "cancelled" }],
			]),
		).toEqual([]);
	});

	it("does not replay a covered GREEN flash when the row later awaits the user", () => {
		// running → success → running → pending. `pending` is "waiting on a person", the
		// one state that must be silent; instead it lit up green from two states ago.
		expect(
			mountThenUpdateSequence([
				[{ status: "running" }],
				[{ status: "success" }],
				[{ status: "running" }],
				[{ status: "pending" }],
			]),
		).toEqual([]);
	});

	it("still flashes for the LATEST outcome after a retry", () => {
		// The other half of the same fix: clearing the stale flash must not suppress a
		// genuine one. running → fail → running → success flashes GREEN, not red.
		expect(
			mountThenUpdateSequence([
				[{ status: "running" }],
				[{ status: "fail" }],
				[{ status: "running" }],
				[{ status: "success" }],
			]),
		).toEqual([TRACE_SHIMMER_CLASS.success]);
	});

	it("prefers a resumed live phase over a pending flash", () => {
		// A retry can land inside the 650ms flash window. What the call is doing NOW is
		// the more useful thing to show than what the previous attempt ended as.
		const host = document.createElement("div");
		document.body.appendChild(host);
		const reactRoot = createRoot(host);
		const draw = (rows: RowInput[]) => (
			<MantineProvider defaultColorScheme="dark">
				<RenderToolRun measured={traceOf(rows)} />
			</MantineProvider>
		);
		act(() => {
			reactRoot.render(draw([{ status: "running" }]));
		});
		act(() => {
			reactRoot.render(draw([{ status: "fail" }]));
		});
		expect(shimmerClasses(host as unknown as Element)).toEqual([TRACE_SHIMMER_CLASS.failed]);
		act(() => {
			reactRoot.render(draw([{ status: "running" }]));
		});
		expect(shimmerClasses(host as unknown as Element)).toEqual([TRACE_SHIMMER_CLASS.running]);
		act(() => {
			reactRoot.unmount();
		});
		host.remove();
	});
});
