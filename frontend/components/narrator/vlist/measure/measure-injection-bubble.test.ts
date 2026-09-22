/**
 * measure-injection-bubble.test.ts — geometry of the FRAMED markdown bubble.
 *
 * This is the list's third bubble form (framed like a user bubble, markdown-bodied
 * like an assistant message), and the properties worth pinning are the ones where the
 * two halves pull against each other:
 *
 *   - the body must be wrapped at the CAPPED width, not the row width, or the
 *     reported line breaks describe a box the reader never sees;
 *   - `contentWidth` (what the body was wrapped at) and `usedWidth` (the painted
 *     frame) are allowed to differ, and the render copy must use the former — the
 *     classic shrink-wrap trap;
 *   - the header / note rows are FIXED line boxes, so they add a constant, never a
 *     wrap-dependent amount.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

const WIDTH = 800;

const mod = () => import("./measure-injection-bubble");

describe("measureInjectionBubble — frame and body", () => {
	it("reserves padding, the header row and the body", async () => {
		const {
			measureInjectionBubble,
			INJECTION_BUBBLE_PADDING,
			INJECTION_HEADER_HEIGHT,
			INJECTION_HEADER_BODY_GAP,
		} = await mod();
		const r = measureInjectionBubble({ markdown: "hello", speaker: "explorer" }, WIDTH);
		const chrome =
			INJECTION_BUBBLE_PADDING * 2 + INJECTION_HEADER_HEIGHT + INJECTION_HEADER_BODY_GAP;
		expect(r.height).toBeGreaterThan(chrome);
		expect(r.bodyTop).toBe(
			INJECTION_BUBBLE_PADDING + INJECTION_HEADER_HEIGHT + INJECTION_HEADER_BODY_GAP,
		);
		expect(r.hasHeader).toBe(true);
		expect(r.form).toBe("injection");
	});

	it("drops exactly the header block when there is no header", async () => {
		const { measureInjectionBubble, INJECTION_HEADER_HEIGHT, INJECTION_HEADER_BODY_GAP } =
			await mod();
		const withHeader = measureInjectionBubble({ markdown: "hello" }, WIDTH);
		const without = measureInjectionBubble({ markdown: "hello", hasHeader: false }, WIDTH);
		expect(withHeader.height - without.height).toBe(
			INJECTION_HEADER_HEIGHT + INJECTION_HEADER_BODY_GAP,
		);
		expect(without.hasHeader).toBe(false);
	});

	it("is recognized by its type guard, and a plain measured element is not", async () => {
		const { measureInjectionBubble, isMeasuredInjectionBubble } = await mod();
		const { measureMessageBubble } = await import("./measure-message-bubble");
		expect(isMeasuredInjectionBubble(measureInjectionBubble({ markdown: "x" }, WIDTH))).toBe(true);
		expect(
			isMeasuredInjectionBubble(measureMessageBubble({ role: "user", text: "x" }, WIDTH)),
		).toBe(false);
	});
});

describe("measureInjectionBubble — markdown body", () => {
	it("grows with the markdown structure the projection produces", async () => {
		const { measureInjectionBubble } = await mod();
		const oneLine = measureInjectionBubble({ markdown: "just one line" }, WIDTH);
		// What `sideCarBodyToMarkdown` actually emits for a tasks digest.
		const listed = measureInjectionBubble(
			{ markdown: "### 3 open tasks\n\n- doing: a\n- todo: b\n- todo: c" },
			WIDTH,
		);
		expect(listed.height).toBeGreaterThan(oneLine.height);
	});

	it("wraps as the row narrows", async () => {
		const { measureInjectionBubble } = await mod();
		const md = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
		const wide = measureInjectionBubble({ markdown: md }, 2000);
		const narrow = measureInjectionBubble({ markdown: md }, 200);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});

	it("treats markdown as markdown, not as literal text", async () => {
		// The whole reason this form exists: a plain-text body would paint the `- ` and
		// `### ` glyphs the reader is not supposed to see. A list of N items therefore
		// must not measure the same as one paragraph holding the same characters.
		const { measureInjectionBubble } = await mod();
		const asList = measureInjectionBubble({ markdown: "- one\n- two\n- three" }, WIDTH);
		const asParagraph = measureInjectionBubble({ markdown: "one two three" }, WIDTH);
		expect(asList.height).toBeGreaterThan(asParagraph.height);
	});
});

describe("measureInjectionBubble — width discipline", () => {
	it("never spans the whole row", async () => {
		const { measureInjectionBubble, INJECTION_BUBBLE_MAX_WIDTH_RATIO } = await mod();
		const md = "a very long single line ".repeat(40);
		const r = measureInjectionBubble({ markdown: md }, WIDTH);
		expect(r.usedWidth).toBeLessThanOrEqual(Math.floor(WIDTH * INJECTION_BUBBLE_MAX_WIDTH_RATIO));
		expect(r.usedWidth).toBeLessThan(WIDTH);
	});

	it("shrink-wraps a short body instead of painting an empty box", async () => {
		const { measureInjectionBubble } = await mod();
		const short = measureInjectionBubble({ markdown: "ok", hasHeader: false }, WIDTH);
		expect(short.usedWidth).toBeLessThan(WIDTH / 2);
	});

	it("reports the width the body was WRAPPED at, which the frame may be narrower than", async () => {
		// The shrink-wrap trap: `usedWidth` is the painted frame, `contentWidth` is what
		// the line breaking used. Painting the body at the frame's inner width would
		// re-wrap it under a height predicted for the wider box.
		const { measureInjectionBubble, INJECTION_BUBBLE_PADDING } = await mod();
		const r = measureInjectionBubble({ markdown: "ok", hasHeader: false }, WIDTH);
		expect(r.usedWidth - INJECTION_BUBBLE_PADDING * 2).toBeLessThan(r.contentWidth);
		// And the invariant that makes narrowing the frame safe at all.
		expect(r.frame.usedWidth).toBeLessThanOrEqual(r.contentWidth);
	});

	it("keeps a full-bleed code panel inside the frame it shrank to", async () => {
		// The bug this pins, reported from a background command's fenced output: the
		// bubble narrowed its frame to `frame.usedWidth` while the body kept its
		// first-pass width, and a code panel — which paints its background and border
		// across the WHOLE width it is handed, unlike text — ran straight out of the
		// bubble's right edge.
		//
		// The property is one number agreeing with itself: the width the body is painted
		// at must fit inside the frame that was committed.
		const { measureInjectionBubble, INJECTION_BUBBLE_PADDING } = await mod();
		const r = measureInjectionBubble(
			{ markdown: "```\nshort\nlines\n```", hasHeader: false },
			WIDTH,
		);
		expect(r.blocks.some((b) => b.kind === "code")).toBe(true);
		expect(r.contentWidth).toBeLessThanOrEqual(r.usedWidth - INJECTION_BUBBLE_PADDING * 2);
		// And it genuinely shrank rather than reaching agreement by going full width.
		expect(r.usedWidth).toBeLessThan(WIDTH / 2);
	});

	it("keeps the panel inside the frame even when the header floor widens it", async () => {
		// The floor is applied AFTER the shrink, so a body re-measured at the pre-floor
		// width would end up narrower than its own bubble — a gap instead of an
		// overflow, but the same two-sides-disagree bug.
		const { measureInjectionBubble, INJECTION_BUBBLE_PADDING } = await mod();
		const r = measureInjectionBubble({ markdown: "```\nx\n```", speaker: "run-biome" }, WIDTH);
		expect(r.contentWidth).toBe(r.usedWidth - INJECTION_BUBBLE_PADDING * 2);
	});

	it("leaves a text-only body on the single-pass path", async () => {
		// The re-measure exists for full-bleed blocks only. Prose keeps the documented
		// asymmetry (frame narrower than the measured wrap width), because re-wrapping
		// it would change its line count and therefore the committed height.
		const { measureInjectionBubble, INJECTION_BUBBLE_PADDING } = await mod();
		const r = measureInjectionBubble({ markdown: "ok", hasHeader: false }, WIDTH);
		expect(r.contentWidth).toBeGreaterThan(r.usedWidth - INJECTION_BUBBLE_PADDING * 2);
	});

	it("floors the frame at the header minimum so a short speaker row is not clipped", async () => {
		const { measureInjectionBubble, INJECTION_BUBBLE_PADDING, INJECTION_HEADER_MIN_CONTENT_WIDTH } =
			await mod();
		const r = measureInjectionBubble({ markdown: "ok", speaker: "explorer" }, WIDTH);
		expect(r.usedWidth).toBeGreaterThanOrEqual(
			INJECTION_BUBBLE_PADDING * 2 + INJECTION_HEADER_MIN_CONTENT_WIDTH,
		);
	});

	it("keeps an empty task digest wide enough for the cadence header", async () => {
		// The empty digest body is one short line. Shrink-wrapping to it alone left the
		// header at the old 180px floor, which could not fit source name + "every N tool
		// calls" + the frequency gear — the name rendered as a single truncated character.
		const { measureInjectionBubble, INJECTION_BUBBLE_PADDING, INJECTION_HEADER_MIN_CONTENT_WIDTH } =
			await mod();
		const r = measureInjectionBubble(
			{
				payload: {
					kind: "spec-task",
					data: { emptyLabel: "Dynamic Spec — no tasks created yet", tasks: [] },
				},
				speaker: null,
				source: "living_work_spec",
				hasHeader: true,
			},
			WIDTH,
		);
		expect(r.usedWidth).toBeGreaterThanOrEqual(
			INJECTION_BUBBLE_PADDING * 2 + INJECTION_HEADER_MIN_CONTENT_WIDTH,
		);
		// The floor widens the frame only; the empty label still measures as one line.
		expect(r.frame.contentHeight).toBeGreaterThan(0);
		expect(r.height).toBeGreaterThan(r.frame.contentHeight);
	});

	it("does not let the header floor change the body's height", async () => {
		// The floor widens the FRAME only. If it leaked into the wrap width, adding a
		// header would silently re-wrap the body and change its line count.
		const { measureInjectionBubble } = await mod();
		const md = "alpha beta gamma delta epsilon zeta eta theta";
		const withHeader = measureInjectionBubble({ markdown: md, speaker: "s" }, WIDTH);
		const without = measureInjectionBubble({ markdown: md, hasHeader: false }, WIDTH);
		expect(withHeader.contentWidth).toBe(without.contentWidth);
		expect(withHeader.frame.contentHeight).toBe(without.frame.contentHeight);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Card bodies (option A): the bubble FRAMES an existing system card
//
// These producers already own structured, interactive UI — merge_summary has branch
// names and a commit sha, review_feedback has a findings list. Flattening them into
// markdown would reduce that to prose and lose the affordances, so the bubble wraps
// the card that already exists rather than replacing it.
// ─────────────────────────────────────────────────────────────────────────────

/** The real shape `adaptSystemBlock` produces (pre-composed `text`, not raw fields). */
const MERGE_DATA = {
	kind: "merge_summary",
	text: "Merged feature-x into trunk (squash) by alice",
	color: "indigo",
	hasAvatar: true,
};

