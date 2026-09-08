import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Deterministic canvas BEFORE any pretext-backed import (see measure-tool-call.test.ts).
beforeAll(() => {
	installCanvasStub();
});

async function mod() {
	return import("./measure-tool-call");
}

type Mod = Awaited<ReturnType<typeof mod>>;
type MetaRow = import("./measure-tool-call").ToolMetaRow;
type Entry = import("./measure-tool-call").ToolStructuredEntry;
type Section = import("./measure-tool-call").ToolDetailSection;
type AskQuestion = import("./measure-tool-call").ToolAskQuestion;

const WIDTH = 600;

/** Measure a meta-rows region at WIDTH. */
async function measureMeta(rows: MetaRow[], width = WIDTH) {
	const m = await mod();
	return m.measureToolBody({ kind: "meta-rows", rows }, width);
}

/** Measure a structured region built from entries. */
async function measureEntries(entries: Entry[], width = WIDTH, badgeRows = 0) {
	const m = await mod();
	return m.measureToolBody({ kind: "structured", badgeRows, bodyLines: [], entries }, width);
}

/** Measure a sections region. */
async function measureSections(sections: Section[], width = WIDTH, viewportHeight?: number) {
	const m = await mod();
	return m.measureToolDetail({ kind: "sections", sections }, width, viewportHeight);
}

/** A capped code body carrying real text. */
function codeBody(text: string): Section["body"] {
	return bodyFixture({ kind: "capped", cap: "code", contentLines: 1, text });
}

/** Measure a read-only ask replay region. */
async function measureAsk(questions: AskQuestion[], width = WIDTH) {
	const m = await mod();
	return m.measureToolBody({ kind: "ask", questions }, width);
}

/** Chrome constants the ask replay reuses from the permission banner. */
async function askChrome() {
	return import("./measure-permission");
}

// ─────────────────────────────────────────────────────────────────────────────
// meta-rows
// ─────────────────────────────────────────────────────────────────────────────
describe("canonical body measurement", () => {
	it("preserves models and only attaches local geometry", async () => {
		const m = await mod();
		const model = bodyFixture({ cap: "code", text: "text", format: "text", live: true });
		const result = m.measureToolDetail(
			{ kind: "sections", sections: [{ key: "output.main", label: "output", body: model }] },
			480,
		);
		const section = result.sections[0];
		if (!section) throw new Error("missing section");
		expect(section.measuredBody.model).toBe(model);
		expect(section.measuredBody.frame.blocks[0]?.top).toBe(0);
		expect(section.bodyTop).toBe(
			m.DETAIL_TOP_MARGIN + m.SECTION_LABEL_HEIGHT + m.SECTION_LABEL_MARGIN_BOTTOM,
		);
		expect(result.height).toBe(section.bodyTop + section.measuredBody.height);
		expect("blocks" in result).toBe(false);
		expect("blockCount" in section).toBe(false);
	});

	it("large dynamic diffs reserve cap without choosing a reader window", async () => {
		const { createDiffDocument } = await import("@shared/pretext-layout/diff-core");
		const m = await mod();
		const text = Array.from({ length: 1600 }, (_, i) => `r${i}`).join("\n");
		const document = createDiffDocument({ oldText: text, newText: `${text}!` });
		const focus = document.focus;
		const model = bodyFixture({
			cap: "diff",
			format: "diff",
			diffDocument: document,
			source: "input.edit",
			followTarget: { kind: "diff-row", focus },
		});
		const measured = m.measureToolBody(model, 180);
		expect(measured.height).toBe(m.DETAIL_CAPS.diff);
		expect(measured.model).toBe(model);
		expect(measured.model.diffDocument?.focus).toBe(focus);
		expect(measured.model.diffDocument?.totalRows).toBeGreaterThan(500);
		expect(measured.blocks).toHaveLength(1);
		expect("lines" in measured.model.diffDocument!).toBe(false);
		expect("projection" in measured).toBe(false);
	});

	it("small diff probing includes both gutters and exact local padding", async () => {
		const { createDiffDocument, diffDocumentLineNoWidth, readDiffRowContent } = await import(
			"@shared/pretext-layout/diff-core"
		);
		const m = await mod();
		const document = createDiffDocument({
			oldText: "one long line with spaces",
			newText: "one changed line with spaces",
			startLine: 1000,
		});
		const model = bodyFixture({ cap: "diff", format: "diff", diffDocument: document });
		const rows = Array.from({ length: document.totalRows }, (_, row) => ({
			content: readDiffRowContent(document, row) ?? "",
		}));
		for (const width of [120, 600]) {
			const result = m.measureToolBody(model, width);
			expect(result.height).toBe(
				m.measureDiffContentHeight(
					rows,
					diffDocumentLineNoWidth(document) * 2 + 2,
					m.DETAIL_CAPS.diff,
					width,
				),
			);
		}
	});

	it("empty truncated text still reserves the complete cap", async () => {
		const m = await mod();
		const result = m.measureToolBody(
			bodyFixture({ cap: "code", text: "", textTruncated: true }),
			600,
		);
		expect(result.height).toBe(m.DETAIL_CAPS.code);
	});
});

