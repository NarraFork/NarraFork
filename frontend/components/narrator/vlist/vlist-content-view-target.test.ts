/**
 * vlist-content-view-target.test.ts — the pure body-extraction rules behind the
 * vlist fullscreen viewer.
 *
 * The measured fixtures are built by the real measure layer (with the canvas
 * stub) rather than hand-written, so a change to which blocks a detail emits
 * shows up here instead of silently dropping a body from the viewer.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

// Deterministic canvas BEFORE any pretext-backed import.
beforeAll(() => {
	installCanvasStub();
});

async function targets() {
	return import("./vlist-content-view-target");
}

async function measureMod() {
	return import("./measure/measure-tool-call");
}

const WIDTH = 600;
const KEY = "tool-tu_1";

type Section = import("./measure/measure-tool-call").ToolDetailSection;

/** A capped code body carrying real text. */
function codeBody(text: string, extras: Record<string, unknown> = {}): Section["body"] {
	return {
		kind: "capped",
		cap: "code",
		contentLines: text.split("\n").length,
		hasLabel: false,
		text,
		...extras,
	} as Section["body"];
}

describe("resolveToolDetailViewTargets — capped bodies", () => {
	it("extracts the body text, language hint and truncation flag", async () => {
		const t = await targets();
		const m = await measureMod();
		const detail = m.measureToolDetail(
			{
				kind: "capped",
				cap: "code",
				contentLines: 2,
				hasLabel: false,
				text: "const a = 1;\nconst b = 2;",
				codeLangPath: "src/a.ts",
			},
			WIDTH,
		);
		const [only, ...rest] = t.resolveToolDetailViewTargets(KEY, { detail });
		expect(rest).toHaveLength(0);
		expect(only?.kind).toBe("code");
		expect(only?.text).toBe("const a = 1;\nconst b = 2;");
		expect(only?.codeLangPath).toBe("src/a.ts");
		expect(only?.id.startsWith(`${KEY}:`)).toBe(true);
	});

	it("flags a server-truncated payload, not merely one taller than its box", async () => {
		const t = await targets();
		const m = await measureMod();
		// Far more lines than the 200px code cap can show, but the WHOLE payload is
		// present: the modal shows all of it, so there is nothing to warn about.
		const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
		const tall = m.measureToolDetail(
			{ kind: "capped", cap: "code", contentLines: 400, hasLabel: false, text: long },
			WIDTH,
		);
		expect(t.resolveToolDetailViewTargets(KEY, { detail: tall })[0]?.truncated).toBeUndefined();

		// A prefix of a larger server-side payload DOES warrant the notice.
		const prefix = m.measureToolDetail(
			{
				kind: "capped",
				cap: "code",
				contentLines: 2,
				hasLabel: false,
				text: "line 0\nline 1",
				textTruncated: true,
			},
			WIDTH,
		);
		expect(t.resolveToolDetailViewTargets(KEY, { detail: prefix })[0]?.truncated).toBe(true);
	});

	it("classifies terminal output as the term visual", async () => {
		const t = await targets();
		const m = await measureMod();
		const detail = m.measureToolDetail(
			{ kind: "capped", cap: "term", contentLines: 1, hasLabel: false, text: "$ ls\na b" },
			WIDTH,
		);
		const [only] = t.resolveToolDetailViewTargets(KEY, { detail });
		expect(only?.kind).toBe("term");
	});

	it("returns nothing for a media body (no readable text)", async () => {
		const t = await targets();
		const m = await measureMod();
		const detail = m.measureToolDetail(
			{
				kind: "capped",
				cap: "media",
				contentPx: 200,
				media: { previewUrl: "blob:x", filename: "shot.png" },
			},
			WIDTH,
		);
		expect(t.resolveToolDetailViewTargets(KEY, { detail })).toHaveLength(0);
	});

	it("returns nothing when the card has no detail at all", async () => {
		const t = await targets();
		expect(t.resolveToolDetailViewTargets(KEY, { detail: null })).toEqual([]);
	});
});

