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
import { shellModule } from "./guard-source";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextDocumentLayout } from "./pretext-document-layout";
import { sliceBracketedRegion } from "./source-slice";
import { createVListInteractionState, toggleVListLodUserOverride } from "./vlist-interaction-state";

const DIR = import.meta.dir;

function read(relativePath: string): string {
	return readFileSync(join(DIR, relativePath), "utf8");
}

const SHELL = read("PretextExactMessageList.tsx");
/**
 * The frame-run geometry helper, which lives beside the shell rather than in it.
 *
 * Read as its OWN module, not through the concatenated shell source: this guard cuts a
 * function body out with `indexOf("\n}")`, and in a concatenated string that sentinel
 * could first match a later module's closing brace — the over-running slice
 * `source-slice.ts` exists to prevent.
 */
const LAYOUT = shellModule("vlist-exact-layout.ts");
/**
 * The row component, which owns the attributes the fold controller addresses rows BY.
 *
 * Read as its own module for the same reason as `LAYOUT`: the height-neutrality checks
 * below cut a window from an attribute to the next `style={{`, and in a concatenated
 * source that window could close on a different module's markup.
 */
const ROW = shellModule("ExactRow.tsx");

beforeAll(() => {
	installCanvasStub();
});

/**
 * The body of the shell's fold-play layout effect.
 *
 * Ends at the push of the effect's ops into the shared motion scheduler, which
 * replaced the fold's own controller (see vlist-motion-scheduler.ts): the fold, its
 * decorative frames and the drill morph that rides along with it are ONE visual event
 * and must share one cancel boundary and one time base.
 */
