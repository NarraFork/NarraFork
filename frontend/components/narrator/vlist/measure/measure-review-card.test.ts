/**
 * measure-review-card.test.ts — the geometry a review conclusion needs.
 *
 * Every case here exists because an earlier shape of this card failed it. A conclusion is
 * a markdown document with an action, and the two shapes it went through could express
 * neither:
 *
 *   - `system-simple`: ONE clamped line, so height was constant no matter how many
 *     findings there were.
 *   - `system-text` inside an `injection-bubble`: a plain pre-wrap body (markdown
 *     degraded to literal `##` and backticks), a badge lane reserved at a guessed width
 *     the real badges did not fill, and no scroll box — so a long review grew the row
 *     without limit.
 *
 * So the properties asserted are: the markdown drives the height, the height is capped
 * because the box scrolls, and the header chrome is height-neutral.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// The module parses markdown through pretext (canvas measureText), so the deterministic
// stub has to be installed before it is imported — hence the dynamic imports below.
beforeAll(() => {
	installCanvasStub();
});

const APPROVED = "Approved";

function findings(n: number): string {
	return [
		"## Code Review: Changes Requested",
		"",
		...Array.from({ length: n }, (_, i) => `- **[major]** \`server/file-${i}.ts\` — finding ${i}`),
	].join("\n");
}

describe("measureReviewCard — the body drives the height", () => {
	it("a one-line conclusion is chrome plus one body line", async () => {
		const { measureReviewCard, reviewCardChrome } = await import("./measure-review-card");
		const r = measureReviewCard({ text: APPROVED, verdictLabel: "Approved" }, 800);
		expect(r.height).toBeGreaterThan(reviewCardChrome());
		// The whole card is chrome + the box, and the box is what the body sized.
		expect(r.height).toBe(reviewCardChrome() + r.bodyHeight);
	});

	it("more findings measure taller", async () => {
		// The `system-simple` shape reported the SAME height for one finding and for twenty,
		// which is why the reader saw a card that appeared to say nothing.
		const { measureReviewCard } = await import("./measure-review-card");
		const few = measureReviewCard({ text: findings(2), verdictLabel: "x" }, 800);
		const many = measureReviewCard({ text: findings(8), verdictLabel: "x" }, 800);
		expect(many.height).toBeGreaterThan(few.height);
	});

	it("a narrower card wraps the body taller", async () => {
		const { measureReviewCard } = await import("./measure-review-card");
		const text = findings(4);
		const wide = measureReviewCard({ text, verdictLabel: "x" }, 1200);
		const narrow = measureReviewCard({ text, verdictLabel: "x" }, 360);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});

	it("parses the body as MARKDOWN, not as plain lines", async () => {
		// A fenced block occupies more than its line count (padding + border), so a plain
		// pre-wrap measurement of the same text is strictly shorter. That difference is the
		// evidence the markdown pipeline ran.
		const { measureReviewCard } = await import("./measure-review-card");
		const fenced = ["Approved", "", "```ts", "const a = 1;", "```"].join("\n");
		const plain = ["Approved", "", "const a = 1;", ""].join("\n");
		const withCode = measureReviewCard({ text: fenced, verdictLabel: "x" }, 800);
		const withoutCode = measureReviewCard({ text: plain, verdictLabel: "x" }, 800);
		expect(withCode.bodyHeight).toBeGreaterThan(withoutCode.bodyHeight);
	});
});

describe("measureReviewCard — the body is a capped scroll box", () => {
	it("caps a long conclusion instead of growing the row", async () => {
		const { measureReviewCard, REVIEW_BODY_CAP } = await import("./measure-review-card");
		const r = measureReviewCard({ text: findings(400), verdictLabel: "x" }, 800);
		expect(r.bodyHeight).toBe(REVIEW_BODY_CAP);
		expect(r.appliedCap).toBe(REVIEW_BODY_CAP);
	});

	it("stays capped however long the conclusion gets", async () => {
		// The cap can never clip, because the render layer scrolls the overflow — so two
		// bodies far past it measure identically.
		const { measureReviewCard } = await import("./measure-review-card");
		const long = measureReviewCard({ text: findings(200), verdictLabel: "x" }, 800);
		const longer = measureReviewCard({ text: findings(600), verdictLabel: "x" }, 800);
		expect(longer.height).toBe(long.height);
	});

	it("a short conclusion is NOT padded out to the cap", async () => {
		const { measureReviewCard, REVIEW_BODY_CAP } = await import("./measure-review-card");
		const r = measureReviewCard({ text: APPROVED, verdictLabel: "Approved" }, 800);
		expect(r.bodyHeight).toBeLessThan(REVIEW_BODY_CAP);
	});

	it("a server-truncated body reserves the full cap", async () => {
		// Matching every other capped body: the height must not depend on where the server
		// happened to cut, or a wider layout would shrink the box while the remaining
		// scrollable content had nowhere to go.
		const { measureReviewCard, REVIEW_BODY_CAP } = await import("./measure-review-card");
		const r = measureReviewCard(
			{ text: APPROVED, verdictLabel: "Approved", textTruncated: true },
			800,
		);
		expect(r.bodyHeight).toBe(REVIEW_BODY_CAP);
	});
});

describe("measureReviewCard — header chrome is height-neutral", () => {
	it("the verdict label, revision badge and action label never move the geometry", async () => {
		// All three can change on a row that is already measured and cached: a revision
		// arrives with a second badge, and starting a turn flips the action's wording. If any
		// of them moved the height, the painted row would disagree with its committed box.
		const { measureReviewCard } = await import("./measure-review-card");
		const base = measureReviewCard({ text: findings(3), verdictLabel: "Approved" }, 800);
		const decorated = measureReviewCard(
			{
				text: findings(3),
				verdictLabel: "Changes Requested — a much longer verdict label",
				revisedLabel: "Revised",
				actionLabel: "Handled",
				applied: true,
				color: "orange",
			},
			800,
		);
		expect(decorated.height).toBe(base.height);
	});

	it("the header row is a constant, so the action row is always reserved", async () => {
		const { reviewCardHeaderHeight, REVIEW_HEADER_BUTTON } = await import("./measure-review-card");
		// The button is the tallest element in the row, which is what makes the row constant
		// whether or not it is currently drawn.
		expect(reviewCardHeaderHeight()).toBe(REVIEW_HEADER_BUTTON);
	});

	it("height does not depend on LOD", async () => {
		const { measureReviewCard } = await import("./measure-review-card");
		const heights = ([1, 2, 3, 4, 5] as const).map(
			(lod) => measureReviewCard({ text: findings(3), verdictLabel: "x" }, 700, lod).height,
		);
		expect(new Set(heights).size).toBe(1);
	});
});

describe("measureReviewCard — the render contract", () => {
	it.each([
		{ name: "short", text: APPROVED, textTruncated: false },
		{ name: "long", text: findings(200), textTruncated: false },
		{ name: "truncated", text: APPROVED, textTruncated: true },
		{ name: "empty preview", text: "", textTruncated: true },
	])("uses helper height/frame directly for $name content", async (data) => {
		const { measureReviewCard, REVIEW_CARD_PADDING, REVIEW_CARD_BORDER, REVIEW_BODY_CAP } =
			await import("./measure-review-card");
		const { measureMarkdownDetail } = await import("./measure-tool-call");
		for (const width of [360, 800]) {
			const innerWidth = width - (REVIEW_CARD_PADDING + REVIEW_CARD_BORDER) * 2;
			const detail = measureMarkdownDetail(
				data.text,
				REVIEW_BODY_CAP,
				innerWidth,
				undefined,
				data.textTruncated,
			);
			const card = measureReviewCard({ ...data, verdictLabel: "Approved" }, width);
			expect(card.bodyHeight).toBe(detail.height);
			expect(card.frame).toEqual(detail.frame);
			expect(card.blocks).toEqual(detail.blocks);
			expect(card.contentWidth).toBe(detail.contentWidth);
			expect(card.frame.blocks.every((block) => block.top >= 0)).toBe(true);
		}
	});

	it("reports the body's own offset and the width it was wrapped at", async () => {
		const { measureReviewCard, reviewCardChrome, REVIEW_HEADER_GAP } = await import(
			"./measure-review-card"
		);
		const r = measureReviewCard({ text: findings(2), verdictLabel: "x" }, 640);
		// The box starts below the header, and the chrome above it accounts for exactly the
		// difference (the rest of the chrome is the card's bottom padding + border).
		expect(r.bodyTop).toBeGreaterThan(REVIEW_HEADER_GAP);
		expect(r.bodyTop).toBeLessThan(reviewCardChrome());
		// The body was measured narrower than the card: card padding, border and the box's
		// own padding all come off first.
		expect(r.contentWidth).toBeLessThan(640);
		// A full-width card — a document to read, not an utterance to attribute.
		expect(r.usedWidth).toBe(640);
	});

	it("keeps the local frame so the render copy paints from zero", async () => {
		// The helper already removed the outer gap. Rebasing it again would move the
		// first block to -10 and shave the same ten pixels from every capped box.
		const { measureReviewCard } = await import("./measure-review-card");
		const r = measureReviewCard({ text: findings(3), verdictLabel: "x" }, 800);
		expect(r.frame.blocks[0]?.top).toBe(0);
		expect(r.blocks.length).toBe(r.frame.blocks.length);
	});

	it("identifies itself as the review-card form", async () => {
		const { measureReviewCard, isMeasuredReviewCard } = await import("./measure-review-card");
		const r = measureReviewCard({ text: APPROVED, verdictLabel: "x" }, 800);
		expect(r.form).toBe("review-card");
		expect(isMeasuredReviewCard(r)).toBe(true);
	});

	it("an empty conclusion still measures a usable card", async () => {
		// A degenerate payload must not produce a zero-height row.
		const { measureReviewCard, reviewCardChrome } = await import("./measure-review-card");
		const r = measureReviewCard({ text: "", verdictLabel: "Approved" }, 800);
		expect(r.height).toBeGreaterThanOrEqual(reviewCardChrome());
	});
});