describe("measureToolDetail — meta-rows", () => {
	it("a single text row = top margin + one xs line", async () => {
		const m = await mod();
		const d = await measureMeta([{ text: "/src/app.ts", mono: true }]);
		expect(d.kind).toBe("meta-rows");
		expect(d.height).toBe(m.XS_LINE_HEIGHT);
		expect(d.appliedCap).toBeNull();
	});

	it("rows stack with the meta gap between them", async () => {
		const m = await mod();
		const one = await measureMeta([{ text: "a" }]);
		const two = await measureMeta([{ text: "a" }, { text: "b" }]);
		expect(two.height - one.height).toBe(m.META_ROW_GAP + m.XS_LINE_HEIGHT);
	});

	it("reserves a fixed badge row and a fixed action row", async () => {
		const m = await mod();
		const plain = await measureMeta([{ text: "file.zip" }]);
		const withBadges = await measureMeta([
			{ text: "file.zip", badges: [{ label: "1.2 MB" }, { label: "zip" }] },
		]);
		const withActions = await measureMeta([
			{
				text: "file.zip",
				badges: [{ label: "1.2 MB" }],
				actions: [
					{ kind: "download", value: "/d/x" },
					{ kind: "copy", value: "/d/x" },
				],
			},
		]);
		expect(withBadges.height - plain.height).toBe(m.META_ROW_GAP + m.META_BADGE_ROW);
		expect(withActions.height - withBadges.height).toBe(m.META_ROW_GAP + m.META_ACTION_ROW);
	});

	it("badge row height is independent of the CHIP COUNT (fixed slot)", async () => {
		const few = await measureMeta([{ text: "", badges: [{ label: "a" }] }]);
		const many = await measureMeta([
			{ text: "", badges: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }] },
		]);
		expect(many.height).toBe(few.height);
	});

	it("long row text wraps: a narrower width is taller", async () => {
		const text = "x".repeat(400);
		const wide = await measureMeta([{ text }], 800);
		const narrow = await measureMeta([{ text }], 300);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});

	it("bounds the row count so a runaway list cannot grow without limit", async () => {
		const m = await mod();
		const rows: MetaRow[] = Array.from({ length: 40 }, (_, i) => ({ text: `row ${i}` }));
		const d = await measureMeta(rows);
		const capped = await measureMeta(rows.slice(0, m.META_ROWS_MAX));
		expect(d.height).toBe(capped.height);
	});

	it("an empty row list still yields one placeholder line", async () => {
		const m = await mod();
		const d = await measureMeta([]);
		expect(d.height).toBe(m.XS_LINE_HEIGHT);
	});

	it("carries href / badges / actions as render-only block data", async () => {
		const d = await measureMeta([
			{
				text: "https://x.dev",
				href: "https://x.dev",
				badges: [{ label: "mode" }],
				actions: [{ kind: "download", value: "/d/x" }],
			},
		]);
		const tags = d.blocks.map((b) => (b.kind === "fixed" ? b.tag : "inline"));
		expect(tags).toEqual(["inline", "detail-meta-badges", "detail-meta-actions"]);
		const textBlock = d.blocks[0];
		expect(textBlock?.kind === "inline" && textBlock.data?.href).toBe("https://x.dev");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// structured entries
// ─────────────────────────────────────────────────────────────────────────────
describe("measureToolDetail — structured entries", () => {
	it("a title-only entry = top margin + one xs line", async () => {
		const m = await mod();
		const d = await measureEntries([{ title: "Entry One" }]);
		expect(d.height).toBe(m.XS_LINE_HEIGHT);
	});

	it("meta and badge rows each add their own fixed row", async () => {
		const m = await mod();
		const bare = await measureEntries([{ title: "T" }]);
		const withMeta = await measureEntries([{ title: "T", meta: "a.com" }]);
		const withBoth = await measureEntries([
			{ title: "T", meta: "a.com", badges: [{ label: "user" }] },
		]);
		expect(withMeta.height - bare.height).toBe(m.XS_LINE_HEIGHT);
		expect(withBoth.height - withMeta.height).toBe(m.META_BADGE_ROW);
	});

	it("entries stack with the section gap between them", async () => {
		const m = await mod();
		const one = await measureEntries([{ title: "A" }]);
		const two = await measureEntries([{ title: "A" }, { title: "B" }]);
		expect(two.height - one.height).toBe(m.SECTION_GAP + m.XS_LINE_HEIGHT);
	});

	it("clamps a snippet to ENTRY_SNIPPET_MAX_LINES no matter how long it is", async () => {
		const m = await mod();
		const short = await measureEntries([{ title: "T", snippet: "tiny" }]);
		const huge = await measureEntries([{ title: "T", snippet: "y".repeat(50_000) }]);
		expect(short.height).toBe(m.XS_LINE_HEIGHT + m.XS_LINE_HEIGHT);
		expect(huge.height).toBe(m.XS_LINE_HEIGHT + m.ENTRY_SNIPPET_MAX_LINES * m.XS_LINE_HEIGHT);
	});

	it("bounds the entry count at ENTRY_MAX", async () => {
		const m = await mod();
		const entries: Entry[] = Array.from({ length: 30 }, (_, i) => ({ title: `e${i}` }));
		const all = await measureEntries(entries);
		const capped = await measureEntries(entries.slice(0, m.ENTRY_MAX));
		expect(all.height).toBe(capped.height);
	});

	it("keeps the leading badge header when badgeRows > 0", async () => {
		const m = await mod();
		const withHeader = await measureEntries([{ title: "T" }], WIDTH, 1);
		const without = await measureEntries([{ title: "T" }], WIDTH, 0);
		expect(withHeader.height - without.height).toBe(m.STRUCT_BADGE_ROW + m.STRUCT_BADGE_GAP - 0);
	});

	it("entries take precedence over bodyLines", async () => {
		const m = await mod();
		const d = m.measureToolBody(
			{
				kind: "structured",
				badgeRows: 0,
				bodyLines: ["ignored", "also ignored", "and this"],
				entries: [{ title: "only me" }],
			},
			WIDTH,
		);
		expect(d.height).toBe(m.XS_LINE_HEIGHT);
	});

	it("still supports the legacy bodyLines shape (no entries)", async () => {
		const m = await mod();
		const d = m.measureToolBody({ kind: "structured", badgeRows: 0, bodyLines: ["a", "b"] }, WIDTH);
		expect(d.height).toBe(m.XS_LINE_HEIGHT + m.STRUCT_BADGE_GAP + m.XS_LINE_HEIGHT);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ask replay
// ─────────────────────────────────────────────────────────────────────────────
describe("measureToolDetail — ask replay", () => {
	it("a header-only question = top margin + one sm line", async () => {
		const m = await mod();
		const p = await askChrome();
		const d = await measureAsk([{ header: "Pick one", options: [] }]);
		expect(d.kind).toBe("ask");
		expect(d.appliedCap).toBeNull();
		expect(d.height).toBe(p.HEADER_LINE_HEIGHT);
	});

	it("omitHeader drops exactly the header row", async () => {
		const p = await askChrome();
		const withHeader = await measureAsk([{ header: "Pick one", options: [{ label: "Alpha" }] }]);
		const without = await measureAsk([
			{ header: "Pick one", omitHeader: true, options: [{ label: "Alpha" }] },
		]);
		// The header row plus the gap that separated it from the first option.
		expect(withHeader.height - without.height).toBe(p.HEADER_LINE_HEIGHT + p.QUESTION_STACK_GAP);
	});

	it("each option adds a label row, and a description its own smaller row", async () => {
		const p = await askChrome();
		const bare = await measureAsk([
			{ header: "H", options: [{ label: "Alpha" }, { label: "Beta" }] },
		]);
		const withDesc = await measureAsk([
			{ header: "H", options: [{ label: "Alpha" }, { label: "Beta", description: "second" }] },
		]);
		expect(withDesc.height - bare.height).toBe(
			p.OPTION_DESC_MARGIN_TOP + p.OPTION_DESC_LINE_HEIGHT,
		);
	});

	it("options stack with the tighter options gap", async () => {
		const p = await askChrome();
		const one = await measureAsk([{ header: "H", options: [{ label: "Alpha" }] }]);
		const two = await measureAsk([
			{ header: "H", options: [{ label: "Alpha" }, { label: "Beta" }] },
		]);
		expect(two.height - one.height).toBe(p.OPTIONS_GAP + p.OPTION_LABEL_LINE_HEIGHT);
	});

	it("the answer row adds one sm line, the custom answer one xs mono line", async () => {
		const p = await askChrome();
		const base = await measureAsk([{ header: "H", options: [{ label: "Alpha" }] }]);
		const answered = await measureAsk([
			{ header: "H", options: [{ label: "Alpha" }], answer: "Answer: Alpha" },
		]);
		const custom = await measureAsk([
			{ header: "H", options: [{ label: "Alpha" }], customAnswer: "Custom answer: other" },
		]);
		expect(answered.height - base.height).toBe(p.QUESTION_STACK_GAP + p.OPTION_LABEL_LINE_HEIGHT);
		expect(custom.height - base.height).toBe(p.QUESTION_STACK_GAP + p.CUSTOM_ANSWER_LINE_HEIGHT);
	});

	it("questions stack with the banner's outer stack gap", async () => {
		const p = await askChrome();
		const one = await measureAsk([{ header: "First", options: [] }]);
		const two = await measureAsk([
			{ header: "First", options: [] },
			{ header: "Second", options: [] },
		]);
		expect(two.height - one.height).toBe(p.ALERT_STACK_GAP + p.HEADER_LINE_HEIGHT);
	});

	it("selection is height-neutral (render-only)", async () => {
		const plain = await measureAsk([{ header: "H", options: [{ label: "Alpha" }] }]);
		const selected = await measureAsk([
			{ header: "H", options: [{ label: "Alpha", selected: true }] },
		]);
		expect(selected.height).toBe(plain.height);
	});

	it("multiSelect is height-neutral (only the control glyph changes)", async () => {
		const radio = await measureAsk([{ header: "H", options: [{ label: "Alpha" }] }]);
		const checkbox = await measureAsk([
			{ header: "H", multiSelect: true, options: [{ label: "Alpha" }] },
		]);
		expect(checkbox.height).toBe(radio.height);
	});

	it("bounds the question and option counts", async () => {
		const m = await mod();
		const questions: AskQuestion[] = Array.from({ length: 40 }, (_, qi) => ({
			header: `Q${qi}`,
			options: Array.from({ length: 40 }, (_, oi) => ({ label: `O${oi}` })),
		}));
		const all = await measureAsk(questions);
		const capped = await measureAsk(
			questions
				.slice(0, m.ASK_QUESTIONS_MAX)
				.map((q) => ({ ...q, options: q.options.slice(0, m.ASK_OPTIONS_MAX) })),
		);
		expect(all.height).toBe(capped.height);
	});

	it("an entirely empty question still occupies one placeholder row", async () => {
		const m = await mod();
		const d = await measureAsk([{ header: "", omitHeader: true, options: [] }]);
		expect(d.height).toBe(m.XS_LINE_HEIGHT);
	});

	it("measures as a SECTION body (the denied-question shape)", async () => {
		// withErrorSection wraps a failed question as `[ask, error]`; the section
		// path must recurse into the ask branch and report its kind so the render
		// layer can route it away from the generic block renderer.
		const d = await measureSections([
			{
				key: "meta.header",
				body: { kind: "ask", questions: [{ header: "Pick", options: [{ label: "Alpha" }] }] },
			},
			{
				key: "section.error",
				label: "error",
				body: { kind: "error", text: "User skipped the question" },
			},
		]);
		expect(d.sections.map((s) => s.measuredBody.kind)).toEqual(["ask", "error"]);
		for (const { measuredBody } of d.sections)
			expect(measuredBody.blocks).toHaveLength(measuredBody.frame.blocks.length);
		expect(d.height).toBeGreaterThan(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// sections
// ─────────────────────────────────────────────────────────────────────────────
describe("measureToolDetail — sections", () => {
	it("a labelled section adds the label row above its body", async () => {
		const m = await mod();
		const unlabelled = await measureSections([{ key: "meta.header", body: codeBody("hi") }]);
		const labelled = await measureSections([
			{ key: "section.output", label: "output", body: codeBody("hi") },
		]);
		expect(labelled.height - unlabelled.height).toBe(
			m.SECTION_LABEL_HEIGHT + m.SECTION_LABEL_MARGIN_BOTTOM,
		);
	});

	it("sections stack with SECTION_GAP between them", async () => {
		const m = await mod();
		const one = await measureSections([
			{ key: "section.command", label: "command", body: codeBody("a") },
		]);
		const two = await measureSections([
			{ key: "section.command", label: "command", body: codeBody("a") },
			{ key: "section.output", label: "output", body: codeBody("b") },
		]);
		// Second section = gap + label chrome + the same body height.
		const bodyOnly =
			one.height - m.DETAIL_TOP_MARGIN - m.SECTION_LABEL_HEIGHT - m.SECTION_LABEL_MARGIN_BOTTOM;
		expect(two.height - one.height).toBe(
			m.SECTION_GAP + m.SECTION_LABEL_HEIGHT + m.SECTION_LABEL_MARGIN_BOTTOM + bodyOnly,
		);
	});

	it("keeps blocks and frame index-parallel (render layer invariant)", async () => {
		const d = await measureSections([
			{
				key: "meta.header",
				body: { kind: "meta-rows", rows: [{ text: "/src/a.ts", mono: true }] },
			},
			{ key: "section.command", label: "command", body: codeBody("$ ls") },
			{ key: "section.output", label: "output", body: codeBody("file1\nfile2") },
		]);
		for (const { measuredBody } of d.sections)
			expect(measuredBody.blocks).toHaveLength(measuredBody.frame.blocks.length);
		expect(d.sections.every(({ measuredBody }) => measuredBody.blocks.length > 0)).toBe(true);
	});

	it("exposes per-section geometry with each body in its own local coordinates", async () => {
		const d = await measureSections([
			{ key: "meta.header", body: { kind: "meta-rows", rows: [{ text: "/src/a.ts" }] } },
			{ key: "section.output", label: "output", body: codeBody("body") },
		]);
		expect(d.sections).toHaveLength(2);
		const [meta, output] = d.sections ?? [];
		expect(meta?.measuredBody.kind).toBe("meta-rows");
		expect(meta?.label).toBeUndefined();
		expect(output?.label).toBe("output");
		expect(output!.top).toBe(meta!.top + meta!.height + (await mod()).SECTION_GAP);
		for (const section of d.sections) {
			expect(section.measuredBody.frame.blocks[0]?.top).toBe(0);
			expect(section.bodyHeight).toBe(section.measuredBody.height);
			expect(section.measuredBody.model.kind).toBe(section.measuredBody.kind);
		}
		expect("blocks" in d).toBe(false);
		expect("blockStart" in output!).toBe(false);
	});

	it("the leading top margin rides on the first block only", async () => {
		const m = await mod();
		const d = await measureSections([
			{ key: "meta.header", body: codeBody("a") },
			{ key: "section.output", label: "output", body: codeBody("b") },
		]);
		expect(d.sections[0]?.top).toBe(m.DETAIL_TOP_MARGIN);
		expect(d.sections[0]?.measuredBody.frame.blocks[0]?.top).toBe(0);
	});

	it("reports the first body cap so the renderer can clamp its scroll box", async () => {
		const m = await mod();
		const d = await measureSections([
			{ key: "section.output", label: "output", body: codeBody("x") },
		]);
		expect(d.sections[0]?.measuredBody.model.kind).toBe("capped");
		expect(d.sections?.[0]?.measuredBody.appliedCap).toBe(m.DETAIL_CAPS.code);
	});

	it("marks a markdown body section (skill / knowledge / plan parity)", async () => {
		const d = await measureSections([
			{
				key: "section.output",
				label: "output",
				body: bodyFixture({
					kind: "capped",
					cap: "knowledge",
					contentLines: 2,

					text: "# Title\n\nbody",
					format: "markdown",
				}),
			},
		]);
		expect(d.sections?.[0]?.measuredBody.markdown).toBe(true);
	});

	it("forwards the viewport height so a nested plan body uses the 0.85× cap", async () => {
		const m = await mod();
		const planSection: Section[] = [
			{
				key: "section.plan",
				label: "plan",
				body: bodyFixture({
					kind: "capped",
					cap: "plan",
					contentLines: 400,
					text: "line\n".repeat(400),
					format: "markdown",
				}),
			},
		];
		const tall = await measureSections(planSection, WIDTH, 1000);
		const short = await measureSections(planSection, WIDTH, 400);
		expect(tall.height).toBeGreaterThan(short.height);
		expect(short.sections?.[0]?.measuredBody.appliedCap).toBe(Math.round(400 * 0.85));
		void m;
	});

	it("an empty section list has no phantom body", async () => {
		const m = await mod();
		const d = await measureSections([]);
		expect(d.height).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Whole-card integration: a sectioned detail drives the card height.
// ─────────────────────────────────────────────────────────────────────────────
describe("measureToolCall — sectioned detail", () => {
	function bashCard(m: Mod) {
		return m.measureToolCall(
			{
				toolName: "Bash",
				summary: "ls -la",
				category: "bash",
				status: "success",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "section.command",
							label: "command",
							body: bodyFixture({
								kind: "capped",
								cap: "bash-cmd",
								contentLines: 1,

								text: "$ ls -la",
							}),
						},
						{
							key: "section.output",
							label: "output",
							body: bodyFixture({ kind: "capped", cap: "term", contentLines: 2, text: "a\nb" }),
						},
					],
				},
			},
			WIDTH,
			5,
		);
	}

	it("expanded card height = chrome + header + the sectioned detail", async () => {
		const m = await mod();
		const card = bashCard(m);
		expect(card.effectiveOpened).toBe(true);
		expect(card.detail?.kind).toBe("sections");
		expect(card.height).toBe(card.chromeY + card.headerHeight + (card.detail?.height ?? 0));
	});

	it("collapsing drops the whole detail region", async () => {
		const m = await mod();
		const expanded = bashCard(m);
		const collapsed = m.measureToolCall(
			{
				toolName: "Bash",
				summary: "ls -la",
				category: "bash",
				status: "success",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "section.command",
							label: "command",
							body: bodyFixture({
								kind: "capped",
								cap: "bash-cmd",
								contentLines: 1,

								text: "$ ls -la",
							}),
						},
					],
				},
			},
			WIDTH,
			3,
		);
		expect(collapsed.detail).toBeNull();
		expect(collapsed.height).toBe(collapsed.collapsedHeight);
		expect(expanded.height).toBeGreaterThan(collapsed.height);
	});
});

function bodyFixture(
	options: Partial<import("@shared/pretext-layout/tool-detail").ToolCappedDetail> &
		Pick<import("@shared/pretext-layout/tool-detail").ToolCappedDetail, "cap">,
): import("@shared/pretext-layout/tool-detail").ToolCappedDetail {
	return {
		kind: "capped",
		id: "test-body",
		source: "output.main",
		format: "text",
		live: false,
		followTarget: { kind: "end" },
		...options,
	};
}
