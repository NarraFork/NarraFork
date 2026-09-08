import { afterAll, describe, expect, it } from "bun:test";
import { createDiffDocument } from "@shared/pretext-layout/diff-core";
import { createSourceText } from "@shared/pretext-layout/source-text";
import {
	classifyToolDetail,
	type ToolCappedDetail,
	type ToolDetailSection,
	toolBodyId,
} from "@shared/pretext-layout/tool-detail";
import { measureToolBody, measureToolDetail } from "./measure/measure-tool-call";
import { installCanvasStub } from "./measure/test-canvas-stub";
import {
	findViewTarget,
	resolveDetailViewTargets,
	resolvePrimaryViewTarget,
	resolveRowViewTargets,
	resolveSubagentModelTargets,
	resolveSubagentViewTargets,
	resolveToolDetailModelTargets,
	resolveToolDetailViewTargets,
	sameViewTarget,
	type VListViewOwner,
	viewStateSig,
	viewTargetSpecKey,
} from "./vlist-content-view-target";

const disposeCanvas = installCanvasStub();
afterAll(disposeCanvas);
const owner = { specKey: "tool-row" };

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("expected fixture value");
	return value;
}

function body(text = "body", extra: Partial<ToolCappedDetail> = {}): ToolCappedDetail {
	const source = extra.source ?? "output.main";
	return {
		kind: "capped",
		cap: "code",
		id: toolBodyId("call-1", source),
		source,
		format: "code",
		live: false,
		followTarget: { kind: "end" },
		text,
		...extra,
	};
}
function measured(...sections: ToolDetailSection[]) {
	return measureToolDetail({ kind: "sections", sections }, 600);
}
function target(model = body()) {
	return required(resolveDetailViewTargets(owner, measured({ key: model.source, body: model }))[0]);
}

