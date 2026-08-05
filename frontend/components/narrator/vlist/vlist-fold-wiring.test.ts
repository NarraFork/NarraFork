/**
 * vlist-fold-wiring.test.ts — Source-level guard for the fold transition's wiring.
 *
 * The pure planner and the WAAPI edge are covered by their own unit tests. What
 * neither can see is WHERE the two halves are called from, and that is where every
 * failure mode of a FLIP lives:
 *
 *  - capture in the click handler (before the state change), not in an effect;
 *  - play in a LAYOUT effect (before paint), not a passive one;
 *  - the play must not consume its capture on the pre-rebuild commit;
 *  - the row must carry a key attribute the controller can resolve;
 *  - nothing may leak into the measured height model.
 *
 * These are assertions on the shell source because the failure mode is silent: the
 * fold still works, it just stops animating (or animates the wrong thing), and no
 * unit test on the pure functions would notice.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;

function read(relativePath: string): string {
	return readFileSync(join(DIR, relativePath), "utf8");
}

const SHELL = read("PretextExactMessageList.tsx");

/** The body of the shell's fold-play layout effect. */
function playEffect(): string {
	const start = SHELL.indexOf("const capture = foldCaptureRef.current;");
	expect(start).toBeGreaterThan(0);
	const end = SHELL.indexOf("foldMotionRef.current.play(", start);
	expect(end).toBeGreaterThan(start);
	return SHELL.slice(start, SHELL.indexOf("\t});", end));
}

describe("fold transition: capture happens on the user's click", () => {
	it("captures BEFORE the interaction state change, in every fold toggle", () => {
		// A capture taken after setInteraction would read the state the fold is about
		// to invalidate; taken in an effect it would read the post-rebuild geometry and
		// the delta would always be zero.
		const start = SHELL.indexOf("const getRowToggles = useCallback(");
		const end = SHELL.indexOf("togglesCacheRef.current.set(key, toggles);", start);
		const block = SHELL.slice(start, end);
		expect(block.length).toBeGreaterThan(0);

		// Every handler that changes a HEIGHT-AFFECTING fold must capture first.
		for (const handler of [
			"onToggle:",
			"onToggleItems:",
			"onToggleEarlier:",
			"onToggleRow:",
			"onTogglePrompt:",
		]) {
			const handlerStart = block.indexOf(handler);
			expect(handlerStart, `${handler} is missing from the toggles`).toBeGreaterThan(0);
			const body = block.slice(handlerStart, block.indexOf("},", handlerStart));
			const captureAt = body.indexOf("captureFoldBefore(key)");
			const setAt = body.indexOf("setInteraction(");
			expect(captureAt, `${handler} must capture the pre-fold geometry`).toBeGreaterThan(-1);
			expect(setAt, `${handler} must change interaction state`).toBeGreaterThan(-1);
			expect(captureAt, `${handler} must capture BEFORE setInteraction`).toBeLessThan(setAt);
		}
	});

	it("does not capture for a height-neutral toggle", () => {
		// The translation flip re-measures the body but is not a fold; giving it a
		// capture would animate a content swap as if it were an expand.
		const start = SHELL.indexOf("onToggleTranslation:");
		const body = SHELL.slice(start, SHELL.indexOf("},", start));
		expect(body).not.toContain("captureFoldBefore");
	});

	it("reads the layout, never the DOM, when capturing", () => {
		const start = SHELL.indexOf("const captureFoldBefore = useCallback(");
		const body = SHELL.slice(start, SHELL.indexOf("}, []);", start));
		expect(body.length).toBeGreaterThan(0);
		// getBoundingClientRect on every mounted row inside a click handler would force
		// a synchronous layout for offsets the pure layout already knows exactly.
		expect(body).not.toContain("getBoundingClientRect");
		expect(body).not.toContain("offsetHeight");
	});

	it("skips the capture entirely under reduced motion", () => {
		const start = SHELL.indexOf("const captureFoldBefore = useCallback(");
		const body = SHELL.slice(start, SHELL.indexOf("}, []);", start));
		// No capture ⇒ the play effect finds nothing ⇒ the fold applies instantly.
		expect(body).toContain("prefersReducedMotion()");
	});
});

