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

import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NarratorMsg } from "../narrator-panel-types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextDocumentLayout } from "./pretext-document-layout";
import { createVListInteractionState, toggleVListLodUserOverride } from "./vlist-interaction-state";

const DIR = import.meta.dir;

function read(relativePath: string): string {
	return readFileSync(join(DIR, relativePath), "utf8");
}

const SHELL = read("PretextExactMessageList.tsx");

beforeAll(() => {
	installCanvasStub();
});

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
		const emptyGuard = body.indexOf(
			"if (motions.length === 0 && frameMotions.length === 0) return;",
		);
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
		expect(body).toContain("node.scrollTop");
	});

	it("PREDICTS the scroll target while pinned to the bottom instead of reading it", () => {
		// The one case where the live value is NOT what the reader will see. Pinned at
		// the bottom, the viewport is pushed back to the end of the content by two
		// writers, neither of which has necessarily run by this effect: the anchored
		// "bottom" correction is skipped when its computed value did not change, and the
		// geometry-revision pin effect writes in the NEXT frame (a passive effect + rAF).
		// Reading `node.scrollTop` there plans the FLIP from a position about to be
		// corrected, so expanding a card at the bottom started off by the growth it was
		// answering (see the animation test's post-correction case).
		//
		// getScrollBottomTarget is exactly what both writers converge on and is already
		// correct here, because React committed the canvas's new height before this ran.
		const body = playEffect();
		expect(body).toContain(
			"const afterScrollTop = pinnedToBottom ? getScrollBottomTarget(node) : node.scrollTop;",
		);
		// One value, both plans: two scroll pairs would let a border animate from a box
		// its own cards never occupied.
		expect(body.match(/afterScrollTop,/g)?.length).toBe(2);
		// And it must NOT go back to reading the raw value for either plan.
		expect(body).not.toContain("afterScrollTop: node.scrollTop");
	});

	it("resolves the anchored scroll correction BEFORE the fold play effect", () => {
		// The implicit contract that makes `afterScrollTop` meaningful at all, and the
		// only one nothing else can catch.
		//
		// `usePretextDocument` applies the anchored rebuild's scroll correction in its own
		// useLayoutEffect. Within one component, layout effects run in DECLARATION order,
		// so the correction lands before this play effect purely because the hook call
		// sits above it. Move the call below and every fold silently plans from an
		// uncorrected scrollTop — rows slide by the anchor's own Δ, which is the exact
		// artifact the viewport-coordinate arithmetic exists to remove, and no unit test
		// on the pure planner or the WAAPI edge would notice.
		const hookCall = SHELL.indexOf("const pretextDocument = usePretextDocument(narratorId, {");
		const playMarker = SHELL.indexOf("const capture = foldCaptureRef.current;");
		expect(hookCall, "usePretextDocument call site is missing").toBeGreaterThan(0);
		expect(playMarker, "fold play effect marker is missing").toBeGreaterThan(0);
		expect(
			hookCall,
			"usePretextDocument must be called BEFORE the fold play effect (layout effects run in declaration order)",
		).toBeLessThan(playMarker);
		// The reason is load-bearing, so it is stated at the call site rather than left
		// for the next reader to rediscover from this test's failure.
		expect(SHELL.slice(0, hookCall)).toContain("FOLD-ORDER MARKER");
	});

	it("keeps the correction itself in a LAYOUT effect", () => {
		// The ordering above only buys anything while the correction is synchronous with
		// the commit. A passive effect there would paint the uncorrected position for one
		// frame AND run after this play effect, so the guard would pass while the value
		// it protects went stale.
		const hook = read("usePretextDocument.ts");
		const start = hook.indexOf("options.onScrollTopCorrection?.(");
		expect(start, "the scroll correction call is missing").toBeGreaterThan(0);
		const before = hook.slice(0, start);
		expect(before.lastIndexOf("useLayoutEffect(")).toBeGreaterThan(
			before.lastIndexOf("useEffect("),
		);
	});

	it("resolves a planned row by its spec-key attribute", () => {
		expect(SHELL).toContain("data-nf-row-key={item.spec.key}");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the shell's selector source verbatim
		expect(SHELL).toContain('[data-nf-row-key="${cssAttrEscape(key)}"]');
	});

	it("resolves a planned grouping frame by its own key attribute", () => {
		// The decorative border is a SIBLING of the rows, not one of them: it has no
		// spec.key and never enters the mounted-row window, so without its own
		// addressable attribute the controller cannot reach it and the border stays at
		// its committed box while the cards inside it animate.
		expect(SHELL).toContain("data-tool-run-frame={run.key}");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the shell's selector source verbatim
		expect(SHELL).toContain('[data-tool-run-frame="${cssAttrEscape(key)}"]');
	});

	it("keys a frame by content, not by item index", () => {
		// An index is not an identity: a fold earlier in the document renumbers every
		// run after it, so an index-keyed frame would be paired with a DIFFERENT run's
		// geometry across the very rebuild this transition diffs.
		const start = SHELL.indexOf("export function computeToolRunFrames(");
		const body = SHELL.slice(start, SHELL.indexOf("\n}", start));
		expect(start).toBeGreaterThan(0);
		expect(body).toContain("items[i]?.spec.key");
	});

	it("plans frames from the SAME snapshot and scroll pair as the rows", () => {
		// Two snapshots taken at different moments is how a border ends up animating
		// from a box its contents never occupied.
		const body = playEffect();
		expect(body).toContain("planFoldFrameMotion({");
		expect(body).toContain("before: capture.frames");
		expect(body).toContain("after: read.frames");
		// One read call serves both plans.
		expect(body).toContain("const read = readFoldGeometryRef.current?.();");
		// The frame plan must not be gated away by the row plan being empty.
		expect(body).toContain("if (motions.length === 0 && frameMotions.length === 0) return;");
	});

	it("captures row and frame geometry in one snapshot", () => {
		// A frame's border is only correct while it agrees with the cards inside it, so
		// both maps must come from the same read of the committed layout.
		const start = SHELL.indexOf("readFoldGeometryRef.current = () => {");
		const body = SHELL.slice(start, SHELL.indexOf("\n\t};", start));
		expect(start).toBeGreaterThan(0);
		expect(body).toContain("captureFoldGeometry(");
		expect(body).toContain("captureFoldFrameGeometry(");
		// Derived from the layout, never measured off the border element itself.
		expect(body).not.toContain("getBoundingClientRect");
	});

	it("cancels in-flight animations on unmount", () => {
		// A fold outlives its click: the reader can scroll away or switch narrator.
		const start = SHELL.indexOf("const controller = foldMotionRef.current;");
		expect(start).toBeGreaterThan(0);
		expect(SHELL.slice(start, start + 200)).toContain("controller.cancel()");
	});
});