describe("measureInjectionBubble — card body", () => {
	it("adds only its own chrome on top of the card's measured height", async () => {
		// The bubble must never re-derive another element's geometry: it delegates to that
		// element's own measure fn and frames whatever height comes back.
		const { measureInjectionBubble } = await mod();
		const { measureSystemSimpleCard } = await import("./measure-system-simple");
		const bubble = measureInjectionBubble(
			{ payload: { kind: "merge_summary", data: MERGE_DATA }, speaker: "alice" },
			WIDTH,
		);
		const card = measureSystemSimpleCard("merge_summary", MERGE_DATA as never, bubble.contentWidth);
		const headerOnly = measureInjectionBubble(
			{ payload: { kind: "unrecognized_kind", data: {} }, speaker: "alice" },
			WIDTH,
		);
		expect(bubble.height).toBe(headerOnly.height + card.height);
	});

	it("reports the body form explicitly instead of leaving it to be sniffed", async () => {
		// The render copy branches on this. A card body's blocks are PreparedFixedBlocks
		// that look nothing like markdown's, and a future payload could coincide — an
		// explicit discriminant cannot be collided into.
		const { measureInjectionBubble } = await mod();
		const card = measureInjectionBubble(
			{ payload: { kind: "merge_summary", data: MERGE_DATA } },
			WIDTH,
		);
		expect(card.bodyForm).toBe("payload");
		expect(card.payloadKind).toBe("merge_summary");

		const text = measureInjectionBubble({ markdown: "hello" }, WIDTH);
		expect(text.bodyForm).toBe("markdown");
		expect(text.payloadKind).toBeNull();
	});

	it("lets the payload win when both bodies are supplied", async () => {
		// Exactly one thing owns the body; two would each claim the same vertical space.
		const { measureInjectionBubble } = await mod();
		const both = measureInjectionBubble(
			{ markdown: "should be ignored", payload: { kind: "merge_summary", data: MERGE_DATA } },
			WIDTH,
		);
		expect(both.bodyForm).toBe("payload");
		// And the ignored markdown must not have been measured into the height.
		expect(both.measuredMarkdown).toBe("");
	});

	it("degrades an unrecognized payload kind to a header-only bubble, never a throw", async () => {
		// A producer added without teaching the dispatcher about it should lose its body,
		// not take the whole list down. `payloadKind` keeps the omission visible.
		const { measureInjectionBubble } = await mod();
		const r = measureInjectionBubble({ payload: { kind: "future_producer", data: {} } }, WIDTH);
		expect(r.payloadKind).toBe("future_producer");
		expect(r.frame.contentHeight).toBe(0);
		expect(r.height).toBeGreaterThan(0);
	});

	it("still reserves the note row under a card body", async () => {
		const { measureInjectionBubble, INJECTION_NOTE_HEIGHT, INJECTION_NOTE_GAP } = await mod();
		const plain = measureInjectionBubble(
			{ payload: { kind: "merge_summary", data: MERGE_DATA } },
			WIDTH,
		);
		const noted = measureInjectionBubble(
			{ payload: { kind: "merge_summary", data: MERGE_DATA }, hasNote: true },
			WIDTH,
		);
		expect(noted.height - plain.height).toBe(INJECTION_NOTE_HEIGHT + INJECTION_NOTE_GAP);
	});

	it("measures a wrapping card body through its own module", async () => {
		// `container_ready` is a system-TEXT card: its height depends on wrapping, so a
		// longer body must produce a taller bubble.
		const { measureInjectionBubble } = await mod();
		const short = measureInjectionBubble(
			{ payload: { kind: "info", data: { kind: "info", text: "up" } } },
			WIDTH,
		);
		const long = measureInjectionBubble(
			{ payload: { kind: "info", data: { kind: "info", text: "up and running ".repeat(60) } } },
			WIDTH,
		);
		expect(long.height).toBeGreaterThan(short.height);
	});
});