describe("resolveToolDetailViewTargets — diff bodies", () => {
	it("reconstructs both diff sides from the structured rows", async () => {
		const t = await targets();
		const m = await measureMod();
		const diffLines = [
			{ type: "context" as const, content: "keep", oldLineNo: 1, newLineNo: 1 },
			{ type: "removed" as const, content: "old", oldLineNo: 2 },
			{ type: "added" as const, content: "new", newLineNo: 2 },
		];
		const detail = m.measureToolDetail(
			{
				kind: "capped",
				cap: "diff",
				contentLines: 3,
				hasLabel: false,
				text: " keep\n-old\n+new",
				diffLines,
			},
			WIDTH,
		);
		const [only] = t.resolveToolDetailViewTargets(KEY, { detail });
		expect(only?.kind).toBe("diff");
		expect(only?.diff).toEqual({ oldStr: "keep\nold", newStr: "keep\nnew" });
	});
});

describe("resolveToolDetailViewTargets — markdown bodies", () => {
	it("reads the raw source the markdown parse consumed", async () => {
		const t = await targets();
		const m = await measureMod();
		const plan = "# Plan\n\n- step one\n- step two";
		const detail = m.measureToolDetail(
			{ kind: "capped", cap: "plan", contentLines: 4, text: plan, markdown: true },
			WIDTH,
		);
		const [only] = t.resolveToolDetailViewTargets(KEY, { detail });
		expect(only?.kind).toBe("markdown");
		expect(only?.text).toBe(plan);
	});
});

describe("resolveToolDetailViewTargets — sections", () => {
	it("returns one target per section body, labelled and in order", async () => {
		const t = await targets();
		const m = await measureMod();
		const detail = m.measureToolDetail(
			{
				kind: "sections",
				sections: [
					{ label: "command", body: codeBody("$ bun test") },
					{ label: "output", body: codeBody("42 pass") },
				],
			},
			WIDTH,
		);
		const found = t.resolveToolDetailViewTargets(
			KEY,
			{ detail },
			{
				sections: { command: "命令", output: "输出" },
			},
		);
		expect(found.map((f) => f.text)).toEqual(["$ bun test", "42 pass"]);
		expect(found.map((f) => f.title)).toEqual(["命令", "输出"]);
	});

	it("skips label / meta sections that carry no body text", async () => {
		const t = await targets();
		const m = await measureMod();
		const detail = m.measureToolDetail(
			{
				kind: "sections",
				sections: [
					{ body: { kind: "meta-rows", rows: [{ text: "/src/a.ts", mono: true }] } },
					{ label: "output", body: codeBody("done") },
				],
			},
			WIDTH,
		);
		const found = t.resolveToolDetailViewTargets(KEY, { detail });
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toBe("done");
	});

	it("reads a markdown section's raw source", async () => {
		const t = await targets();
		const m = await measureMod();
		const body = "## Skill\n\nDo the thing.";
		const detail = m.measureToolDetail(
			{
				kind: "sections",
				sections: [
					{
						label: "plan",
						body: { kind: "capped", cap: "plan", contentLines: 3, text: body, markdown: true },
					},
				],
			},
			WIDTH,
		);
		const [only] = t.resolveToolDetailViewTargets(KEY, { detail });
		expect(only?.kind).toBe("markdown");
		expect(only?.text).toBe(body);
	});
});

describe("resolveSubagentViewTargets", () => {
	it("offers only the bodies the card actually drew", async () => {
		const t = await targets();
		const withBoth = t.resolveSubagentViewTargets(
			KEY,
			{ promptMeasured: {} as never, resultMeasured: {} as never },
			{ promptText: "do it", resultText: "# done", title: "explore — scan" },
			{ prompt: "Prompt" },
		);
		expect(withBoth.map((v) => [v.kind, v.title])).toEqual([
			["code", "Prompt"],
			["markdown", "explore — scan"],
		]);

		const collapsed = t.resolveSubagentViewTargets(
			KEY,
			{ promptMeasured: null, resultMeasured: null },
			{ promptText: "do it", resultText: "# done" },
		);
		expect(collapsed).toEqual([]);
	});
});