function playEffect(): string {
	const start = SHELL.indexOf("const capture = foldCaptureRef.current;");
	expect(start).toBeGreaterThan(0);
	const end = SHELL.indexOf("motionRef.current.push(ops)", start);
	expect(end).toBeGreaterThan(start);
	// The effect ends at the first `});` at ANY indentation after the play call;
	// a hardcoded one-tab sentinel silently over-ran when the shell was re-indented.
	const endOfEffect = SHELL.slice(end).search(/\n\t+\}\);/);
	return SHELL.slice(start, endOfEffect < 0 ? undefined : end + endOfEffect);
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
			// Flips a translated body back to the original. See the dedicated test below
			// for why this one belongs here despite not being a fold by name.
			"onToggleTranslation:",
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

	/**
	 * The translation flip IS height-affecting, and this test exists because an earlier
	 * version of this file asserted the opposite.
	 *
	 * It used to require that `onToggleTranslation` must NOT capture, on the stated
	 * grounds that the flip is "height-neutral". That is false: `measureReasoning`
	 * measures `resolveReasoningDisplayText(...)`, which returns the ORIGINAL text under
	 * `showOriginal`, and `registry.ts` folds `showOriginal` into the measure cache key
	 * precisely because the two texts wrap to different line counts at one width.
	 * Measured directly against `measureReasoning` at 860px wide: an expanded run is
	 * 70px showing its translation and 90px showing its original.
	 *
	 * The consequence of the wrong assertion was the artifact the fold transition exists
	 * to remove: flipping a translation resized a committed row and teleported every row
	 * below it, while every other toggle in the same list eased. So the toggle is now in
	 * the capture list above, and this test pins the REASON so the "tidy-up" that removes
	 * it again has to argue with a number.
	 */
	it("captures for the translation flip, because it resizes the row", async () => {
		const { measureReasoning } = await import("./measure/measure-reasoning");
		// `text` is the original; `translatedText` is what is shown by default.
		const data = {
			text: "This is the untranslated original, which is considerably longer than its translation and therefore wraps onto a very different number of lines at the same width, so the box it needs is taller.",
			translatedText: "短译文。",
			charCount: 4,
			stepCount: 1,
		} as never;
		const translated = measureReasoning(data, 860, 5, { expanded: true });
		const original = measureReasoning(data, 860, 5, { expanded: true, showOriginal: true });
		expect(original.height).toBeGreaterThan(translated.height);
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

describe("fold transition: reduced-motion drill retention", () => {
	// Execute the actual shell callbacks, not a copied model of their conditions.
	// Mounting the whole shell would require its document/query/WS infrastructure.
	function harness(reduced: boolean, geometryAvailable = true) {
		const capture = sliceBracketedRegion(
			SHELL,
			"const captureFoldBefore = useCallback((key: string) => {",
		);
		const toggle = sliceBracketedRegion(
			SHELL,
			"onToggleRow: (rowIndex: number, rowKey?: string) => {",
		);
		expect(capture).not.toBeNull();
		expect(toggle).not.toBeNull();
		const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`
			let reduced = ${reduced};
			const prefersReducedMotion = () => reduced;
			const smoothFollowerRef = { current: null };
			const foldCaptureRef = { current: { stale: true } };
			const scrollTopRef = { current: 0 };
			const readFoldGeometryRef = { current: () => (${geometryAvailable ? '{ geometry: new Map([["trace", {}]]), documentRevision: 1, lod: 1 }' : "null"}) };
			const useCallback = (fn) => fn;
			${capture}, []);
			const key = "trace";
			let hasCard = true;
			let closingRows = new Map();
			const measuredByKeyRef = { current: { get: () => ({ rows: [{ key: "tool", cardMeasured: hasCard ? {} : undefined }] }) } };
			const setClosingRows = (update) => { closingRows = update(closingRows); };
			const setInteraction = (update) => update({});
			const toggleVListTraceRow = () => { hasCard = !hasCard; };
			const toggleVListRow = () => { throw new Error("wrong fold channel"); };
			const toggles = { ${toggle} };
			return {
				toggle: () => toggles.onToggleRow(0, "tool"),
				closing: () => closingRows.get(key)?.has("tool") ?? false,
				capture: () => foldCaptureRef.current,
				hasCard: () => hasCard,
			};
		`);
		return new Function(code)() as {
			toggle(): void;
			closing(): boolean;
			capture(): unknown;
			hasCard(): boolean;
		};
	}

	it("repeated reduced-motion collapse/expand never retains a closing card or stale capture", () => {
		const h = harness(true);
		for (let i = 0; i < 3; i++) {
			h.toggle();
			expect(h.hasCard()).toBe(false);
			expect(h.closing()).toBe(false);
			expect(h.capture()).toBeNull();
			h.toggle();
			expect(h.hasCard()).toBe(true);
			expect(h.closing()).toBe(false);
		}
	});

	it("retains an animated collapse when geometry was captured", () => {
		const h = harness(false);
		h.toggle();
		expect(h.hasCard()).toBe(false);
		expect(h.closing()).toBe(true);
		expect(h.capture()).not.toBeNull();
	});

	it("does not retain a card when geometry cannot be captured", () => {
		const h = harness(false, false);
		h.toggle();
		expect(h.hasCard()).toBe(false);
		expect(h.closing()).toBe(false);
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
		const emptyGuard = body.indexOf("nestedResizes.length === 0");
		// Indentation-independent: the point is that the capture is cleared right
		// before the play call, not how deeply the effect happens to be nested.
		const consume = body.search(/foldCaptureRef\.current = null;\s*const ops/);
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

	/**
	 * The revision cannot catch a level switch: like a fold it is a build option, so a
	 * fold followed by a pinch inside the age bound passes both the revision and the age
	 * check. Consuming the capture on THAT commit puts this controller and the LOD morph
	 * on the same node's `transform` in one frame.
	 */
	it("validates the capture against the committed level too", () => {
		expect(playEffect()).toContain("pretextDocument.manifest?.lod");
	});

	it("stamps the capture with the level its geometry came from", () => {
		// Read through the geometry channel, so the capture's revision and level can
		// never be taken from different frames.
		const capture = SHELL.slice(
			SHELL.indexOf("const captureFoldBefore = useCallback("),
			SHELL.indexOf("const togglesCacheRef = useRef<Map<string, RowToggles>>"),
		);
		expect(capture.length).toBeGreaterThan(0);
		expect(capture).toContain("lod: read.lod");
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
		expect(ROW).toContain("data-nf-row-key={item.spec.key}");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the shell's selector source verbatim
		expect(SHELL).toContain('[data-nf-row-key="${cssAttrEscape(motion.key)}"]');
	});

	/**
	 * A `clip-path` inset is measured from the bottom of the node it plays ON, so a
	 * reveal MUST target the row's inner content box — the only box that is the layout's
	 * `height` tall.
	 *
	 * The outer row box is `hitHeight` (its own height PLUS the gap to the next row, see
	 * `resolveRowHitHeight`). Playing the clip there starts it a gap's worth of pixels
	 * below the card's real bottom edge, so the first frame uncovers content that should
	 * still be hidden — and the inner box has its own `overflow: hidden`, so the two
	 * clips disagree about where the card ends. Silent: the fold still animates, it just
	 * flashes a sliver of the body at the wrong moment.
	 */
	it("plays the reveal clip on the row's INNER body box, not the padded hit box", () => {
		expect(ROW).toContain("data-nf-row-body={item.spec.key}");
		const body = playEffect();
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the shell's selector source verbatim
		expect(body).toContain('[data-nf-row-body="${cssAttrEscape(motion.key)}"]');
		// The choice must be driven by the motion kind, not applied to both: only a `shift`
		// translates the whole row and belongs on the outer hit box. A `reveal` (clip) and a
		// `resize` (height) both act on the inner box that carries `overflow: hidden`.
		expect(body).toContain('motion.kind === "shift"');
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the shell's selector source verbatim
		expect(body).toContain('[data-nf-row-key="${cssAttrEscape(motion.key)}"]');
	});

	/**
	 * Expanding while pinned to the bottom plans BOTH a reveal and a shift for the
	 * toggled row (the header travels up as the body unrolls). They now land on two
	 * different nodes and two different properties, so they must not share a cancel
	 * scope — the scheduler cancels a scope before starting it, so one scope for both
	 * would have the second op cancel the first before it ever ran.
	 */
	it("gives the toggled row's reveal and shift distinct cancel scopes", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the shell's scope expression verbatim
		expect(playEffect()).toContain("`${rowScope(motion.key)}:${motion.kind}`");
	});

	it("resolves a planned grouping frame by its own key attribute", () => {
		// The decorative border is a SIBLING of the rows, not one of them: it has no
		// spec.key and never enters the mounted-row window, so without its own
		// addressable attribute the controller cannot reach it and the border stays at
		// its committed box while the cards inside it animate.
		expect(SHELL).toContain("data-tool-run-frame={run.key}");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the shell's selector source verbatim
		expect(SHELL).toContain('[data-tool-run-frame="${cssAttrEscape(frameMotion.key)}"]');
	});

	it("keys a frame by content, not by item index", () => {
		// An index is not an identity: a fold earlier in the document renumbers every
		// run after it, so an index-keyed frame would be paired with a DIFFERENT run's
		// geometry across the very rebuild this transition diffs.
		const start = LAYOUT.indexOf("export function computeToolRunFrames(");
		const body = LAYOUT.slice(start, LAYOUT.indexOf("\n}", start));
		expect(start).toBeGreaterThan(0);
		expect(body).toContain("items[i]?.spec.key");
	});

	it("plans frames from the SAME snapshot and scroll pair as the rows", () => {
		// Two snapshots taken at different moments is how a border ends up animating
		// from a box its contents never occupied.
		const body = SHELL.slice(
			SHELL.indexOf("const capture = foldCaptureRef.current;"),
			SHELL.indexOf("motionRef.current.push(ops)"),
		);
		expect(body).toContain("planFoldFrameMotion({");
		expect(body).toContain("before: capture.frames");
		expect(body).toContain("after: read.frames");
		// One read call serves both plans.
		expect(body).toContain("const read = readFoldGeometryRef.current?.();");
		// No plan may be gated away by another being empty. A nested plan genuinely can be
		// the only non-empty one: drilling a row inside the document's LAST trace moves
		// nothing at the top level at all.
		for (const plan of [
			"motions.length === 0",
			"frameMotions.length === 0",
			"nestedMotions.length === 0",
			"nestedResizes.length === 0",
		]) {
			expect(body, `${plan} must take part in the empty check`).toContain(plan);
		}
	});

	/**
	 * Rows nested INSIDE a trace element must animate too.
	 *
	 * At L1/L2 a whole activity run is ONE list item whose tool rows are absolutely
	 * positioned blocks inside it. Drilling one open moves that row's siblings without
	 * moving any top-level item, so the row plan cannot reach them: the run itself grew
	 * and everything BELOW the run slid correctly, while the siblings inside it teleported.
	 *
	 * Silent by nature — the fold still animates, just not the rows the reader was looking
	 * at — so it is pinned here at the source.
	 */
	it("plans and plays the rows nested inside a trace element", () => {
		const body = playEffect();
		expect(body).toContain("planFoldNestedRowMotion({");
		expect(body).toContain("before: capture.nested");
		expect(body).toContain("after: read.nested");
		// Resolved two levels deep: the trace by its row key, then the row within it. A
		// trace-level query alone returns the FIRST row (the row-above bug).
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the shell's selector source verbatim
		expect(body).toContain('[data-nf-trace-row="${cssAttrEscape(nestedMotion.rowKey)}"]');
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the shell's selector source verbatim
		expect(body).toContain('[data-nf-row-key="${cssAttrEscape(nestedMotion.traceKey)}"]');
	});

	/**
	 * The nested rows carry LOCAL offsets, so their plan takes no scroll pair.
	 *
	 * The trace element's own displacement is already animated as that element's `shift`;
	 * feeding a document-space delta here would animate those rows twice — once via their
	 * parent and once on their own — which reads as the rows sliding further than the box
	 * that contains them.
	 */
	it("plans nested rows WITHOUT a scroll pair (local coordinates)", () => {
		const start = playEffect().indexOf("planFoldNestedRowMotion({");
		const body = playEffect().slice(start, playEffect().indexOf("});", start));
		expect(body).not.toContain("ScrollTop");
	});

	/**
	 * A nested row's scope must be disjoint from its trace's own.
	 *
	 * Both animate in the same event — the trace grew, the row moved inside it — on
	 * different nodes by different amounts. Sharing a scope would make the scheduler
	 * cancel one before starting the other (it cancels a scope before playing it).
	 */
	it("scopes a nested row apart from its trace element", () => {
		expect(playEffect()).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the shell's scope expression verbatim
			"`${rowScope(nestedMotion.traceKey)}:nested:${nestedMotion.rowKey}`",
		);
	});

	it("reveals nested expansion with clip-path and resizes only collapse", () => {
		const effect = playEffect();
		expect(effect).toContain('resize.kind === "reveal"');
		expect(effect).toContain("revealKeyframes(resize.fromInsetBottom)");
		expect(effect).toContain("nestedResizeKeyframes(resize.fromHeight, resize.toHeight)");
	});

	it("captures row and frame geometry in one snapshot", () => {
		// A frame's border is only correct while it agrees with the cards inside it, so
		// both maps must come from the same read of the committed layout.
		// Brace-matched: cutting at a hardcoded `"\n\t};"` assumed one tab of
		// indentation, and when the shell was re-indented the slice ran PAST this
		// callback into unrelated code — so the guard reported a getBoundingClientRect
		// that was never in the capture at all (see source-slice.ts).
		const body = sliceBracketedRegion(SHELL, "readFoldGeometryRef.current = () => {");
		if (body === null) throw new Error("readFoldGeometryRef.current assignment not found");
		expect(body).toContain("captureFoldGeometry(");
		expect(body).toContain("captureFoldFrameGeometry(");
		// The nested rows come from the SAME read, so a trace and the rows inside it can
		// never be planned from geometry taken at different moments.
		expect(body).toContain("captureFoldNestedRows(");
		// Derived from the layout, never measured off the border element itself.
		expect(body).not.toContain("getBoundingClientRect");
	});

	it("cancels in-flight animations on unmount", () => {
		// A fold outlives its click: the reader can scroll away or switch narrator. One
		// scheduler owns every decorative animation, so one teardown covers all of them.
		const start = SHELL.indexOf("const scheduler = motionRef.current;");
		expect(start).toBeGreaterThan(0);
		expect(SHELL.slice(start, start + 200)).toContain("scheduler.cancel()");
	});

	/**
	 * The three motion effects PUSH their ops; a fourth effect starts them. Layout
	 * effects within one component run in declaration order, so the flush must be
	 * declared last — above any of them, that effect's ops would land in the next event
	 * or never. Silent: the plans are still produced and only the timing comes apart.
	 */
	it("flushes the batch from a layout effect declared AFTER every planner", () => {
		const flush = SHELL.indexOf("motionRef.current.flush()");
		expect(flush, "the motion flush effect is missing").toBeGreaterThan(0);
		for (const marker of [
			"const capture = foldCaptureRef.current;", // fold
			"buildDrillSnapshots(", // drill morph
			"buildLodSnapshots(", // LOD morph
			"buildLifecycleSnapshot(", // lifecycle transition
		]) {
			const at = SHELL.indexOf(marker);
			expect(at, `${marker} is missing`).toBeGreaterThan(0);
			expect(at, `the flush must be declared after ${marker}`).toBeLessThan(flush);
		}
		// Stated at the source, so the next reader does not have to rediscover it here.
		expect(SHELL).toContain("MOTION FLUSH");
	});
});

describe("lifecycle transition: wiring", () => {
	/** The lifecycle layout effect's body. */
	function lifecycleEffect(): string {
		const start = SHELL.indexOf("const foldPlayed = foldPlayedThisCommitRef.current;");
		expect(start, "the lifecycle effect is missing").toBeGreaterThan(0);
		const end = SHELL.indexOf("motionRef.current.push(ops);", start);
		expect(end).toBeGreaterThan(start);
		return SHELL.slice(start, end);
	}

	it("runs AFTER the three reader-driven planners", () => {
		// The fold effect sets `foldPlayedThisCommitRef` for the commit it animated; the
		// lifecycle effect reads it. Declared the other way round, it would read the
		// PREVIOUS commit's flag and double-animate the reader's own fold.
		const lifecycle = SHELL.indexOf("buildLifecycleSnapshot(");
		for (const marker of [
			"const capture = foldCaptureRef.current;",
			"buildDrillSnapshots(",
			"buildLodSnapshots(",
		]) {
			expect(SHELL.indexOf(marker)).toBeLessThan(lifecycle);
		}
	});

	it("rolls its baseline BEFORE any early return", () => {
		// The LOD morph's lesson: a baseline that only rolls on some commits diffs against
		// a stale frame and mispairs everything.
		const body = lifecycleEffect();
		const roll = body.indexOf("lifecyclePrevRef.current = next;");
		const firstReturn = body.indexOf("!prevContext ||");
		expect(roll).toBeGreaterThan(0);
		expect(roll).toBeLessThan(firstReturn);
	});

	it("yields to the reader's fold, a level/width change and reduced motion", () => {
		const body = lifecycleEffect();
		expect(body).toContain("foldPlayed");
		expect(body).toContain("prevContext.lod !== context.lod");
		expect(body).toContain("prevContext.widthBucket !== context.widthBucket");
		expect(body).toContain("prefersReducedMotion()");
	});

	it("uses its own cancel domain, not the fold's", () => {
		const body = lifecycleEffect();
		expect(body).toContain("lifecycleScope(");
		expect(body).not.toContain("rowScope(");
	});

	it("never leaves a retained card without a release", () => {
		// Every row marked closing either gets a resize op whose onDone releases it, or is
		// released by the effect directly — otherwise the card would stay on screen.
		const body = lifecycleEffect();
		expect(body).toContain("pendingLifecycleClosingRef.current");
		expect(body).toContain("releaseClosingRow(traceKey, rowKey)");
		expect(body).toContain("onDone: () => releaseClosingRow(resize.traceKey, resize.rowKey)");
		// Every early exit settles the marks too, so a skipped plan cannot strand a card.
		expect(body).toContain("releaseUnplanned(new Set());");
	});

	it("does not release a retained card on the commit that marked it", () => {
		// The marking effect runs before the document rebuilds. Releasing on that same
		// commit (rows unchanged, empty plan) cancelled the mark in one batched update, so
		// the card unmounted with the rebuild instead of closing.
		const body = lifecycleEffect();
		expect(body).toContain("pendingClosing.items !== items");
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
		expect(SHELL).toContain("const motionRef = useRef(createMotionScheduler())");
		expect(SHELL).not.toContain("setFoldCapture");
		expect(SHELL).not.toContain("useState(createMotionScheduler");
	});

	it("keeps the row-BODY attribute height-neutral too", () => {
		// Same rule as data-nf-row-key: a data attribute cannot affect layout, and it
		// must NOT be threaded through spec.opts (the measure cache key).
		const at = ROW.indexOf("data-nf-row-body={item.spec.key}");
		expect(at).toBeGreaterThan(0);
		const style = ROW.indexOf("style={{", at);
		expect(ROW.slice(at, style)).not.toContain("spec.opts");
	});

	it("keeps the row-key attribute height-neutral", () => {
		// It rides on the same element as data-nf-unit — a data attribute, so it cannot
		// affect layout, and it must NOT be threaded through spec.opts (the measure
		// cache key).
		const rowStart = ROW.indexOf("data-nf-row-key={item.spec.key}");
		const style = ROW.indexOf("style={{", rowStart);
		expect(rowStart).toBeGreaterThan(0);
		expect(style).toBeGreaterThan(rowStart);
		expect(ROW.slice(rowStart, style)).not.toContain("height");
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
 *
 * The other half — a fold whose capture is still alive when a LATER commit does move
 * the level — is closed by `isFoldCaptureUsable`'s lod check, asserted above.
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