describe("measureInjectionBubble — bounded cost", () => {
	it("measures only a bounded prefix of a pathological body", async () => {
		// The bubble path bypasses the retired projection's 200-line ceiling, and a
		// teammate's `Send` text reaches it unbounded, so the bound has to be here.
		const { measureInjectionBubble, INJECTION_BODY_MAX_CHARS } = await mod();
		const huge = "word ".repeat(200_000);
		expect(huge.length).toBeGreaterThan(INJECTION_BODY_MAX_CHARS);
		const started = Date.now();
		const r = measureInjectionBubble({ markdown: huge }, WIDTH);
		expect(r.measuredMarkdown.length).toBe(INJECTION_BODY_MAX_CHARS);
		// A prefix, not a sample: the reader sees the start of the message.
		expect(r.measuredMarkdown.startsWith("word ")).toBe(true);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("leaves a normal-sized body untouched", async () => {
		// The bound must be invisible at real sizes, or it is a behaviour change.
		const { measureInjectionBubble } = await mod();
		const md = "a normal message body";
		expect(measureInjectionBubble({ markdown: md }, WIDTH).measuredMarkdown).toBe(md);
	});
});

describe("measureInjectionBubble — trailing note", () => {
	it("reserves a fixed line for the note and places it inside the frame", async () => {
		const { measureInjectionBubble, INJECTION_NOTE_HEIGHT, INJECTION_NOTE_GAP } = await mod();
		const plain = measureInjectionBubble({ markdown: "out" }, WIDTH);
		const noted = measureInjectionBubble({ markdown: "out", hasNote: true }, WIDTH);
		expect(noted.height - plain.height).toBe(INJECTION_NOTE_HEIGHT + INJECTION_NOTE_GAP);
		expect(noted.noteTop).toBeGreaterThan(0);
		expect(noted.noteTop + INJECTION_NOTE_HEIGHT).toBeLessThanOrEqual(noted.height);
	});

	it("marks the absence of a note with -1 rather than a plausible offset", async () => {
		const { measureInjectionBubble } = await mod();
		expect(measureInjectionBubble({ markdown: "out" }, WIDTH).noteTop).toBe(-1);
	});
});