describe("resolveRowViewTargets", () => {
	it("markdown rows carry their text with no title", async () => {
		const t = await targets();
		const found = t.resolveRowViewTargets({
			kind: "markdown",
			key: "m1-b0",
			data: "hello **world**",
		});
		expect(found).toEqual([
			{ id: "m1-b0:body", slot: "body", kind: "markdown", text: "hello **world**" },
		]);
	});

	it("a reasoning row follows what is ON SCREEN, not the original text", async () => {
		const t = await targets();
		const spec = {
			kind: "reasoning" as const,
			key: "m1-b1",
			data: { text: "original", translatedText: "翻译" },
		};
		// Default: the translation is displayed.
		expect(t.resolveRowViewTargets(spec)[0]?.text).toBe("翻译");
		// Reader flipped back to the original.
		expect(t.resolveRowViewTargets({ ...spec, opts: { showOriginal: true } })[0]?.text).toBe(
			"original",
		);
	});

	it("uses the reasoning header wording as the modal title", async () => {
		const t = await targets();
		const found = t.resolveRowViewTargets(
			{ kind: "reasoning", key: "m1-b1", data: { text: "thought" } },
			{ reasoning: "推理" },
		);
		expect(found[0]?.title).toBe("推理");
	});

	it("offers nothing for rows with no readable body", async () => {
		const t = await targets();
		expect(t.resolveRowViewTargets({ kind: "markdown", key: "m1-b0", data: "" })).toEqual([]);
		expect(t.resolveRowViewTargets({ kind: "tool-call", key: "tool-x", data: {} })).toEqual([]);
	});
});

describe("resolvePrimaryViewTarget", () => {
	it("picks the LAST body — the payload the reader came for", async () => {
		const t = await targets();
		const list: import("./vlist-content-view-target").VListViewTarget[] = [
			{ id: "k:s0", slot: "s0", kind: "code", text: "$ cmd" },
			{ id: "k:s1", slot: "s1", kind: "term", text: "output" },
		];
		expect(t.resolvePrimaryViewTarget(list)?.id).toBe("k:s1");
		expect(t.resolvePrimaryViewTarget(list.slice(0, 1))?.id).toBe("k:s0");
		expect(t.resolvePrimaryViewTarget([])).toBeUndefined();
	});
});

describe("viewStateSig", () => {
	it("is empty when nothing was toggled", async () => {
		const t = await targets();
		expect(t.viewStateSig(new Map(), new Map(), KEY)).toBe("");
	});

	it("only reflects the row's own targets", async () => {
		const t = await targets();
		const wrap = new Map([
			[`${KEY}:b0`, false],
			["tool-other:b0", true],
		]);
		const sig = t.viewStateSig(wrap, new Map(), KEY);
		expect(sig).toBe("wb0=0");
	});

	it("is stable under Map insertion order", async () => {
		const t = await targets();
		const a = new Map([
			[`${KEY}:b0`, true],
			[`${KEY}:b1`, false],
		]);
		const b = new Map([
			[`${KEY}:b1`, false],
			[`${KEY}:b0`, true],
		]);
		expect(t.viewStateSig(a, new Map(), KEY)).toBe(t.viewStateSig(b, new Map(), KEY));
	});

	it("separates wrap from source so both can change independently", async () => {
		const t = await targets();
		const wrap = new Map([[`${KEY}:body`, true]]);
		const src = new Map([[`${KEY}:body`, true]]);
		expect(t.viewStateSig(wrap, new Map(), KEY)).not.toBe(t.viewStateSig(new Map(), src, KEY));
		expect(t.viewStateSig(wrap, src, KEY)).toBe("sbody=1,wbody=1");
	});
});