describe("canonical tool view targets", () => {
	it("uses the original model and stable call/source identity, not the owner", () => {
		const model = body("const a = 1", { codeLangPath: "src/a.ts" });
		const t = target(model);
		expect(t.model).toBe(model);
		expect(t.id).toBe(toolBodyId("call-1", "output.main"));
		expect(t.slot).toBe("output.main");
		expect(t.owner).toEqual(owner);
		expect(t.codeLangPath).toBe("src/a.ts");
		expect(t.text).toBe("const a = 1");
	});
	it("does not confuse a height cap with missing payload", () => {
		expect(target(body("line\n".repeat(400))).truncated).toBeUndefined();
		expect(target(body("prefix", { textTruncated: true })).truncated).toBe(true);
	});
	it("preserves empty bodies and their identity before any text arrives", () => {
		const empty = target(body("", { live: true }));
		expect(empty.text).toBe("");
		expect(empty.id).toBe(target(body("new text")).id);
	});
	it("retains a markdown source and both independent truncation signals", () => {
		const text = "# Heading\n\nbody\n\n".repeat(3_000);
		const t = target(body(text, { format: "markdown", cap: "plan", textTruncated: true }));
		expect(t.text).toBe(text);
		expect(t.kind).toBe("markdown");
		expect(t.sourceInline).toBe(true);
		expect(t.truncated).toBe(true);
		expect(t.rowShowsPrefix).toBe(true);
	});
	it("skips non-text sections and uses semantic lookup through a sparse target list", () => {
		const command = body("ls", { source: "input.command" });
		const output = body("done", { textTruncated: true });
		const detail = measured(
			{ key: "input.command", label: "command", body: command },
			{ key: "error", body: { kind: "error", text: "error" } },
			{ key: "meta.file", body: { kind: "meta-rows", rows: [{ text: "a.ts" }] } },
			{ key: "output.main", label: "output", body: output },
		);
		const ts = resolveDetailViewTargets(owner, detail, {
			sections: { command: "命令", output: "输出" },
		});
		expect(ts.map((t) => t.title)).toEqual(["命令", "输出"]);
		expect(ts.map((t) => t.slot)).toEqual(["input.command", "output.main"]);
		expect(findViewTarget(ts, "output.main")?.model).toBe(output);
		expect(resolvePrimaryViewTarget(ts)?.model).toBe(output);
	});
	it("does not offer media or a missing detail", () => {
		const media = body("", { format: "media", cap: "media", media: { previewUrl: "blob:x" } });
		expect(resolveDetailViewTargets(owner, measured({ key: "output.media", body: media }))).toEqual(
			[],
		);
		expect(resolveToolDetailViewTargets(owner, { detail: null })).toEqual([]);
		expect(resolvePrimaryViewTarget([])).toBeUndefined();
	});
	it("uses the complete bounded diff source, not any selected 500-row projection", () => {
		const text = Array.from({ length: 2_000 }, (_, i) => `a${i}`).join("\n");
		const document = createDiffDocument({ oldText: text, newText: `${text}\nadded` });
		const model = body("source copy", {
			format: "diff",
			source: "input.edit",
			diffDocument: document,
			followTarget: { kind: "diff-row", focus: document.focus },
		});
		const t = target(model);
		expect(t.kind).toBe("diff");
		expect(t.model?.diffDocument).toBe(document);
		expect(t.model?.diffDocument?.oldSource.text).toBe(text);
		expect(t.model?.diffDocument?.newSource.text.endsWith("added")).toBe(true);
		expect("diff" in t).toBe(false);
	});
	it("does not change Edit identity across matching, replacing, path and final status", () => {
		const snapshots = [
			{
				status: "running",
				isStreaming: true,
				inputJson: { _streamingFieldName: "old_string", _streamingFieldValue: "old" },
			},
			{
				status: "running",
				isStreaming: true,
				inputJson: {
					_streamingFields: { old_string: "old" },
					_streamingFieldName: "new_string",
					_streamingFieldValue: "new",
				},
			},
			{
				status: "success",
				isStreaming: false,
				inputJson: { file_path: "late.ts", old_string: "old", new_string: "" },
			},
		];
		const ts = snapshots.map((snapshot) => {
			const detail = classifyToolDetail({
				toolUseId: "edit-1",
				toolName: "Edit",
				category: "file",
				...snapshot,
			});
			if (!detail) throw new Error("missing edit detail");
			return required(resolveDetailViewTargets(owner, measureToolDetail(detail, 600))[0]);
		});
		expect(new Set(ts.map((t) => t.id)).size).toBe(1);
		expect(ts.map((t) => t.kind)).toEqual(["diff", "diff", "diff"]);
		expect(ts.map((t) => t.model?.live)).toEqual([true, true, false]);
	});
});

describe("model-only fullscreen refresh", () => {
	it("keeps tools reachable without any expanded inline measurement", () => {
		const model = body("new source", { live: true, revision: 3 });
		const detail = { kind: "sections" as const, sections: [{ key: model.source, body: model }] };
		expect(resolveToolDetailModelTargets(owner, detail)[0]?.model).toBe(model);
		expect(resolveToolDetailViewTargets(owner, { detail: null })).toEqual([]);
	});
	it("keeps Send message source distinct from Agent prompt", () => {
		const prompt = body("send", { source: "input.message" });
		const result = body("result", { source: "output.main" });
		const targets = resolveSubagentModelTargets(owner, { promptBody: prompt, resultBody: result });
		expect(targets.map((item) => item.slot)).toEqual(["input.message", "output.main"]);
		expect(targets[0]?.model).toBe(prompt);
	});
});