describe("fold transition: play happens before paint", () => {
	it("plays from a LAYOUT effect so the jumped-to state is never painted", () => {
		// A passive effect runs AFTER paint: the reader would see the new geometry for
		// one frame and then watch it animate back — a flicker, not a transition.
		const marker = "const capture = foldCaptureRef.current;";
		const before = SHELL.slice(0, SHELL.indexOf(marker));
		expect(before.slice(before.lastIndexOf("useLayoutEffect("))).toContain("useLayoutEffect(");
		expect(before.lastIndexOf("useLayoutEffect(")).toBeGreaterThan(
			before.lastIndexOf("useEffect("),
		);
	});

	it("keeps the capture when there is nothing to play yet", () => {
		// setInteraction re-renders FIRST; the document rebuild lands in a later commit.
		// Consuming the capture on that first (geometry-unchanged) commit is what made
		// an earlier version never animate at all.
		const body = playEffect();
		const emptyGuard = body.indexOf("if (motions.length === 0) return;");
		const consume = body.indexOf("foldCaptureRef.current = null;\n\t\tfoldMotionRef");
		expect(emptyGuard).toBeGreaterThan(-1);
		expect(consume).toBeGreaterThan(emptyGuard);
	});

	it("validates the capture against the committed document revision", () => {
		// A live WS patch / older page between click and commit must invalidate it, or
		// the FLIP animates a change the reader did not make.
		const body = playEffect();
		expect(body).toContain("isFoldCaptureUsable(");
		expect(body).toContain("foldRevisionOf(foldDocumentRevision)");
	});

	it("plans in viewport coordinates, using the LIVE scrollTop", () => {
		// The anchored rebuild may have absorbed the whole document shift into
		// scrollTop, in which case nothing moved on screen and nothing should animate.
		// React state lags the correction (also written in a layout effect).
		const body = playEffect();
		expect(body).toContain("beforeScrollTop: capture.scrollTop");
		expect(body).toContain("afterScrollTop: node.scrollTop");
	});

	it("resolves a planned row by its spec-key attribute", () => {
		expect(SHELL).toContain("data-nf-row-key={item.spec.key}");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the shell's selector source verbatim
		expect(SHELL).toContain('[data-nf-row-key="${cssAttrEscape(key)}"]');
	});

	it("cancels in-flight animations on unmount", () => {
		// A fold outlives its click: the reader can scroll away or switch narrator.
		const start = SHELL.indexOf("const controller = foldMotionRef.current;");
		expect(start).toBeGreaterThan(0);
		expect(SHELL.slice(start, start + 200)).toContain("controller.cancel()");
	});
});

describe("fold transition: stays out of the height model", () => {
	it("animates only composited properties", () => {
		// Scoped to the keyframe builders: `height` would feed back into layout and
		// could perturb a measured row, and `top` would fight the absolute positioning
		// the layout owns. (Elsewhere in the module `height`/`top` legitimately appear
		// as the CAPTURED geometry, which is read, never animated.)
		const motion = read("vlist-fold-motion.ts");
		for (const builder of ["function shiftKeyframes(", "function revealKeyframes("]) {
			const start = motion.indexOf(builder);
			expect(start, `${builder} is missing`).toBeGreaterThan(0);
			const body = motion.slice(start, motion.indexOf("\n}", start));
			expect(body).not.toContain("height:");
			expect(body).not.toContain("top:");
			expect(body).not.toContain("margin");
			expect(body).not.toContain("padding");
		}
		expect(motion).toContain("clipPath");
		expect(motion).toContain("transform");
	});

	it("keeps the fold out of React state and the measurement cache", () => {
		// A ref, like the jump highlight: state would invalidate every row's memo for a
		// decoration, and would make a visual concern part of the render that produces
		// the geometry being animated.
		expect(SHELL).toContain("const foldCaptureRef = useRef<");
		expect(SHELL).toContain("const foldMotionRef = useRef(createFoldMotionController())");
		expect(SHELL).not.toContain("setFoldCapture");
		expect(SHELL).not.toContain("useState(createFoldMotionController");
	});

	it("keeps the row-key attribute height-neutral", () => {
		// It rides on the same element as data-nf-unit — a data attribute, so it cannot
		// affect layout, and it must NOT be threaded through spec.opts (the measure
		// cache key).
		const rowStart = SHELL.indexOf("data-nf-row-key={item.spec.key}");
		const style = SHELL.indexOf("style={{", rowStart);
		expect(rowStart).toBeGreaterThan(0);
		expect(style).toBeGreaterThan(rowStart);
		expect(SHELL.slice(rowStart, style)).not.toContain("height");
	});

	it("does not add the fold to the dynamic (post-paint measured) row path", () => {
		const block = SHELL.slice(
			SHELL.indexOf("const dynamicRowKeys = useMemo("),
			SHELL.indexOf("const effectiveHeightOverrides"),
		);
		expect(block.length).toBeGreaterThan(0);
		expect(block).not.toContain("fold");
		expect(block).not.toContain("Fold");
	});
});