describe("fold transition: stays out of the height model", () => {
	it("animates only composited properties on ROWS", () => {
		// Scoped to the row keyframe builders: `height` would feed back into layout and
		// could perturb a measured row, and `top` would fight the absolute positioning
		// the layout owns. (Elsewhere in the module `height`/`top` legitimately appear
		// as the CAPTURED geometry, which is read, never animated — and in the frame
		// builder, which is decoration; see the frame test below.)
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

	it("confines the layout-animating FRAME builder to top/height", () => {
		// The one deliberate exception, and it must stay narrow. A frame is absolutely
		// positioned, pointer-events-none decoration with no in-flow siblings and no
		// measured height, so its top/height cannot reflow or perturb anything — but a
		// margin/padding write, or a transform racing the layout properties, would stop
		// being that contained. (`scaleY` is rejected for a different reason: it smears
		// the 1px border and its radius.)
		const motion = read("vlist-fold-motion.ts");
		const start = motion.indexOf("function frameKeyframes(");
		expect(start, "frameKeyframes is missing").toBeGreaterThan(0);
		const body = motion.slice(start, motion.indexOf("\n}", start));
		expect(body).toContain("top:");
		expect(body).toContain("height:");
		expect(body).not.toContain("transform");
		expect(body).not.toContain("margin");
		expect(body).not.toContain("padding");
		expect(body).not.toContain("width");
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

/**
 * Why the fold and the LOD morph cannot collide, as an invariant rather than a
 * coincidence.
 *
 * Both controllers write `transform` on the SAME element: a row carries
 * `data-nf-row-key` and `data-nf-unit` on one node, the fold resolves the first and
 * the LOD morph the second. Two WAAPI animations on one property, from two
 * controllers with independent cancel boundaries, would fight and land at an
 * arbitrary offset.
 *
 * They are mutually exclusive because their admission gates cannot both open in one
 * commit: the LOD morph requires the effective `lod` to have MOVED (with the document
 * revision unchanged), and no fold path changes it. The one path where that is not
 * self-evident is the `collapsesByLod` branch of `onToggle`, which both captures a
 * fold AND dispatches `toggleVListLodUserOverride`. Its name suggests a level change;
 * these tests establish that it is not one.
 */
describe("fold vs LOD morph: the toggle path cannot move the effective LOD", () => {
	function toolMessage(id: string, seq: number): NarratorMsg {
		return {
			id,
			narratorId: "n1",
			seq,
			role: "assistant",
			contentJson: [
				{
					type: "tool_use",
					id: `tu-${id}`,
					name: "Read",
					input: { file_path: `/workspace/${id}.ts` },
					inputJson: { file_path: `/workspace/${id}.ts` },
					status: "completed",
				},
			],
			contentText: null,
			toolCalls: [
				{
					toolUseId: `tu-${id}`,
					toolName: "Read",
					inputJson: { file_path: `/workspace/${id}.ts` },
					status: "completed",
				},
			],
			children: [],
			parentToolUseId: null,
			createdAt: "2026-07-23T00:00:00.000Z",
		} as unknown as NarratorMsg;
	}

	const MESSAGES = [toolMessage("m0", 0), toolMessage("m1", 1)];

	/** Build at L4 (where `collapsesByLod` is set) with a given override set applied. */
	function buildWithOverrides(overrides: ReadonlySet<string>) {
		return buildPretextDocumentLayout(MESSAGES, {
			layoutRevision: "fold-lod-invariant",
			documentRevision: 1,
			lod: 4,
			widthBucket: "860",
			contentWidth: 860,
			topPadding: 16,
			bottomPadding: 16,
			gap: 4,
			isLodUserOverride: (key) => overrides.has(key),
		});
	}

	it("routes the override branch through interaction state only, never through lod", () => {
		// `toggleVListLodUserOverride` moves ONE key in/out of `lodUserOverrides`. It
		// does not touch `state.lod` — which is what `activeInteraction` compares against
		// the context level, and therefore the only thing that could re-derive the build.
		const state = createVListInteractionState(4);
		const toggled = toggleVListLodUserOverride(state, "tool-tu-m0");
		expect(toggled.lod).toBe(state.lod);
		expect([...toggled.lodUserOverrides]).toEqual(["tool-tu-m0"]);
		// And back, still without touching the level.
		const untoggled = toggleVListLodUserOverride(toggled, "tool-tu-m0");
		expect(untoggled.lod).toBe(4);
		expect([...untoggled.lodUserOverrides]).toEqual([]);
	});

	it("rebuilds the document at the SAME manifest.lod after the override flips", () => {
		// The value the LOD morph's gate actually reads (`pretextDocument.manifest?.lod`).
		// The override reaches the build as `isLodUserOverride`, a per-key opt consumed
		// while adapting one card; `manifest.lod` comes from the build option the shell
		// takes straight from `useRenderLod()`, which only a zoom step / gesture moves.
		const before = buildWithOverrides(new Set());
		const after = buildWithOverrides(new Set(["tool-tu-m0"]));
		expect(before.manifest.lod).toBe(4);
		expect(after.manifest.lod).toBe(4);
		// The lod is UNCHANGED while the geometry genuinely moved, which is exactly the
		// combination that keeps the two morphs disjoint: the fold has a capture and
		// plays, the LOD morph sees no level change and returns early.
		expect(after.manifest.items).not.toEqual(before.manifest.items);
	});

	it("gates the LOD morph on a level MOVE, so a fold-only rebuild plays nothing", () => {
		// The other half of the exclusion, asserted at the shell: were this gate ever
		// relaxed to "any rebuild", the override toggle above would satisfy it and both
		// controllers would write `transform` on the same node in one commit.
		const start = SHELL.indexOf("const isLodSwitch =");
		expect(start, "the LOD-switch gate is missing").toBeGreaterThan(0);
		const body = SHELL.slice(start, SHELL.indexOf(";", start));
		expect(body).toContain("lodMorphDocRevRef.current === docRev");
		expect(body).toContain("lodMorphLodRef.current !== lod");
	});

	it("states the exclusion at the toggle branch that looks like a level change", () => {
		// The comment is the only thing that stops a future reader from "fixing" this
		// branch into an actual lod step (or adding a second one that is), which would
		// make the two controllers collide with no test necessarily catching it.
		const start = SHELL.indexOf("if (collapsesByLodByKeyRef.current.get(key) === true) {");
		expect(start, "the collapsesByLod toggle branch is missing").toBeGreaterThan(0);
		// Scoped to the branch's own comment block: from the handler it lives in, so a
		// note attached to some other toggle cannot satisfy this.
		const handler = SHELL.lastIndexOf("onToggle: () => {", start);
		expect(handler, "the onToggle handler is missing").toBeGreaterThan(0);
		const context = SHELL.slice(handler, start);
		expect(context).toContain("NOT an LOD step");
		// And the consequence, not just the classification.
		expect(context).toContain("shared cancel boundary");
	});
});