describe("independent owner and reader preferences", () => {
	it("can move the same source into a trace without changing content identity", () => {
		const model = body();
		const detail = measured({ key: "output.main", body: model });
		const inline = required(resolveDetailViewTargets(owner, detail)[0]);
		const trace = required(
			resolveDetailViewTargets({ specKey: "trace", traceItemIndex: 7 }, detail)[0],
		);
		expect(inline.id).toBe(trace.id);
		expect(trace.owner).toEqual({ specKey: "trace", traceItemIndex: 7 });
		expect(viewTargetSpecKey(trace)).toBe("trace");
	});
	it("scopes signatures by explicit owner, never a string prefix", () => {
		const owners = new Map<string, VListViewOwner>([
			["not-an-owner-prefix", { specKey: "trace", traceItemIndex: 7 }],
			["trace:looks-related", { specKey: "trace#dup1" }],
		]);
		const wrap = new Map([
			["not-an-owner-prefix", false],
			["trace:looks-related", true],
		]);
		expect(viewStateSig(wrap, new Map(), "trace", owners)).toBe("wnot-an-owner-prefix=0");
		expect(viewStateSig(wrap, new Map(), "unrelated", owners)).toBe("");
	});
	it("has insertion-order independent and separate source/wrap signatures", () => {
		const owners = new Map([
			["a", owner],
			["b", owner],
		]);
		const a = new Map([
			["a", true],
			["b", false],
		]);
		const b = new Map([
			["b", false],
			["a", true],
		]);
		expect(viewStateSig(a, b, owner.specKey, owners)).toBe(
			viewStateSig(b, a, owner.specKey, owners),
		);
		expect(viewStateSig(a, new Map(), owner.specKey, owners)).not.toBe(
			viewStateSig(new Map(), a, owner.specKey, owners),
		);
	});
});

describe("subagent and ordinary message bodies", () => {
	it("reads prompt/result from measured models, not parallel text props", () => {
		const prompt = body("do it", { source: "input.prompt" });
		const result = body("# done", { format: "markdown" });
		const ts = resolveSubagentViewTargets(
			owner,
			{
				promptMeasured: measureToolBody(prompt, 600),
				resultMeasured: measureToolBody(result, 600),
			},
			{ title: "Result" },
			{ prompt: "Prompt" },
		);
		expect(ts.map((t) => [t.kind, t.title, t.text])).toEqual([
			["code", "Prompt", "do it"],
			["markdown", "Result", "# done"],
		]);
		expect(ts[0]?.model).toBe(prompt);
		expect(ts[1]?.sourceInline).toBe(true);
		expect(
			resolveSubagentViewTargets(owner, { promptMeasured: null, resultMeasured: null }),
		).toEqual([]);
	});
	it("keeps ordinary message BODY_SLOT and explicit owner", () => {
		const t = required(resolveRowViewTargets({ kind: "markdown", key: "m1-b0", data: "hello" })[0]);
		expect(t).toEqual({
			id: "m1-b0:body",
			slot: "body",
			owner: { specKey: "m1-b0" },
			kind: "markdown",
			text: "hello",
		});
	});
	it("keeps translation and source-view capability decisions", () => {
		const spec = {
			kind: "reasoning" as const,
			key: "thought",
			data: { text: "original", translatedText: "翻译" },
		};
		expect(resolveRowViewTargets(spec, { reasoning: "推理" })[0]?.text).toBe("翻译");
		expect(resolveRowViewTargets({ ...spec, opts: { showOriginal: true } })[0]?.text).toBe(
			"original",
		);
		expect(resolveRowViewTargets(spec)[0]?.sourceInline).toBeUndefined();
		expect(resolveRowViewTargets(spec, undefined, { sourceInline: true })[0]?.sourceInline).toBe(
			true,
		);
		expect(resolveRowViewTargets({ kind: "markdown", key: "empty", data: "" })).toEqual([]);
	});
});

describe("same-text target refresh", () => {
	it("compares live, revision, language, range and focus without comparing projections", () => {
		const model = body();
		const original = target(model);
		expect(sameViewTarget(original, target({ ...model }))).toBe(true);
		for (const patch of [
			{ live: true },
			{ revision: 2 },
			{ codeLang: "typescript" },
			{ range: createSourceText("body", { epoch: "test" }).range },
		] as const) {
			expect(sameViewTarget(original, target({ ...model, ...patch }))).toBe(false);
		}
		const document = createDiffDocument({ oldText: "same", newText: "same" });
		const diff = target({ ...model, format: "diff", diffDocument: document });
		const next = target({
			...required(diff.model),
			diffDocument: { ...document, revision: "new-revision" },
		});
		expect(sameViewTarget(diff, next)).toBe(false);
	});
});
