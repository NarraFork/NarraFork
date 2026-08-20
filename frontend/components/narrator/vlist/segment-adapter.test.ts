import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { VLIST_REGISTRY } from "./registry";
import {
	type AdapterActivityInput,
	type AdapterContext,
	type AdapterSegment,
	adaptSegment,
	adaptSegments,
	classifyContentBlock,
} from "./segment-adapter";

// The subagent-card enrichment suite exercises measureSubagentCard, which drives
// pretext's canvas measureText. Install the deterministic canvas stub so this file
// is self-contained and does not depend on another test file leaking the global
// OffscreenCanvas stub (test-order coupling → flaky under sharding).
beforeAll(() => {
	installCanvasStub();
});

const CTX: AdapterContext = { lod: 5 };

describe("classifyContentBlock", () => {
	it("routes content blocks to element kinds", () => {
		expect(classifyContentBlock({ type: "text", text: "hi" })).toBe("markdown");
		expect(classifyContentBlock({ type: "text", text: "  " })).toBeNull(); // blank
		expect(classifyContentBlock({ type: "image" })).toBe("media");
		expect(classifyContentBlock({ type: "text_file" })).toBe("media");
		expect(classifyContentBlock({ type: "image_generation" })).toBe("media");
		expect(classifyContentBlock({ type: "reasoning", text: "x" })).toBe("reasoning");
		expect(classifyContentBlock({ type: "thinking", text: "x" })).toBe("reasoning");
		expect(classifyContentBlock({ type: "web_search" })).toBe("web-search");
		expect(classifyContentBlock({ type: "tool_use" })).toBeNull(); // tool lane, not content
	});
});

describe("adaptSegment — prune divider", () => {
	it("maps to prune-divider kind", () => {
		const specs = adaptSegment({ kind: "prune-divider", label: "older" }, CTX);
		expect(specs).toHaveLength(1);
		expect(specs[0]!.kind).toBe("prune-divider");
	});
});

describe("adaptSegment — user message", () => {
	it("produces a single message-bubble with joined plain text", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "u1",
				role: "user",
				contentJson: [
					{ type: "text", text: "line1" },
					{ type: "text", text: "line2" },
				],
			},
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs).toHaveLength(1);
		expect(specs[0]!.kind).toBe("message-bubble");
		expect((specs[0]!.data as { role: string; text: string }).role).toBe("user");
		expect((specs[0]!.data as { text: string }).text).toBe("line1\nline2");
	});

	it("carries creator + createdAt so the render layer can paint the header", () => {
		const creator = { id: "u1", username: "alice", avatarColor: "#f00", avatarImageId: null };
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "u1",
				role: "user",
				createdAt: "2026-01-01T12:34:00.000Z",
				creator,
				contentJson: [{ type: "text", text: "hi" }],
			},
		};
		const specs = adaptSegment(seg, CTX);
		const data = specs[0]!.data as {
			hasHeader: boolean;
			creator: typeof creator;
			createdAt: string;
		};
		expect(data.hasHeader).toBe(true);
		expect(data.creator).toEqual(creator);
		expect(data.createdAt).toBe("2026-01-01T12:34:00.000Z");
	});

	it("defaults creator/createdAt to null when the message omits them", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "u2", role: "user", contentJson: [{ type: "text", text: "hi" }] },
		};
		const specs = adaptSegment(seg, CTX);
		const data = specs[0]!.data as { creator: unknown; createdAt: unknown };
		expect(data.creator).toBeNull();
		expect(data.createdAt).toBeNull();
	});

	// Regression: only `type === "text"` blocks used to survive, so an image the
	// user sent was dropped entirely — the virtual list showed the caption alone
	// while the classic renderer showed the picture.
	it("carries image attachments so the bubble can paint them", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "u3",
				role: "user",
				narratorId: "nar_1",
				contentJson: [
					{ type: "image", imageId: "img-1", filename: "shot.png", mediaType: "image/png" },
					{ type: "text", text: "look at this" },
				],
			},
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs).toHaveLength(1);
		const data = specs[0]!.data as {
			text: string;
			attachments: Array<Record<string, unknown>>;
		};
		expect(data.text).toBe("look at this");
		expect(data.attachments).toHaveLength(1);
		expect(data.attachments[0]!.type).toBe("image");
		expect(data.attachments[0]!.imageId).toBe("img-1");
		expect(data.attachments[0]!.filename).toBe("shot.png");
		// Upload scope falls back to the owning narrator (MessageBubble's behavior).
		expect(data.attachments[0]!.uploadNarratorId).toBe("nar_1");
	});

	it("carries the intrinsic dimensions so measure can reserve the aspect box", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "u3b",
				role: "user",
				narratorId: "nar_1",
				contentJson: [
					{
						type: "image",
						imageId: "img-2",
						filename: "wide.png",
						mediaType: "image/png",
						width: 1200,
						height: 100,
					},
				],
			},
		};
		const data = adaptSegment(seg, CTX)[0]!.data as {
			attachments: Array<Record<string, unknown>>;
		};
		expect(data.attachments[0]!.width).toBe(1200);
		expect(data.attachments[0]!.height).toBe(100);
		// A block without dimensions forwards null, not undefined, so the measure
		// input shape is stable.
		const noDims = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "u3c",
					role: "user",
					contentJson: [{ type: "image", imageId: "img-3" }],
				},
			},
			CTX,
		)[0]!.data as { attachments: Array<Record<string, unknown>> };
		expect(noDims.attachments[0]!.width).toBeNull();
		expect(noDims.attachments[0]!.height).toBeNull();
	});

	it("prefers a block's own uploadNarratorId over the message narrator", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "u4",
				role: "user",
				narratorId: "nar_panel",
				contentJson: [{ type: "image", imageId: "i", uploadNarratorId: "nar_origin" }],
			},
		};
		const data = adaptSegment(seg, CTX)[0]!.data as {
			attachments: Array<Record<string, unknown>>;
		};
		expect(data.attachments[0]!.uploadNarratorId).toBe("nar_origin");
	});

	it("carries text_file attachments with their size", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "u5",
				role: "user",
				contentJson: [
					{ type: "text_file", filename: "notes.txt", size: 2048 },
					{ type: "text", text: "see attached" },
				],
			},
		};
		const data = adaptSegment(seg, CTX)[0]!.data as {
			attachments: Array<Record<string, unknown>>;
		};
		expect(data.attachments).toHaveLength(1);
		expect(data.attachments[0]!.type).toBe("text_file");
		expect(data.attachments[0]!.size).toBe(2048);
	});

	it("omits the attachments field entirely for a plain text message", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "u6", role: "user", contentJson: [{ type: "text", text: "hi" }] },
		};
		const data = adaptSegment(seg, CTX)[0]!.data as Record<string, unknown>;
		expect("attachments" in data).toBe(false);
	});

	it("keeps an image-only message as one bubble with empty text", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "u7",
				role: "user",
				contentJson: [{ type: "image", imageId: "img-1" }],
			},
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs).toHaveLength(1);
		const data = specs[0]!.data as { text: string; attachments: unknown[] };
		expect(data.text).toBe("");
		expect(data.attachments).toHaveLength(1);
	});
});

// Regression: `commandText` was never read, so a `/command` bubble carried the
// server-side EXPANSION as its plain body — the virtual list painted a screen-tall
// prompt template where the classic renderer shows one command line.
describe("adaptSegment — user slash command", () => {
	const commandSeg = (
		commandText: string | null,
		text = "Expanded prompt body",
	): AdapterSegment => ({
		kind: "message",
		msg: {
			id: "c1",
			role: "user",
			commandText,
			contentJson: [{ type: "text", text }],
		},
	});

	it("carries commandText so the bubble can fold the expansion", () => {
		const data = adaptSegment(commandSeg("/generate-changelog"), CTX)[0]!.data as {
			commandText: string;
			text: string;
		};
		expect(data.commandText).toBe("/generate-changelog");
		// The expansion is still forwarded — the bubble previews / reveals it.
		expect(data.text).toBe("Expanded prompt body");
	});

	it("omits commandText for a plain message so its cache key is unchanged", () => {
		const plain = adaptSegment(commandSeg(null), CTX)[0]!;
		expect("commandText" in (plain.data as Record<string, unknown>)).toBe(false);
		expect(plain.opts).toBeUndefined();
	});

	it("treats an empty commandText as no command", () => {
		const data = adaptSegment(commandSeg(""), CTX)[0]!.data as Record<string, unknown>;
		expect("commandText" in data).toBe(false);
	});

	it("forwards the fold state and localized toggle labels through opts", () => {
		const ctx: AdapterContext = {
			lod: 5,
			isExpanded: (key) => (key === "c1-bubble" ? true : undefined),
			labels: {
				showExpandedPrompt: "显示展开后的提示词",
				hideExpandedPrompt: "收起展开后的提示词",
			},
		};
		const spec = adaptSegment(commandSeg("/x"), ctx)[0]!;
		expect(spec.opts).toEqual({
			expanded: true,
			showLabel: "显示展开后的提示词",
			hideLabel: "收起展开后的提示词",
		});
	});

	it("defaults the fold state to collapsed", () => {
		const spec = adaptSegment(commandSeg("/x"), CTX)[0]!;
		expect(spec.opts?.expanded).toBe(false);
	});
});

// Regression: `/bash` and tool load/unload notices are persisted with role=user
// but carry ONLY a system block, so the bubble branch painted an empty indigo box.
describe("adaptSegment — user-role system notices", () => {
	it("routes a /bash command to the bash_command system card", () => {
		const specs = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "b1",
					role: "user",
					contentJson: [{ type: "bash_command", command: "bun test" }],
				},
			},
			CTX,
		);
		expect(specs).toHaveLength(1);
		expect(specs[0]!.kind).toBe("system-text");
		const data = specs[0]!.data as { kind: string; command: string };
		expect(data.kind).toBe("bash_command");
		expect(data.command).toBe("bun test");
	});

	it("routes tool load / unload notices to their system cards", () => {
		for (const type of ["tool_loaded", "tool_unloaded"]) {
			const specs = adaptSegment(
				{
					kind: "message",
					msg: {
						id: `t-${type}`,
						role: "user",
						contentJson: [{ type, toolName: "Browser", text: `🔧 ${type}: Browser` }],
					},
				},
				CTX,
			);
			expect(specs).toHaveLength(1);
			expect(specs[0]!.kind).toBe("system-text");
			expect((specs[0]!.data as { kind: string }).kind).toBe(type);
		}
	});

	// Regression: `persistSegmentCompactMarker` writes the marker with role="user"
	// (the model must see it in history), and the marker message carries NO text
	// block at all. Routing it through the bubble branch painted an empty indigo
	// user bubble instead of the teal one-line "segment compacted (N)" indicator —
	// which is also what stripped the row of its summary-modal affordance, because
	// `resolveVListCompactTarget` only recognizes a `system-simple` payload.
	it("routes a role=user segment_compact marker to the compact indicator", () => {
		for (const status of ["compacting", "compacted"]) {
			const specs = adaptSegment(
				{
					kind: "message",
					msg: {
						id: `sc-${status}`,
						role: "user",
						contentJson: [{ type: "segment_compact", status, messageCount: 12 }],
					},
				},
				CTX,
			);
			expect(specs).toHaveLength(1);
			expect(specs[0]!.kind).toBe("system-simple");
			const data = specs[0]!.data as { kind: string; status: string };
			expect(data.kind).toBe("segment_compact");
			expect(data.status).toBe(status);
		}
	});

	it("routes a role=user FAILED segment_compact marker to the error card", () => {
		const specs = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "sc-failed",
					role: "user",
					contentJson: [{ type: "segment_compact", status: "failed", error: "oom" }],
				},
			},
			CTX,
		);
		expect(specs).toHaveLength(1);
		expect(specs[0]!.kind).toBe("system-text");
		const data = specs[0]!.data as { kind: string; text: string };
		expect(data.kind).toBe("segment_compact_failed");
		expect(data.text).toBe("oom");
	});

	// The allow-list must stay narrow: a role=user INJECTION row can carry a
	// merge_summary / review_feedback card as an EXTRA block after its leading
	// `system_injection` block (deliverInjection's `extraBlocks`). Those rows are
	// owned by the injection, so a broader allow-list would hijack them.
	it("does not hijack a role=user injection row that carries an extra card block", () => {
		const specs = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "inj",
					role: "user",
					contentJson: [
						{ type: "text", text: "review concluded" },
						{ type: "system_injection", source: "review" },
						{ type: "review_feedback", text: "Review done" },
					],
				},
			},
			CTX,
		);
		expect((specs[0]!.data as { kind?: string }).kind).not.toBe("review_feedback");
	});

	it("still renders a normal bubble for a plain user message", () => {
		const specs = adaptSegment(
			{
				kind: "message",
				msg: { id: "u9", role: "user", contentJson: [{ type: "text", text: "hi" }] },
			},
			CTX,
		);
		expect(specs[0]!.kind).toBe("message-bubble");
	});
});

describe("adaptSegment — assistant message", () => {
	it("dispatches each visible block to its kind", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "a1",
				role: "assistant",
				contentJson: [
					{ type: "reasoning", text: "thinking..." },
					{ type: "text", text: "Here is the answer." },
					{ type: "web_search", query: "cats", status: "completed" },
					{ type: "image" },
				],
			},
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs.map((s) => s.kind)).toEqual(["reasoning", "markdown", "web-search", "media"]);
	});

	it("skips blank text blocks", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "a2", role: "assistant", contentJson: [{ type: "text", text: "   " }] },
		};
		expect(adaptSegment(seg, CTX)).toHaveLength(0);
	});

	// A persisted image_generation block carries its image ONLY as `savedPath` (the
	// event handler writes the base64 to disk and keeps just the path). Dropping
	// that field left the vlist with a reserved-but-empty image box, so it must
	// reach the media payload.
	it("forwards an image_generation block's savedPath / partialSavedPath image source", () => {
		const mediaData = (block: Record<string, unknown>) =>
			adaptSegment(
				{
					kind: "message",
					msg: { id: "gen", role: "assistant", contentJson: [block as never] },
				},
				CTX,
			)[0]!.data as Record<string, unknown>;

		const saved = mediaData({
			type: "image_generation",
			savedPath: "/tmp/generated/final.png",
			width: 1024,
			height: 512,
		});
		expect(saved.savedPath).toBe("/tmp/generated/final.png");

		const partial = mediaData({
			type: "image_generation",
			status: "generating",
			partialSavedPath: "/tmp/generated/partial-0.png",
		});
		expect(partial.partialSavedPath).toBe("/tmp/generated/partial-0.png");
	});

	// The header status line wraps together with the revisedPrompt, so its text is
	// measured — it must come from the adapter (ctx.labels), not the render layer.
	it("composes the image_generation header statusText from status + labels", () => {
		const statusText = (status: string | undefined, ctx: AdapterContext) =>
			(
				adaptSegment(
					{
						kind: "message",
						msg: {
							id: `gen-${status ?? "none"}`,
							role: "assistant",
							contentJson: [{ type: "image_generation", ...(status ? { status } : {}) }],
						},
					},
					ctx,
				)[0]!.data as { statusText?: string }
			).statusText;

		const zh: AdapterContext = {
			lod: 5,
			labels: {
				imageGenerated: "已生成图片",
				imageGenerating: "正在生成图片…",
				imageGenerationPreparing: "准备生成图片…",
			},
		};
		expect(statusText("generating", zh)).toBe("正在生成图片…");
		expect(statusText("in_progress", zh)).toBe("准备生成图片…");
		expect(statusText("completed", zh)).toBe("已生成图片");
		// A persisted block has no status at all — that reads as "generated".
		expect(statusText(undefined, zh)).toBe("已生成图片");
		// No injected labels → English fallbacks (never a raw key).
		expect(statusText("completed", CTX)).toBe("Generated image");
	});

	it("omits statusText for non-generation media blocks", () => {
		const data = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "img",
					role: "assistant",
					contentJson: [{ type: "image", imageId: "i1" }],
				},
			},
			CTX,
		)[0]!.data as Record<string, unknown>;
		expect("statusText" in data).toBe(false);
	});

	it("honors visibleBlockIndices", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "a3",
				role: "assistant",
				contentJson: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
			visibleBlockIndices: [1],
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs).toHaveLength(1);
		expect(specs[0]!.data).toBe("second");
	});

	it("passes reasoning expand state via opts", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "a4", role: "assistant", contentJson: [{ type: "reasoning", text: "x" }] },
		};
		const expanded = adaptSegment(seg, { lod: 5, isExpanded: () => true });
		expect((expanded[0]!.opts as { expanded: boolean }).expanded).toBe(true);
	});

	it("passes the reasoning show-original choice via opts (height-affecting)", () => {
		// The flip changes which language is measured, so it has to be resolved
		// during adaptation — not applied at paint time over a stale height.
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "a5",
				role: "assistant",
				contentJson: [{ type: "reasoning", text: "raw", translatedText: "翻译" }],
			},
		};
		const flipped = adaptSegment(seg, { lod: 5, showOriginal: () => true });
		expect((flipped[0]!.opts as { showOriginal: boolean }).showOriginal).toBe(true);
		const dflt = adaptSegment(seg, { lod: 5 });
		expect((dflt[0]!.opts as { showOriginal: boolean }).showOriginal).toBe(false);
	});

	it("ignores show-original on a run that was never translated", () => {
		// Nothing to flip to: claiming otherwise would paint a toggle-state the
		// measure layer cannot honour.
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "a6", role: "assistant", contentJson: [{ type: "reasoning", text: "raw" }] },
		};
		const specs = adaptSegment(seg, { lod: 5, showOriginal: () => true });
		expect((specs[0]!.opts as { showOriginal: boolean }).showOriginal).toBe(false);
	});
});

describe("adaptSegment — system message", () => {
	it("routes plan subtype to plan-card", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "s1",
				role: "system",
				contentJson: [{ type: "compact", subtype: "plan", summary: "the plan" }],
			},
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs[0]!.kind).toBe("plan-card");
	});

	it("routes compact to system-simple", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "s2", role: "system", contentJson: [{ type: "compact" }] },
		};
		expect(adaptSegment(seg, CTX)[0]!.kind).toBe("system-simple");
	});

	it("routes error to system-text", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "s3", role: "system", contentJson: [{ type: "error", text: "boom" }] },
		};
		expect(adaptSegment(seg, CTX)[0]!.kind).toBe("system-text");
	});
});

describe("adaptSegment — system card body composition (height-critical)", () => {
	/**
	 * The card's own data projection.
	 *
	 * Some system cards are now WRAPPED in a speaker bubble (`injection-bubble`), which
	 * carries the card's data untouched under `payload.data`. These assertions are about
	 * the projection, not the wrapping, so unwrap one level when present — that keeps them
	 * testing the same property before and after the framing change.
	 */
	const sysData = (
		contentJson: Array<{ type: string; [key: string]: unknown }>,
		ctx: AdapterContext = CTX,
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
	): any => {
		const spec = adaptSegment(
			{ kind: "message", msg: { id: "s", role: "system", contentJson } },
			ctx,
		)[0]!;
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
		const data = spec.data as any;
		return spec.kind === "injection-bubble" ? data.payload.data : data;
	};

	it("info: reads block.message (not empty block.text) as the wrapping body", () => {
		// persistDisplayMessage writes `[{ type: "info", message }]` with role=disp;
		// reading only block.text measured an empty card (the cwd-change regression).
		const data = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "d1",
					role: "disp",
					contentJson: [{ type: "info", message: "Working directory updated: /a/old → /a/new" }],
				},
			},
			CTX,
		)[0]!.data as { kind: string; text: string };
		expect(data.kind).toBe("info");
		expect(data.text).toBe("Working directory updated: /a/old → /a/new");
	});

	it("info: falls back to block.text, then to the leading text block", () => {
		expect(sysData([{ type: "info", text: "plain body" }]).text).toBe("plain body");
		expect(sysData([{ type: "text", text: "leading" }, { type: "info" }]).text).toBe("leading");
	});

	it("unrecognized system block: still reads message as the body", () => {
		const data = sysData([{ type: "totally_unknown_kind", message: "notice body" }]);
		expect(data.kind).toBe("info");
		expect(data.text).toBe("notice body");
	});

	it("error: reads block.message (not empty block.text) as the wrapping body", () => {
		const data = sysData([{ type: "error", message: "module not found 'foo'" }]);
		expect(data.kind).toBe("error");
		expect(data.text).toBe("module not found 'foo'");
		expect(data.actions).toBe(true);
	});

	it("error: falls back to unknownError label when no message", () => {
		expect(sysData([{ type: "error" }]).text).toBe("Unknown error");
		expect(sysData([{ type: "error" }], { lod: 5, labels: { unknownError: "错误" } }).text).toBe(
			"错误",
		);
	});

	it("spec_goal_added: composes task text + protected/added badges + view button", () => {
		const data = sysData([
			{ type: "spec_goal_added", task: "Implement zero-DOM model", added: true },
		]);
		expect(data.kind).toBe("spec_goal_added");
		expect(data.text).toBe("Implement zero-DOM model");
		expect(data.added).toBe(true);
		expect(data.badges).toEqual(["Protected", "Goal added"]);
		expect(data.buttons).toEqual(["View tasks"]);
	});

	it("spec_goal_added: added=false → 'already tracked' badge; falls back to contentText", () => {
		const data = sysData([
			{ type: "text", text: "the objective" },
			{ type: "spec_goal_added", added: false },
		]);
		expect(data.text).toBe("the objective");
		expect(data.added).toBe(false);
		expect(data.badges[1]).toBe("Already tracked");
	});

	it("spec_continuation: framed as a bubble task row (glyph + lock + wrapping text)", () => {
		// The Dynamic Spec continuation is a framed BUBBLE whose body is a task row the
		// bubble draws itself — not the clamped single-line card it used to nest.
		const spec = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "s",
					role: "system",
					contentJson: [{ type: "spec_continuation", task: "Wire the flag", protected: true }],
				},
			},
			CTX,
		)[0]!;
		expect(spec.kind).toBe("injection-bubble");
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
		const payload = (spec.data as any).payload;
		expect(payload.kind).toBe("spec-task");
		expect(payload.data).toEqual({ text: "Wire the flag", protected: true, blocked: false });
	});

	it("spec_blocked_continuation: blocked flag flips the task row's tone", () => {
		const spec = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "s",
					role: "system",
					contentJson: [{ type: "spec_blocked_continuation", task: "Blocked task" }],
				},
			},
			CTX,
		)[0]!;
		expect(spec.kind).toBe("injection-bubble");
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
		const payload = (spec.data as any).payload;
		expect(payload.kind).toBe("spec-task");
		expect(payload.data).toEqual({ text: "Blocked task", protected: false, blocked: true });
	});

	it("spec_fork_carryover: composes a summary description from counts", () => {
		const data = sysData([{ type: "spec_fork_carryover", total: 3, open: 2, protectedOpen: 1 }]);
		expect(data.kind).toBe("spec_fork_carryover");
		expect(data.variant).toBe("fork");
		expect(data.text).toContain("3");
		expect(data.text).toContain("2");
		expect(data.text).toContain("1");
		expect(data.buttons).toHaveLength(3);
	});

	it("spec_fork_carryover: uses injected localized template with placeholders", () => {
		const data = sysData([{ type: "spec_fork_carryover", total: 5, open: 4, protectedOpen: 2 }], {
			lod: 5,
			labels: { specForkCarryoverDesc: "带入 {count} 项（{open} 未完成，{protectedOpen} 受保护）" },
		});
		expect(data.text).toBe("带入 5 项（4 未完成，2 受保护）");
	});

	it("spec_context_cleared: contextCleared variant", () => {
		const data = sysData([{ type: "spec_context_cleared", total: 1, open: 1, protectedOpen: 0 }]);
		expect(data.kind).toBe("spec_context_cleared");
		expect(data.variant).toBe("contextCleared");
	});

	it("segment_compact failed → system-text card with title + dismiss; else simple", () => {
		const failed = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "s",
					role: "system",
					contentJson: [{ type: "segment_compact", status: "failed", error: "oom" }],
				},
			},
			CTX,
		)[0]!;
		expect(failed.kind).toBe("system-text");
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
		const fdata = failed.data as any;
		expect(fdata.kind).toBe("segment_compact_failed");
		expect(fdata.text).toBe("oom");
		expect(fdata.title).toBe("Compaction failed");
		expect(fdata.buttons).toEqual(["Dismiss"]);

		const compacting = sysData([{ type: "segment_compact", status: "compacting", text: "…" }]);
		expect(compacting.kind).toBe("segment_compact");
		expect(compacting.status).toBe("compacting");
	});

	it("merge_summary: reserves avatar", () => {
		const merge = sysData([{ type: "merge_summary", text: "Merged X into trunk" }]);
		expect(merge.kind).toBe("merge_summary");
		expect(merge.hasAvatar).toBe(true);
		expect(merge.text).toBe("Merged X into trunk");
	});

	it("bash_command: carries the command as both body text and command field", () => {
		const data = sysData([{ type: "bash_command", command: "bun test" }]);
		expect(data.kind).toBe("bash_command");
		expect(data.text).toBe("bun test");
		expect(data.command).toBe("bun test");
	});
});

describe("adaptSegment — compact / segment_compact indicator text (status-synthesized)", () => {
	const compactSpec = (
		contentJson: Array<{ type: string; [key: string]: unknown }>,
		ctx: AdapterContext = CTX,
	) => adaptSegment({ kind: "message", msg: { id: "s", role: "system", contentJson } }, ctx)[0]!;

	// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
	const dataOf = (spec: { data: unknown }) => spec.data as any;

	const COMPACT_LABELS = {
		compacting: "压缩上下文中...",
		compacted: "上下文已压缩",
		compactFailed: "压缩失败",
		compactOutputChars: "{count} 字符",
		compactThinking: "思考中",
		compactThinkingChars: "{count} 字符",
		segmentCompacting: "正在区段压缩...",
		segmentCompacted: "区段已压缩（{count} 条消息）",
	};

	it("context compact compacting → '…compacting · N chars' (English fallback), never block.summary", () => {
		const spec = compactSpec([
			{ type: "compact", status: "compacting", outputChars: 42, summary: "SHOULD NOT SHOW" },
		]);
		expect(spec.kind).toBe("system-simple");
		expect(dataOf(spec).kind).toBe("compact");
		expect(dataOf(spec).status).toBe("compacting");
		expect(dataOf(spec).text).toBe("Compacting context… · 42 chars");
	});

	it("context compact compacting → localized labels substitute the live count", () => {
		const spec = compactSpec([{ type: "compact", status: "compacting", outputChars: 128 }], {
			lod: 5,
			labels: COMPACT_LABELS,
		});
		expect(dataOf(spec).text).toBe("压缩上下文中... · 128 字符");
	});

	it("context compact compacting → opts.progress folds the live count into the cache key", () => {
		const at0 = compactSpec([{ type: "compact", status: "compacting", outputChars: 0 }]);
		const at99 = compactSpec([{ type: "compact", status: "compacting", outputChars: 99 }]);
		expect(at0.opts?.progress).toBe(0);
		expect(at99.opts?.progress).toBe(99);
	});

	it("thinking phase features the thinking count instead of a stuck '0 chars'", () => {
		const spec = compactSpec([
			{ type: "compact", status: "compacting", progressPhase: "thinking", thinkingChars: 240 },
		]);
		expect(dataOf(spec).text).toBe("Compacting context… · thinking · 240 chars");
	});

	it("thinking phase below the display threshold shows the bare label", () => {
		// A handful of characters conveys nothing and just makes the label flicker.
		const spec = compactSpec([
			{ type: "compact", status: "compacting", progressPhase: "thinking", thinkingChars: 3 },
		]);
		expect(dataOf(spec).text).toBe("Compacting context… · thinking");
	});

	it("thinking phase uses localized labels", () => {
		const spec = compactSpec(
			[{ type: "compact", status: "compacting", progressPhase: "thinking", thinkingChars: 55 }],
			{ lod: 5, labels: COMPACT_LABELS },
		);
		expect(dataOf(spec).text).toBe("压缩上下文中... · 思考中 · 55 字符");
	});

	it("a block with no phase field keeps the previous output-only label", () => {
		// Backward compatibility: a marker persisted before the two-phase change.
		const spec = compactSpec([{ type: "compact", status: "compacting", outputChars: 42 }]);
		expect(dataOf(spec).text).toBe("Compacting context… · 42 chars");
	});

	it("the phase and thinking count join the measure cache key", () => {
		// The label changes while the height (one clamped line) never does, so the
		// digest must move or the stale text would be served from the cache.
		const thinking = compactSpec([
			{ type: "compact", status: "compacting", progressPhase: "thinking", thinkingChars: 30 },
		]);
		const output = compactSpec([
			{ type: "compact", status: "compacting", progressPhase: "output", outputChars: 30 },
		]);
		expect(thinking.opts?.phase).toBe("thinking");
		expect(thinking.opts?.thinking).toBe(30);
		expect(output.opts?.phase).toBe("output");
		expect(output.opts?.thinking).toBe(0);
	});

	it("segment compact reports the thinking phase too", () => {
		const spec = compactSpec([
			{
				type: "segment_compact",
				status: "compacting",
				progressPhase: "thinking",
				thinkingChars: 90,
			},
		]);
		expect(dataOf(spec).text).toBe("Segment compacting… · thinking · 90 chars");
		expect(spec.opts?.phase).toBe("thinking");
	});

	it("context compact compacted → terse 'compacted' label, NOT the summary body", () => {
		const spec = compactSpec([
			{ type: "compact", status: "compacted", summary: "a very long compact summary body" },
		]);
		expect(dataOf(spec).status).toBe("compacted");
		expect(dataOf(spec).text).toBe("Context compacted");
		// A completed marker is stable (cacheable): no progress opt.
		expect(spec.opts?.progress).toBeUndefined();
	});

	it("context compact failed → 'compact failed' label and failed status", () => {
		const spec = compactSpec([{ type: "compact", status: "failed", error: "boom" }]);
		expect(dataOf(spec).status).toBe("failed");
		expect(dataOf(spec).text).toBe("Compact failed");
	});

	it("segment_compact compacting → '…segment compacting · N chars' + progress opt", () => {
		const spec = compactSpec([{ type: "segment_compact", status: "compacting", outputChars: 7 }]);
		expect(dataOf(spec).kind).toBe("segment_compact");
		expect(dataOf(spec).status).toBe("compacting");
		expect(dataOf(spec).text).toBe("Segment compacting… · 7 chars");
		expect(spec.opts?.progress).toBe(7);
	});

	it("segment_compact compacted → 'segment compacted (N messages)', not summary", () => {
		const spec = compactSpec([
			{ type: "segment_compact", status: "compacted", messageCount: 12, summary: "hidden body" },
		]);
		expect(dataOf(spec).status).toBe("compacted");
		expect(dataOf(spec).text).toBe("Segment compacted (12 messages)");
		expect(spec.opts?.progress).toBeUndefined();
	});

	it("segment_compact compacted → localized message-count label", () => {
		const spec = compactSpec([{ type: "segment_compact", status: "compacted", messageCount: 3 }], {
			lod: 5,
			labels: COMPACT_LABELS,
		});
		expect(dataOf(spec).text).toBe("区段已压缩（3 条消息）");
	});
});

describe("adaptSegment — tool run", () => {
	it("maps subagent items to subagent-card and others to tool-call (L5, full cards)", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", summary: "read a file" } },
				{ blockIndex: 1, isSubagent: true, tc: { toolName: "Agent", summary: "spawn" } },
			],
		};
		const specs = adaptSegment(seg, CTX);
		expect(specs.map((s) => s.kind)).toEqual(["tool-call", "subagent-card"]);
	});

	it("L3 keeps every completed tool as its own full card", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", status: "completed" } },
				{ blockIndex: 1, isSubagent: false, tc: { toolName: "Bash", status: "completed" } },
			],
		};
		const specs = adaptSegment(seg, { lod: 3 });
		expect(specs.map((s) => s.kind)).toEqual(["tool-call", "tool-call"]);
		// L3's compression is per-CARD (each collapses to its header), not a fold.
		expect(specs.every((s) => s.opts?.collapsesByLod === true)).toBe(true);
	});

	it("L2 folds completed tools into a tool-run-count", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", status: "completed" } },
				{ blockIndex: 1, isSubagent: false, tc: { toolName: "Bash", status: "completed" } },
				{ blockIndex: 2, isSubagent: false, tc: { toolName: "Grep", status: "completed" } },
			],
		};
		const specs = adaptSegment(seg, { lod: 2 });
		expect(specs).toHaveLength(1);
		expect(specs[0]!.kind).toBe("tool-run-count");
		expect((specs[0]!.data as { count: number }).count).toBe(3);
	});

	it("the pinned latest-tasks card stays a full card while neighbours fold", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: { toolUseId: "t-old", toolName: "Read", status: "completed" },
				},
				{
					blockIndex: 1,
					isSubagent: false,
					tc: { toolUseId: "t-tasks", toolName: "Write", status: "completed" },
				},
				{
					blockIndex: 2,
					isSubagent: false,
					tc: { toolUseId: "t-new", toolName: "Bash", status: "completed" },
				},
			],
		};
		const pin = { resolveLatestSpecTasksToolUseId: () => "t-tasks" };

		// L2: the pinned call escapes the count fold; the rest still fold.
		const l2 = adaptSegment(seg, { lod: 2, ...pin });
		expect(l2.map((s) => s.kind)).toEqual(["tool-run-count", "tool-call", "tool-run-count"]);
		expect(l2[1]!.key).toBe("tool-t-tasks");
		expect(l2[1]!.opts?.forceExpanded).toBe(true);

		// L3: no fold exists, so all three are cards — and only the pinned one carries
		// `forceExpanded`, which the measure layer honours over the level's collapse.
		const l3 = adaptSegment(seg, { lod: 3, ...pin });
		expect(l3.map((s) => s.kind)).toEqual(["tool-call", "tool-call", "tool-call"]);
		expect(l3[1]!.opts?.forceExpanded).toBe(true);
		expect(l3[0]!.opts?.forceExpanded).toBeUndefined();

		// No resolver → everything folds exactly as before.
		const unpinned = adaptSegment(seg, { lod: 2 });
		expect(unpinned).toHaveLength(1);
		expect(unpinned[0]!.kind).toBe("tool-run-count");
	});

	it("L3 keeps every card full but still flags the pinned card forceExpanded", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: { toolUseId: "t-tasks", toolName: "Write", status: "completed" },
				},
				{
					blockIndex: 1,
					isSubagent: false,
					tc: { toolUseId: "t-other", toolName: "Bash", status: "completed" },
				},
			],
		};
		const specs = adaptSegment(seg, {
			lod: 3,
			resolveLatestSpecTasksToolUseId: () => "t-tasks",
		});
		expect(specs.map((s) => s.kind)).toEqual(["tool-call", "tool-call"]);
		expect(specs[0]!.opts?.forceExpanded).toBe(true);
		expect(specs[1]!.opts?.forceExpanded).toBeUndefined();
	});

	it("keeps active tools as standalone full cards even at low LOD", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", status: "completed" } },
				{ blockIndex: 1, isSubagent: false, tc: { toolName: "Bash", status: "running" } },
				{ blockIndex: 2, isSubagent: false, tc: { toolName: "Grep", status: "completed" } },
			],
		};
		const specs = adaptSegment(seg, { lod: 2 });
		// completed(0) → count, active(1) → full tool-call, completed(2) → count
		expect(specs.map((s) => s.kind)).toEqual(["tool-run-count", "tool-call", "tool-run-count"]);
	});
});

describe("adaptSegment — subagent card enrichment (height-safe field passthrough)", () => {
	const subagentData = (
		tc: Record<string, unknown>,
		ctx: AdapterContext = CTX,
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
	): any => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			// biome-ignore lint/suspicious/noExplicitAny: structural tc mirror for the test
			items: [{ blockIndex: 0, isSubagent: true, tc: tc as any }],
		};
		const spec = adaptSegment(seg, ctx)[0]!;
		expect(spec.kind).toBe("subagent-card");
		return spec.data;
	};

	it("wires prompt, isBackground, agentType, description from inputJson", () => {
		const data = subagentData({
			toolName: "Task",
			status: "running",
			inputJson: {
				subagent_type: "explore",
				prompt: "Investigate the failing test",
				description: "look at flaky test",
				run_in_background: true,
			},
		});
		expect(data.prompt).toBe("Investigate the failing test");
		expect(data.isBackground).toBe(true);
		expect(data.agentType).toBe("explore");
		expect(data.description).toBe("look at flaky test");
	});

	it("derives description from prompt when no explicit description", () => {
		const data = subagentData({
			toolName: "Task",
			status: "running",
			inputJson: { prompt: "single line prompt" },
		});
		expect(data.prompt).toBe("single line prompt");
		expect(data.description).toBe("single line prompt");
		expect(data.isBackground).toBe(false);
		expect(data.agentType).toBe("Task");
	});

	it("truncates multi-line prompt to first 80 chars for description", () => {
		const longFirst = "x".repeat(120);
		const data = subagentData({
			toolName: "Task",
			status: "running",
			inputJson: { prompt: `${longFirst}\nsecond line` },
		});
		expect(data.description).toBe(longFirst.slice(0, 80));
	});

	it("reads prompt from `message` and agentType 'send' for Send tools", () => {
		const data = subagentData({
			toolName: "Send",
			status: "success",
			inputJson: { message: "please continue" },
		});
		expect(data.prompt).toBe("please continue");
		expect(data.agentType).toBe("send");
	});

	it("maps the effective reasoning effort from the activity summary", () => {
		const data = subagentData({
			toolName: "Task",
			status: "running",
			inputJson: { subagent_type: "explore", reasoning_effort: "low" },
			_subagentActivity: { latestToolCalls: [], model: "sonnet", reasoningEffort: "high" },
		});
		// The activity summary carries the child narrator's EFFECTIVE tier, so it
		// wins over the tier the tool call merely requested.
		expect(data.reasoningEffort).toBe("high");
	});

	it("falls back to the requested tool input (both key spellings)", () => {
		expect(
			subagentData({
				toolName: "Task",
				status: "running",
				inputJson: { reasoning_effort: "medium" },
			}).reasoningEffort,
		).toBe("medium");
		expect(
			subagentData({
				toolName: "Task",
				status: "running",
				inputJson: { reasoningEffort: "xhigh" },
			}).reasoningEffort,
		).toBe("xhigh");
	});

	it("omits reasoningEffort when no source carries one (no fabrication)", () => {
		const data = subagentData({
			toolName: "Task",
			status: "running",
			inputJson: {},
			_subagentActivity: { latestToolCalls: [], model: "sonnet", reasoningEffort: null },
		});
		expect("reasoningEffort" in data).toBe(false);
	});

	it("omits prompt when inputJson carries none (no fabrication)", () => {
		const data = subagentData({
			toolName: "Task",
			status: "success",
			inputJson: {},
		});
		expect("prompt" in data).toBe(false);
		expect(data.isBackground).toBe(false);
	});

	// ── conclusion body (the shared extraction rule) ────────────────────────────
	// This block used to accept ONLY a bare-string `outputJson`, so the ~43% of real
	// rows whose output is the runner's `{_text, _metadata}` envelope produced a
	// finished card with a blank conclusion — no result body expanded, no preview
	// line collapsed.
	it("extracts resultText from a bare-string output, stripping the addressing tag", () => {
		const data = subagentData({
			toolName: "Task",
			status: "success",
			inputJson: { description: "d" },
			outputJson: "<subagent_id>abc</subagent_id>\n\nthe conclusion",
		});
		expect(data.resultText).toBe("the conclusion");
		expect(data.resultPreview).toBe("the conclusion");
	});

	it("extracts resultText from the {_text, _metadata} envelope output", () => {
		const data = subagentData({
			toolName: "Task",
			status: "success",
			inputJson: { description: "d" },
			outputJson: {
				_text: "<subagent_id>abc</subagent_id>\n\n# 结论\n\n正文",
				_metadata: { execDurationMs: 31 },
			},
		});
		expect(data.resultText).toBe("# 结论\n\n正文");
		expect(data.resultPreview).toBe("# 结论\n\n正文");
	});

	it("shows a truncated envelope body as its preview rather than a JSON dump", () => {
		const data = subagentData({
			toolName: "Task",
			status: "success",
			inputJson: { description: "d" },
			outputJson: { _text: { _truncated: true, preview: "cut body", fullLength: 9000 } },
		});
		expect(data.resultText).toBe("cut body");
	});

	it("caps resultPreview at 120 chars while resultText keeps the full body", () => {
		const body = "y".repeat(300);
		const data = subagentData({
			toolName: "Task",
			status: "success",
			inputJson: { description: "d" },
			outputJson: { _text: body },
		});
		expect(data.resultText).toBe(body);
		expect(data.resultPreview).toBe(body.slice(0, 120));
	});

	it("omits resultText when the output carries nothing readable (no fabrication)", () => {
		for (const outputJson of [null, undefined, "<subagent_id>only-a-tag</subagent_id>"]) {
			const data = subagentData({
				toolName: "Task",
				status: "success",
				inputJson: { description: "d" },
				outputJson,
			});
			expect(data.resultText).toBeUndefined();
			expect(data.resultPreview).toBeUndefined();
		}
	});

	it("substitutes the fetched full output once the shell resolved it", () => {
		const ctx: AdapterContext = {
			...CTX,
			resolveFullToolOutput: () => ({ _text: "the complete conclusion" }),
		};
		const data = subagentData(
			{
				toolName: "Task",
				status: "success",
				toolUseId: "tu-full",
				inputJson: { description: "d" },
				outputJson: { _text: { _truncated: true, preview: "cut", fullLength: 9000 } },
			},
			ctx,
		);
		expect(data.resultText).toBe("the complete conclusion");
	});

	it("remains height-safe: measureSubagentCard consumes the enriched data", async () => {
		const { measureSubagentCard } = await import("./measure/measure-subagent");
		const data = subagentData({
			toolName: "Task",
			status: "running",
			inputJson: { subagent_type: "plan", prompt: "line one\nline two\nline three" },
		});
		// Prompt-open path exercises the ContentViewer maxHeight cap.
		const measured = measureSubagentCard({ ...data, promptOpen: true }, 400, 5, { opened: true });
		expect(measured.height).toBeGreaterThan(0);
		expect(measured.promptBlockHeight).toBeGreaterThan(0);
		expect(Number.isFinite(measured.height)).toBe(true);
	});
});

describe("groupToolItemsForLod / isActiveToolItem", () => {
	it("classifies active statuses", async () => {
		const { isActiveToolItem } = await import("./segment-adapter");
		expect(
			isActiveToolItem({
				blockIndex: 0,
				isSubagent: false,
				tc: { toolName: "x", status: "running" },
			}),
		).toBe(true);
		expect(
			isActiveToolItem({
				blockIndex: 0,
				isSubagent: false,
				tc: { toolName: "x", status: "pending" },
			}),
		).toBe(true);
		expect(
			isActiveToolItem({
				blockIndex: 0,
				isSubagent: false,
				tc: { toolName: "x", status: "completed" },
			}),
		).toBe(false);
	});

	it("folds contiguous completed batches, breaks on active", async () => {
		const { groupToolItemsForLod } = await import("./segment-adapter");
		const items = [
			{ blockIndex: 0, isSubagent: false, tc: { toolName: "a", status: "completed" } },
			{ blockIndex: 1, isSubagent: false, tc: { toolName: "b", status: "running" } },
			{ blockIndex: 2, isSubagent: false, tc: { toolName: "c", status: "completed" } },
			{ blockIndex: 3, isSubagent: false, tc: { toolName: "d", status: "completed" } },
		];
		const groups = groupToolItemsForLod(items);
		expect(groups.map((g) => g.kind)).toEqual(["folded", "active", "folded"]);
	});
});

describe("adaptActivityUnit", () => {
	const collapsedOf = (spec: { opts?: Record<string, unknown> }) =>
		(spec.opts as { collapsed: boolean }).collapsed;
	/** One folded tool row owned by `messageId`. */
	const toolItem = (messageId: string): AdapterActivityInput => ({
		kind: "tool",
		msg: { id: messageId, role: "assistant", contentJson: [] },
	});

	it("produces an activity-trace; L2 always shows rows", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const l2 = adaptActivityUnit([toolItem("old")], "act-1", {
			lod: 2,
			recentMessageIds: new Set<string>(),
		});
		expect(l2.kind).toBe("activity-trace");
		expect(collapsedOf(l2)).toBe(false);
	});

	it("L1 collapses HISTORY but keeps the current run's rows on screen", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		// Older activity folds behind the header…
		const old = adaptActivityUnit([toolItem("old")], "act-1", {
			lod: 1,
			recentMessageIds: new Set(["fresh"]),
		});
		expect(collapsedOf(old)).toBe(true);
		// …while the recency window (the same one L5 uses) stays open. It only moves
		// when the user sends a new message, so a run that FINISHES does not re-fold
		// under the reader — that self-inflicted jump is what this avoids.
		const recent = adaptActivityUnit([toolItem("fresh")], "act-2", {
			lod: 1,
			recentMessageIds: new Set(["fresh"]),
		});
		expect(collapsedOf(recent)).toBe(false);
	});

	it("L1 keeps LIVE output expanded regardless of the recency window", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const live = adaptActivityUnit([toolItem("__streaming__")], "act-3", {
			lod: 1,
			recentMessageIds: new Set<string>(),
		});
		expect(collapsedOf(live)).toBe(false);
	});

	it("L1 with no recency resolver stays expanded (never hide rows mid-stream)", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const noResolver = adaptActivityUnit([toolItem("x")], "act-4", { lod: 1 });
		expect(collapsedOf(noResolver)).toBe(false);
	});
});

/**
 * The hand-off contract, end to end through the REAL low-LOD pipeline.
 *
 * A live tool and its persisted counterpart must produce a trace row that is
 * IDENTICAL in every field the renderer positions or draws: same row key (React
 * reuses the DOM node), same category glyph, same colour, same `unitId`. Anything
 * that differs here becomes a visible jump the instant the turn is stored — the
 * icon sliding sideways / resizing is exactly what these fields control.
 */
describe("live → persisted hand-off is visually inert", () => {
	/** One assistant message holding a single Read tool call. */
	const toolMessage = (messageId: string, status: string, streaming: boolean) => {
		const input = streaming
			? { _streamingChars: 42, _streamingFilePath: "spec://tasks.json" }
			: { file_path: "spec://tasks.json" };
		return {
			id: messageId,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu-1", name: "Read", input }],
			toolCalls: [{ id: "call-1", toolUseId: "tu-1", toolName: "Read", status, inputJson: input }],
			children: [],
		} as never;
	};

	const rowsFor = async (messageId: string, status: string, streaming: boolean) => {
		const { segmentMessages } = await import("../message-segments");
		const { groupRenderUnits } = await import("../render-units");
		const { adaptRenderUnits } = await import("./segment-adapter");
		const { getCategory, getCategoryColor } = await import("../tool-display");
		const units = groupRenderUnits(
			segmentMessages([toolMessage(messageId, status, streaming)] as never),
			true,
		);
		const specs = adaptRenderUnits(units as never, {
			lod: 2,
			resolveToolCategory: getCategory,
			resolveToolColor: (name, input) => getCategoryColor(getCategory(name, input)),
		});
		return specs;
	};

	it("keeps the row key, glyph, colour and unitId identical across the hand-off", async () => {
		// While streaming the tool is `running` under the synthetic message id…
		const live = await rowsFor("__streaming__", "running", true);
		// …and once stored it is `success` under a real one.
		const persisted = await rowsFor("real-msg", "success", false);

		expect(live[0]?.kind).toBe("activity-trace");
		expect(persisted[0]?.kind).toBe("activity-trace");

		const rowOf = (specs: typeof live) =>
			(specs[0]?.data as { items: Record<string, unknown>[] }).items[0];
		const liveRow = rowOf(live);
		const persistedRow = rowOf(persisted);

		// The React key: a change here rebuilds the node instead of reusing it.
		expect(liveRow?.key).toBe("tool-tu-1");
		expect(persistedRow?.key).toBe(liveRow?.key);
		// The glyph + tint. `spec://tasks.json` is the case that used to break: the
		// streaming payload carries the path as `_streamingFilePath`, so the category
		// resolved to `read` while live and `tasks` once persisted — a different icon.
		expect(liveRow?.category).toBe("tasks");
		expect(persistedRow?.category).toBe(liveRow?.category);
		expect(persistedRow?.iconColor).toBe(liveRow?.iconColor);
		// The cross-LOD pairing id.
		expect(liveRow?.unitId).toBe("tool-tu-1");
		expect(persistedRow?.unitId).toBe(liveRow?.unitId);
	});

	it("shimmers only while the tool is live", async () => {
		const live = await rowsFor("__streaming__", "running", true);
		const persisted = await rowsFor("real-msg", "success", false);
		const statusOf = (specs: typeof live) =>
			((specs[0]?.data as { items: Record<string, unknown>[] }).items[0] ?? {}).status;
		// The status is what the renderer's glyph reads; it is the ONLY thing that may
		// differ, and it occupies a fixed 12px slot.
		expect(statusOf(live)).toBe("running");
		expect(statusOf(persisted)).toBe("success");
	});
});

/**
 * ⚠️ Folded-row identity. The activity fold walks reasoning blocks ONE BY ONE,
 * while the selection index merges adjacent reasoning blocks and registers an
 * entry only for the run's START index. A row must therefore report the run start,
 * or its blockId would match no entry and every selection action on it would
 * silently do nothing. These tests pin that mapping on the vlist/adapter path
 * (the frontend path is covered by trace-row-identity.test.ts).
 */
describe("adaptActivityUnit — folded row identity", () => {
	const reasoning = (text: string) => ({ type: "reasoning", text });
	const msgWith = (blocks: unknown[], id = "m1") =>
		({ id, role: "assistant", contentJson: blocks }) as never;

	it("maps every row of an adjacent reasoning run to the run's start index", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const blocks = [reasoning("**A**\n\nfirst"), reasoning("**B**\n\nsecond")];
		const msg = msgWith(blocks);
		const spec = adaptActivityUnit(
			[
				{ kind: "reasoning", msg, blockIndex: 0, block: blocks[0] as never },
				{ kind: "reasoning", msg, blockIndex: 1, block: blocks[1] as never },
			],
			"act-1",
			{ lod: 2 },
		);
		const items = (spec.data as { items: { identity?: Record<string, unknown> }[] }).items;
		expect(items.length).toBeGreaterThanOrEqual(2);
		// Both source blocks fold into rows that identify as the run start (0), and
		// carry the run's full index list so delete can act on each.
		for (const item of items) {
			expect(item.identity?.messageId).toBe("m1");
			expect(item.identity?.blockIndex).toBe(0);
			expect(item.identity?.blockIndices).toEqual([0, 1]);
		}
	});

	it("keeps runs split by a tool call on their own start indices", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const blocks = [
			reasoning("first"),
			{ type: "tool_use", id: "tu-1", name: "Read" },
			reasoning("second"),
			reasoning("third"),
		];
		const msg = msgWith(blocks);
		const spec = adaptActivityUnit(
			[
				{ kind: "reasoning", msg, blockIndex: 2, block: blocks[2] as never },
				{ kind: "reasoning", msg, blockIndex: 3, block: blocks[3] as never },
			],
			"act-1",
			{ lod: 2 },
		);
		const items = (spec.data as { items: { identity?: Record<string, unknown> }[] }).items;
		for (const item of items) {
			expect(item.identity?.blockIndex).toBe(2);
			expect(item.identity?.blockIndices).toEqual([2, 3]);
		}
	});

	it("carries toolUseId on tool rows and omits identity for streaming rows", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const msg = msgWith([{ type: "tool_use", id: "tu-9", name: "Read" }]);
		const spec = adaptActivityUnit(
			[{ kind: "tool", msg, blockIndex: 0, tc: { toolName: "Read", toolUseId: "tu-9" } }],
			"act-1",
			{ lod: 2 },
		);
		const items = (spec.data as { items: { identity?: Record<string, unknown> }[] }).items;
		expect(items[0]?.identity?.toolUseId).toBe("tu-9");
		expect(items[0]?.identity?.toolName).toBe("Read");

		// Streaming output has no committed message → non-selectable.
		const streaming = adaptActivityUnit(
			[
				{
					kind: "tool",
					msg: msgWith([], "__streaming__"),
					blockIndex: 0,
					tc: { toolName: "Read", toolUseId: "tu-9" },
				},
			],
			"act-2",
			{ lod: 2 },
		);
		const streamItems = (streaming.data as { items: { identity?: unknown }[] }).items;
		expect(streamItems[0]?.identity).toBeUndefined();
	});

	it("omits identity for a tool call without a toolUseId (no selection entry)", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const spec = adaptActivityUnit(
			[{ kind: "tool", msg: msgWith([]), blockIndex: 0, tc: { toolName: "Read" } }],
			"act-1",
			{ lod: 2 },
		);
		const items = (spec.data as { items: { identity?: unknown }[] }).items;
		expect(items[0]?.identity).toBeUndefined();
	});
});

/**
 * Drill-down: a folded tool row carries its FULL card payload only once the reader
 * opened it. The "only once opened" half is the load-bearing one — a fold can hold
 * hundreds of rows, and classifying every payload up front would undo the fold.
 */
describe("folded tool rows — drill-down payload", () => {
	type Row = {
		canDrillDown?: boolean;
		card?: { toolName?: string; detail?: unknown; summary?: string };
		/** A reasoning-step row's revealable markdown (the other reveal channel). */
		bodyText?: string;
	};
	const readTc = (id = "tu-1") => ({
		toolName: "Read",
		toolUseId: id,
		status: "success",
		inputJson: { file_path: "/a/b.ts" },
		outputJson: { _text: "line1\nline2\n" },
	});
	const msgWith = (blocks: unknown[], id = "m1") =>
		({ id, role: "assistant", contentJson: blocks }) as never;
	const activityRows = (spec: { data: unknown }): Row[] => (spec.data as { items: Row[] }).items;

	it("a collapsed row carries no card (the fold stays cheap)", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const spec = adaptActivityUnit(
			[{ kind: "tool", msg: msgWith([]), blockIndex: 0, tc: readTc() }],
			"act-1",
			{ lod: 2 },
		);
		expect(activityRows(spec)[0]?.canDrillDown).toBe(true);
		expect(activityRows(spec)[0]?.card).toBeUndefined();
	});

	/** `isRowExpanded` opening exactly `rowKeys` inside `traceKey`. */
	const openRows = (traceKey: string, ...rowKeys: string[]) => ({
		isRowExpanded: (key: string, rowKey: string) => key === traceKey && rowKeys.includes(rowKey),
	});

	it("an expanded row carries the classified card", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const spec = adaptActivityUnit(
			[{ kind: "tool", msg: msgWith([]), blockIndex: 0, tc: readTc() }],
			"act-1",
			{ lod: 2, ...openRows("act-1", "tool-tu-1") },
		);
		const card = activityRows(spec)[0]?.card;
		expect(card).toBeDefined();
		expect(card?.toolName).toBe("Read");
		expect(card?.detail).not.toBeNull();
	});

	it("only the requested row is built, and only for the OWNING trace key", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const items = [
			{ kind: "tool" as const, msg: msgWith([]), blockIndex: 0, tc: readTc("tu-1") },
			{ kind: "tool" as const, msg: msgWith([]), blockIndex: 1, tc: readTc("tu-2") },
		];
		const spec = adaptActivityUnit(items, "act-1", { lod: 2, ...openRows("act-1", "tool-tu-2") });
		expect(activityRows(spec).map((row) => row.card != null)).toEqual([false, true]);
		// Another trace's expansion must not leak into this one.
		const other = adaptActivityUnit(items, "act-1", { lod: 2, ...openRows("act-2", "tool-tu-2") });
		expect(activityRows(other).map((row) => row.card != null)).toEqual([false, false]);
	});

	/**
	 * The `expandedIndices` the trace reports must number the EMITTED ROW list, since
	 * the measure layer resolves a visible row back to `startIndex + vi` over that
	 * same array. A multi-step reasoning run is what pulls the two numberings apart:
	 * it contributes one row per step, so the tool below it is input item 1 but row 2.
	 */
	it("reports the expanded row's index over the EMITTED rows, not the input items", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const blocks = [{ type: "reasoning", text: "**A**\n\nfirst\n\n**B**\n\nsecond" }];
		const msg = msgWith(blocks);
		const items = [
			{ kind: "reasoning" as const, msg, blockIndex: 0, block: blocks[0] as never },
			{ kind: "tool" as const, msg, blockIndex: 1, tc: readTc() },
		];
		const spec = adaptActivityUnit(items, "act-1", { lod: 2, ...openRows("act-1", "tool-tu-1") });
		const rows = activityRows(spec);
		expect(rows).toHaveLength(3);
		expect(rows[2]?.card).toBeDefined();
		// Row 2, not input item 1 — the reasoning run emitted rows 0 and 1.
		expect((spec.opts as { expandedIndices?: number[] }).expandedIndices).toEqual([2]);
	});

	/**
	 * The regression this whole channel exists for (reported as a folded row that
	 * would not stay open, and rows overlapping while a turn streamed).
	 *
	 * A live reasoning run emits ONE ROW PER STEP, so the next `**title**` shifts
	 * every row below it down by one. While the reader's intent was stored as a row
	 * INDEX, that shift silently re-pointed it: the tool they opened folded shut and
	 * a neighbour opened in its place — a height change with no user action behind
	 * it, which CONTRACT §0 forbids. A row KEY is stable across exactly those frames.
	 */
	it("keeps the SAME tool open as a live reasoning run emits more rows", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const openedFor = (text: string) => {
			const blocks = [{ type: "reasoning", text }];
			const msg = msgWith(blocks);
			const spec = adaptActivityUnit(
				[
					{ kind: "reasoning" as const, msg, blockIndex: 0, block: blocks[0] as never },
					{ kind: "tool" as const, msg, blockIndex: 1, tc: readTc() },
				],
				"act-1",
				{ lod: 2, ...openRows("act-1", "tool-tu-1") },
			);
			return activityRows(spec)
				.map((row, index) => ({ row, index }))
				.filter(({ row }) => row.card != null);
		};

		const oneStep = openedFor("**A**\n\nfirst");
		const threeSteps = openedFor("**A**\n\nfirst\n\n**B**\n\nsecond\n\n**C**\n\nthird");
		// Still exactly one card, and still the tool's.
		expect(oneStep).toHaveLength(1);
		expect(threeSteps).toHaveLength(1);
		expect(threeSteps[0]?.row.card?.toolName).toBe("Read");
		// Its INDEX moved (the run grew above it) — which is precisely why the index
		// could not be the thing stored.
		expect(oneStep[0]?.index).toBe(1);
		expect(threeSteps[0]?.index).toBe(3);
	});

	it("a tool without a toolUseId cannot be drilled into", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const spec = adaptActivityUnit(
			[{ kind: "tool", msg: msgWith([]), blockIndex: 0, tc: { toolName: "Read" } }],
			"act-1",
			{ lod: 2, isRowExpanded: () => true },
		);
		expect(activityRows(spec)[0]?.canDrillDown).toBeUndefined();
		expect(activityRows(spec)[0]?.card).toBeUndefined();
	});

	/**
	 * An AGENT row drills into the SUBAGENT card, not the generic tool card.
	 *
	 * The bug this pins down: `isSubagent` was dropped when a tool-run folded into an
	 * activity unit (hard-coded `false` while rebuilding the item), so every folded
	 * Agent/Task/Send call built a `ToolCallData` payload — and the reader who opened
	 * it got a title plus a raw input JSON dump instead of the badge row / recent
	 * calls / prompt / result the very same call shows as a card at L3+.
	 *
	 * Silent by construction: a tool card renders any payload happily, so nothing
	 * threw and the only signal was the card looking wrong.
	 */
	const agentTc = (id = "tu-a") => ({
		toolName: "Agent",
		toolUseId: id,
		status: "success",
		inputJson: { subagent_type: "explore", description: "trace the vlist path", prompt: "look" },
		outputJson: { _text: "found it" },
		_subagentActivity: {
			subagentNarratorId: "child-1",
			model: "kimi-2:k3",
			latestToolCalls: [{ toolName: "Read", status: "success" }],
		},
	});

	it("an expanded SUBAGENT row carries a subagent card, tagged by cardKind", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const spec = adaptActivityUnit(
			[
				{
					kind: "tool",
					msg: msgWith([]),
					blockIndex: 0,
					tc: agentTc(),
					isSubagent: true,
				},
			],
			"act-1",
			{ lod: 2, ...openRows("act-1", "tool-tu-a") },
		);
		const row = activityRows(spec)[0] as (Row & { cardKind?: string }) | undefined;
		expect(row?.cardKind).toBe("subagent-card");
		const card = row?.card as
			| { agentType?: string; description?: string; prompt?: string; recentCallCount?: number }
			| undefined;
		// The SubagentCardData shape, from the same constructor the L3+ card uses.
		expect(card?.agentType).toBe("explore");
		expect(card?.description).toBe("trace the vlist path");
		expect(card?.recentCallCount).toBe(1);
		// And emphatically NOT the generic tool payload.
		expect((card as { detail?: unknown } | undefined)?.detail).toBeUndefined();
	});

	it("an ordinary tool row stays a tool card (no cardKind tag)", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const spec = adaptActivityUnit(
			[{ kind: "tool", msg: msgWith([]), blockIndex: 0, tc: readTc() }],
			"act-1",
			{ lod: 2, ...openRows("act-1", "tool-tu-1") },
		);
		const row = activityRows(spec)[0] as (Row & { cardKind?: string }) | undefined;
		// Absent rather than "tool-call": every pre-existing producer leaves it unset,
		// and the measure layer treats absent as the tool card.
		expect(row?.cardKind).toBeUndefined();
		expect(row?.card?.toolName).toBe("Read");
	});

	/**
	 * The prompt fold is keyed by the CARD (`tool-<toolUseId>`), the same channel the
	 * standalone card uses — so a prompt opened inside a drilled-in row is still open
	 * after an LOD change, and vice versa. Keying it by the TRACE would put the state
	 * where the card never looks.
	 */
	it("reads the drilled-in card's prompt fold from the CARD's key", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const build = (promptOpenKey: string) =>
			adaptActivityUnit(
				[{ kind: "tool", msg: msgWith([]), blockIndex: 0, tc: agentTc(), isSubagent: true }],
				"act-1",
				{
					lod: 2,
					...openRows("act-1", "tool-tu-a"),
					isPromptOpen: (key: string) => key === promptOpenKey,
				},
			);
		const opened = activityRows(build("tool-tu-a"))[0]?.card as { promptOpen?: boolean };
		expect(opened.promptOpen).toBe(true);
		// The trace's own key is NOT the channel.
		const closed = activityRows(build("act-1"))[0]?.card as { promptOpen?: boolean };
		expect(closed.promptOpen).toBeUndefined();
	});

	/**
	 * A provider retry puts the same tool-use id in two persisted messages, and the
	 * second row is suffixed (`tool-tu-1#1`) so the two cannot overlap. That suffixed
	 * key is what the renderer paints and therefore what a click reports, so the
	 * lookup has to ask with it — asking with the bare id would never match the
	 * reader's second attempt.
	 */
	it("addresses a retried call's suffixed row by its suffixed key", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const items = [
			{ kind: "tool" as const, msg: msgWith([], "m1"), blockIndex: 0, tc: readTc("tu-1") },
			{
				kind: "tool" as const,
				msg: msgWith([], "m2"),
				blockIndex: 0,
				tc: readTc("tu-1"),
				dedupeSuffix: 1,
			},
		];
		const second = adaptActivityUnit(items, "act-1", {
			lod: 2,
			...openRows("act-1", "tool-tu-1#1"),
		});
		expect(activityRows(second).map((row) => row.card != null)).toEqual([false, true]);
		// The bare key opens the FIRST attempt only, so the two stay independent.
		const first = adaptActivityUnit(items, "act-1", { lod: 2, ...openRows("act-1", "tool-tu-1") });
		expect(activityRows(first).map((row) => row.card != null)).toEqual([true, false]);
	});

	it("a folded reasoning row reveals its own step body, keyed by row", async () => {
		const { adaptActivityUnit } = await import("./segment-adapter");
		const msg = {
			id: "m-reason",
			role: "assistant" as const,
			contentJson: [
				{
					type: "reasoning",
					text: ["**Check the cache**", "The key folds lod in.", ""].join("\n"),
				},
			],
		};
		const items = [{ kind: "reasoning" as const, msg, blockIndex: 0, block: msg.contentJson[0] }];
		const collapsed = adaptActivityUnit(items, "act-1", { lod: 2 });
		const collapsedRows = activityRows(collapsed);
		expect(collapsedRows).toHaveLength(1);
		expect(collapsedRows[0]?.bodyText).toBe("The key folds lod in.");
		expect((collapsed.opts as { expandedIndices?: number[] }).expandedIndices).toEqual([]);

		// The reader's intent is stored against the ROW KEY, not its index — a live run
		// inserts steps above existing rows (see AdapterContext.isRowExpanded).
		const expanded = adaptActivityUnit(items, "act-1", {
			lod: 2,
			...openRows("act-1", "r-m-reason-0-step-0"),
		});
		expect((expanded.opts as { expandedIndices?: number[] }).expandedIndices).toEqual([0]);
	});

	it("a LIVE reasoning row carries no body, so it cannot be expanded", async () => {
		// Emitting whole bodies per delta would rebuild a string the size of the reply
		// every frame; the row gains its chevron the moment the turn persists.
		const { adaptActivityUnit } = await import("./segment-adapter");
		const msg = {
			id: "__streaming__",
			role: "assistant" as const,
			contentJson: [
				{ type: "reasoning", text: ["**Check the cache**", "The key folds lod in."].join("\n") },
			],
		};
		const live = adaptActivityUnit(
			[{ kind: "reasoning", msg, blockIndex: 0, block: msg.contentJson[0] }],
			"act-live",
			{ lod: 2, ...openRows("act-live", "r-__streaming__-0-step-0") },
		);
		const rows = activityRows(live);
		expect(rows[0]?.bodyText).toBeUndefined();
		expect((live.opts as { expandedIndices?: number[] }).expandedIndices).toEqual([]);
	});

	it("the drilled-in card matches the standalone card the same tool produces", async () => {
		const { adaptSegment, adaptActivityUnit } = await import("./segment-adapter");
		const tc = readTc();
		const standalone = adaptSegment(
			{
				kind: "tool-run",
				items: [{ blockIndex: 0, isSubagent: false, msg: msgWith([]), tc }],
				sourceMessages: [msgWith([])],
			},
			{ lod: 5 },
		)[0]!;
		const drilled = activityRows(
			adaptActivityUnit([{ kind: "tool", msg: msgWith([]), blockIndex: 0, tc }], "act-1", {
				lod: 2,
				...openRows("act-1", "tool-tu-1"),
			}),
		)[0]?.card;
		// One constructor, so the payloads are identical — which is what keeps the
		// drilled-in card from silently diverging from the high-LOD one.
		expect(drilled).toEqual(standalone.data as typeof drilled);
	});
});

describe("LOD matrix adapter semantics", () => {
	it("renders structured reasoning as the SAME expandable step trace at L3/L4/L5", () => {
		// There is no level whose step titles are visible but unopenable (the former
		// `titlesOnly`), so the element and its opts are level-independent here.
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "reasoning-1",
				role: "assistant",
				contentJson: [
					{ type: "reasoning", text: ["**Plan**", "<!-- -->", "**Check**", "body"].join("\n\n") },
				],
			},
		};
		for (const lod of [3, 4, 5] as const) {
			const spec = adaptSegment(seg, { lod })[0]!;
			expect(spec.kind).toBe("reasoning-steps");
			expect(spec.opts).not.toHaveProperty("titlesOnly");
			expect((spec.data as { steps: { body: string | null }[] }).steps).toHaveLength(2);
			// The step that has real content keeps its body, whatever the level.
			expect((spec.data as { steps: { body: string | null }[] }).steps[1]?.body).toBe("body");
		}
	});

	it("keeps L5 recent and old cards distinct", () => {
		const sourceMessages = [
			{ id: "old", role: "assistant", contentJson: [] },
			{ id: "recent", role: "assistant", contentJson: [] },
		];
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages,
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					msg: sourceMessages[0],
					tc: { toolName: "Read", status: "success" },
				},
				{
					blockIndex: 1,
					isSubagent: false,
					msg: sourceMessages[1],
					tc: { toolName: "Read", status: "success" },
				},
			],
		};
		const specs = adaptSegment(seg, { lod: 5, recentMessageIds: new Set(["recent"]) });
		expect(specs).toHaveLength(2);
		expect((specs[0]!.opts as { isRecent: boolean }).isRecent).toBe(false);
		expect((specs[1]!.opts as { isRecent: boolean }).isRecent).toBe(true);
	});

	it("preserves full-run geometry and sole-subagent default expansion", () => {
		const messages = [
			{ id: "tool-msg", role: "assistant", contentJson: [] },
			{ id: "agent-msg", role: "assistant", contentJson: [] },
		];
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: messages,
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					msg: messages[0],
					tc: { toolName: "Read", status: "success", toolUseId: "read-1" },
				},
				{
					blockIndex: 0,
					isSubagent: true,
					msg: messages[1],
					tc: { toolName: "Agent", status: "success", toolUseId: "agent-1" },
				},
			],
		};
		const specs = adaptSegment(seg, {
			lod: 5,
			recentMessageIds: new Set(["tool-msg", "agent-msg"]),
		});
		expect((specs[0]?.data as { inRun: boolean; isLast: boolean }).inRun).toBe(true);
		expect((specs[0]?.data as { isLast: boolean }).isLast).toBe(false);
		expect((specs[1]?.opts as { inRun: boolean; isLast: boolean; opened: boolean }).inRun).toBe(
			true,
		);
		expect((specs[1]?.opts as { isLast: boolean }).isLast).toBe(true);
		expect((specs[1]?.opts as { opened: boolean }).opened).toBe(true);
	});

	it("maps _streamingChars to a streaming active tool card", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: { toolName: "Edit", status: "success", inputJson: { _streamingChars: 12 } },
				},
			],
		};
		for (const lod of [2, 3] as const) {
			const specs = adaptSegment(seg, { lod });
			expect(specs[0]?.kind).toBe("tool-call");
			expect((specs[0]?.data as { isStreaming: boolean }).isStreaming).toBe(true);
		}
	});

	it("preserves active-tool exemption and completed batch order", () => {
		const seg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", status: "success" } },
				{ blockIndex: 1, isSubagent: false, tc: { toolName: "Bash", status: "running" } },
				{ blockIndex: 2, isSubagent: false, tc: { toolName: "Grep", status: "success" } },
			],
		};
		// The live card stays at its own position between the two completed batches
		// rather than being hoisted above the calls that preceded it.
		const specs = adaptSegment(seg, { lod: 2 });
		expect(specs.map((spec) => spec.kind)).toEqual([
			"tool-run-count",
			"tool-call",
			"tool-run-count",
		]);
	});
});

describe("adaptSegments + registry integration", () => {
	it("every produced kind exists in the registry", () => {
		const segments: AdapterSegment[] = [
			{ kind: "prune-divider" },
			{
				kind: "message",
				msg: { id: "u", role: "user", contentJson: [{ type: "text", text: "hi" }] },
			},
			{
				kind: "message",
				msg: {
					id: "a",
					role: "assistant",
					contentJson: [
						{ type: "text", text: "yo" },
						{ type: "reasoning", text: "r" },
					],
				},
			},
			{
				kind: "tool-run",
				sourceMessages: [],
				items: [{ blockIndex: 0, isSubagent: false, tc: { toolName: "Bash" } }],
			},
		];
		const specs = adaptSegments(segments, CTX);
		expect(specs.length).toBeGreaterThan(0);
		for (const spec of specs) {
			expect(VLIST_REGISTRY[spec.kind]).toBeDefined();
			expect(typeof spec.key).toBe("string");
			expect(spec.key.length).toBeGreaterThan(0);
		}
	});

	it("marks unitStart on the first spec of each unit, not intra-unit blocks", () => {
		const segments: AdapterSegment[] = [
			{
				kind: "message",
				msg: { id: "u", role: "user", contentJson: [{ type: "text", text: "hi" }] },
			},
			{
				// One assistant message that yields multiple content-block specs.
				kind: "message",
				msg: {
					id: "a",
					role: "assistant",
					contentJson: [
						{ type: "text", text: "yo" },
						{ type: "web_search", query: "cats", status: "completed" },
						{ type: "image" },
					],
				},
			},
		];
		const specs = adaptSegments(segments, CTX);
		// First unit (user bubble) → unitStart. Second unit's FIRST spec →
		// unitStart; its remaining content blocks stay tight (no unitStart), so the
		// wide segment gap is applied only between the two messages.
		expect(specs.map((s) => s.unitStart === true)).toEqual([true, true, false, false]);
	});
});

describe("adaptSegment — pending permission injection", () => {
	const seg: AdapterSegment = {
		kind: "tool-run",
		sourceMessages: [],
		items: [
			{ blockIndex: 0, isSubagent: false, tc: { toolName: "Bash", toolUseId: "tu-perm" } },
			{ blockIndex: 1, isSubagent: false, tc: { toolName: "Read", toolUseId: "tu-plain" } },
		],
	};

	it("flags only the tool whose toolUseId has a pending permission", () => {
		const ctx: AdapterContext = {
			lod: 5,
			resolveHasPendingPermission: (toolUseId) => toolUseId === "tu-perm",
		};
		const specs = adaptSegment(seg, ctx);
		const permSpec = specs.find((s) => s.key === "tool-tu-perm");
		const plainSpec = specs.find((s) => s.key === "tool-tu-plain");
		expect((permSpec?.opts as { hasPendingPermission?: boolean })?.hasPendingPermission).toBe(true);
		// The non-pending card carries no hasPendingPermission opt (absent, not false).
		expect("hasPendingPermission" in (plainSpec?.opts ?? {})).toBe(false);
	});

	it("keeps a pending card out of LOD collapse (collapsesByLod false)", () => {
		const ctx: AdapterContext = {
			lod: 4, // L4 would normally collapse completed cards to headers
			resolveHasPendingPermission: (toolUseId) => toolUseId === "tu-perm",
		};
		const specs = adaptSegment(seg, ctx);
		const permSpec = specs.find((s) => s.key === "tool-tu-perm");
		expect((permSpec?.opts as { collapsesByLod?: boolean })?.collapsesByLod).toBe(false);
	});

	it("injects nothing when no resolver is provided (parity with old behaviour)", () => {
		const specs = adaptSegment(seg, { lod: 5 });
		for (const spec of specs) {
			expect("hasPendingPermission" in (spec.opts ?? {})).toBe(false);
		}
	});
});

describe("adaptSegment — pending plan fallback", () => {
	const PLAN = "# Plan\n\nDo the thing.";

	/** One ExitPlanMode tool run whose streamed input carries `plan` or not. */
	function planSeg(inputJson: unknown): AdapterSegment {
		return {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: { toolName: "ExitPlanMode", toolUseId: "tu-plan", status: "pending", inputJson },
				},
			],
		};
	}

	function planDetail(seg: AdapterSegment, ctx: AdapterContext) {
		const spec = adaptSegment(seg, ctx).find((s) => s.key === "tool-tu-plan");
		return (spec?.data as { detail?: { text?: string } | null })?.detail ?? null;
	}

	/** The shell injects the authoritative category resolver; plans need it. */
	const PLAN_CTX: AdapterContext = { lod: 5, resolveToolCategory: () => "plan" };
	const withPendingPlan: AdapterContext = {
		...PLAN_CTX,
		resolvePendingPlan: (toolUseId) => (toolUseId === "tu-plan" ? PLAN : undefined),
	};

	it("uses the pending permission's plan when the tool call has none", () => {
		// A file-based plan never enters the streamed tool_use input, so without the
		// fallback the card would classify to a null (blank) detail.
		expect(planDetail(planSeg({ allowedPrompts: [] }), PLAN_CTX)).toBeNull();
		expect(planDetail(planSeg({ allowedPrompts: [] }), withPendingPlan)?.text).toBe(PLAN);
	});

	it("never overrides a plan the tool call already carries", () => {
		const own = "# Own plan\n\nbody";
		expect(planDetail(planSeg({ plan: own }), withPendingPlan)?.text).toBe(own);
	});

	it("ignores a blank pending plan", () => {
		const ctx: AdapterContext = { ...PLAN_CTX, resolvePendingPlan: () => "   " };
		expect(planDetail(planSeg({}), ctx)).toBeNull();
	});

	it("leaves a truncated input wrapper untouched", () => {
		const truncated = { _truncated: true, preview: "partial…", fullLength: 9000 };
		const detail = planDetail(planSeg(truncated), withPendingPlan);
		// The wrapper's own preview drives the detail; the plan is not spliced in.
		expect(detail?.text).not.toBe(PLAN);
	});

	it("classifies from the tool call alone when no resolver is provided", () => {
		expect(planDetail(planSeg({ plan: PLAN }), PLAN_CTX)?.text).toBe(PLAN);
	});

	// ── Regression: the model echoing back our own plan reference ──────────────
	//
	// File-based plans are stripped to a short path reference in MODEL history. A
	// model can copy that sentence back into `plan` on its next ExitPlanMode call,
	// which lands in the persisted input. It is present and non-blank, so the old
	// "only substitute when empty" rule kept it — and the card showed the user
	// "the plan is saved in <path>" in place of the plan.
	describe("a plan holding our model-facing reference", () => {
		const REFERENCE =
			"The plan was not approved. Its full content is saved in the plan file: " +
			".narrafork/plan-portable-jukebox-parrot--cnz6sszhQubPv9s0.md. " +
			"Re-read that file with the Read tool if you need the plan details.";

		it("yields to the pending permission's real plan body", () => {
			const detail = planDetail(planSeg({ plan: REFERENCE }), withPendingPlan);
			expect(detail?.text).toBe(PLAN);
			expect(detail?.text).not.toContain("Its full content is saved");
		});

		it("is never shown as the plan, even with no fallback available", () => {
			expect(planDetail(planSeg({ plan: REFERENCE }), PLAN_CTX)).toBeNull();
		});

		it("still yields when it arrives alongside the _planFile marker", () => {
			// The real shape: the stripped history carries both fields together.
			const seg = planSeg({
				plan: REFERENCE,
				_planFile: ".narrafork/plan-portable-jukebox-parrot--cnz6sszhQubPv9s0.md",
			});
			expect(planDetail(seg, withPendingPlan)?.text).toBe(PLAN);
		});
	});
});

describe("adaptSegment — header timing passthrough", () => {
	/** One completed bash card carrying timing metadata. */
	function bashSeg(tc: Record<string, unknown>): AdapterSegment {
		return {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: { toolName: "Bash", toolUseId: "tu-1", status: "success", ...tc },
				},
			],
		};
	}
	const BASH_CTX: AdapterContext = { lod: 5, resolveToolCategory: () => "bash" };

	function data(seg: AdapterSegment, ctx: AdapterContext = BASH_CTX) {
		const spec = adaptSegment(seg, ctx).find((s) => s.key === "tool-tu-1");
		return (spec?.data ?? {}) as Record<string, unknown>;
	}

	it("carries durationMs / toolUseId so the header can show the elapsed time", () => {
		const d = data(bashSeg({ durationMs: 1500 }));
		expect(d.durationMs).toBe(1500);
		expect(d.toolUseId).toBe("tu-1");
	});

	it("derives the duration from the start / complete stamps when absent", () => {
		const d = data(
			bashSeg({
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: "2026-01-01T00:00:02.000Z",
			}),
		);
		expect(d.durationMs).toBe(2000);
		expect(d.startedAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
	});

	it("carries the bash execution duration separately (preferred by the header)", () => {
		const d = data(
			bashSeg({ durationMs: 5000, outputJson: { _metadata: { execDurationMs: 1200 } } }),
		);
		expect(d.execDurationMs).toBe(1200);
	});

	it("carries the effective timeout for bash / await tools", () => {
		expect(data(bashSeg({ _timeoutMs: 30_000 })).timeoutMs).toBe(30_000);
		const awaitSeg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: { toolName: "Await", toolUseId: "tu-1", inputJson: { timeout: 600_000 } },
				},
			],
		};
		expect(data(awaitSeg, { lod: 5, resolveToolCategory: () => "await" }).timeoutMs).toBe(600_000);
	});

	it("carries the error message so a failed card can show it", () => {
		const d = data(bashSeg({ status: "fail", errorMessage: "exit 127" }));
		expect(d.errorMessage).toBe("exit 127");
	});

	it("falls back to the per-tool DEFAULT timeout when none is declared", () => {
		// Chunk parity (ToolCallCard.tsx:1831): a bash/await card shows its implicit
		// deadline even when neither `_timeoutMs` nor `input.timeout` was recorded.
		// Previously the vlist header showed nothing, which read as "runs forever".
		expect(data(bashSeg({})).timeoutMs).toBe(120_000);
		const awaitSeg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [{ blockIndex: 0, isSubagent: false, tc: { toolName: "Await", toolUseId: "tu-1" } }],
		};
		expect(data(awaitSeg, { lod: 5, resolveToolCategory: () => "await" }).timeoutMs).toBe(600_000);
	});

	it("gives a BACKGROUND bash no timeout (it has no wall-clock deadline)", () => {
		const d = data(bashSeg({ inputJson: { run_in_background: true } }));
		expect("timeoutMs" in d).toBe(false);
	});

	it("still shows an explicit timeout on a background bash", () => {
		const d = data(bashSeg({ _timeoutMs: 45_000, inputJson: { run_in_background: true } }));
		expect(d.timeoutMs).toBe(45_000);
	});

	it("leaves non-bash/await tools without any timeout", () => {
		const readSeg: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", toolUseId: "tu-1" } }],
		};
		expect("timeoutMs" in data(readSeg, { lod: 5, resolveToolCategory: () => "read" })).toBe(false);
	});

	it("omits every duration / start field when the tool call has none", () => {
		const d = data(bashSeg({}));
		expect("durationMs" in d).toBe(false);
		expect("startedAt" in d).toBe(false);
		expect("completedAt" in d).toBe(false);
		expect("executionStartedAt" in d).toBe(false);
	});

	it("carries every lifecycle stamp so the header can show a breakdown", () => {
		// Without these the vlist header had a duration but no way to say WHERE the
		// time went (streaming vs permission wait vs execution) — the gap this closes.
		const d = data(
			bashSeg({
				createdAt: "2026-01-01T00:00:00.000Z",
				streamStartedAt: "2026-01-01T00:00:01.000Z",
				permissionStartedAt: "2026-01-01T00:00:02.000Z",
				executionStartedAt: 1_767_225_603_000,
				completedAt: "2026-01-01T00:00:05.000Z",
			}),
		);
		expect(d.createdAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
		expect(d.streamStartedAt).toBe(Date.parse("2026-01-01T00:00:01.000Z"));
		expect(d.permissionStartedAt).toBe(Date.parse("2026-01-01T00:00:02.000Z"));
		// Epoch numbers pass through untouched alongside the ISO strings.
		expect(d.executionStartedAt).toBe(1_767_225_603_000);
		expect(d.completedAt).toBe(Date.parse("2026-01-01T00:00:05.000Z"));
	});

	it("keeps startedAt's precedence (explicit → execution → created)", () => {
		// The live elapsed timer reads `startedAt`; the new stamp passthrough must not
		// change which stamp wins.
		expect(data(bashSeg({ createdAt: 5_000 })).startedAt).toBe(5_000);
		expect(data(bashSeg({ createdAt: 5_000, executionStartedAt: 7_000 })).startedAt).toBe(7_000);
		expect(
			data(bashSeg({ createdAt: 5_000, executionStartedAt: 7_000, startedAt: 6_000 })).startedAt,
		).toBe(6_000);
	});
});

describe("adaptSegment — subagent card timing passthrough", () => {
	function subagentSeg(tc: Record<string, unknown>): AdapterSegment {
		return {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: true,
					tc: { toolName: "Agent", toolUseId: "tu-a", status: "running", ...tc },
				},
			],
		};
	}

	function data(seg: AdapterSegment, ctx: AdapterContext = { lod: 5 }) {
		const spec = adaptSegment(seg, ctx).find((s) => s.key === "tool-tu-a");
		return (spec?.data ?? {}) as Record<string, unknown>;
	}

	it("carries the card's own stamps and resolved duration", () => {
		const d = data(
			subagentSeg({
				createdAt: 1_000,
				executionStartedAt: 2_000,
				completedAt: 5_000,
			}),
		);
		expect(d.timing).toEqual({
			createdAt: 1_000,
			executionStartedAt: 2_000,
			completedAt: 5_000,
			// Derived from executionStartedAt → completedAt, like the tool header.
			durationMs: 3_000,
		});
	});

	it("pairs recentCallTimings with recentCallNames index-for-index", () => {
		const d = data(
			subagentSeg({
				_subagentActivity: {
					latestToolCalls: [
						{ toolName: "Read", status: "success", createdAt: 10, timing: { durationMs: 40 } },
						// A nameless entry is dropped from BOTH arrays, so the pairing holds.
						{ status: "success", timing: { durationMs: 99 } },
						{ toolName: "Grep", status: "running", timing: { streamStartedAt: 20 } },
					],
				},
			}),
		);
		expect(d.recentCallNames).toEqual(["Read", "Grep"]);
		expect(d.recentCallTimings).toEqual([
			{ status: "success", createdAt: 10, durationMs: 40 },
			{ status: "running", streamStartedAt: 20 },
		]);
	});

	it("keeps the rows empty when the activity summary carries no calls", () => {
		const d = data(subagentSeg({}));
		expect(d.recentCallNames).toEqual([]);
		expect(d.recentCallTimings).toEqual([]);
	});

	/**
	 * The rows are TRACE rows now, so they need what a trace row shows: a
	 * `Tool · summary` label and a category chip. Before this the vlist copy printed
	 * the bare tool name, so the same child call read differently here than in the
	 * chunked card.
	 *
	 * The summary cannot be derived inside the pure adapter (it needs `getSummary`,
	 * and these rows carry only the server's whitelisted `inputSummary` projection),
	 * so it arrives through an injected resolver — the same injection pattern
	 * `resolveToolSummary` already uses.
	 */
	it("derives per-row summaries + categories, paired with the names", () => {
		const d = data(
			subagentSeg({
				_subagentActivity: {
					latestToolCalls: [
						{ toolName: "Read", status: "success", inputSummary: { file_path: "/a/loop.ts" } },
						{ toolName: "Bash", status: "success", inputSummary: { description: "run tests" } },
					],
				},
			}),
			{
				lod: 5,
				resolveToolCategory: (toolName: string) => (toolName === "Read" ? "read" : "bash"),
				resolveSubagentRecentSummary: (toolName: string, inputSummary: unknown) => {
					const summary = (inputSummary ?? {}) as { file_path?: string; description?: string };
					if (toolName === "Read") return summary.file_path?.split("/").pop() ?? null;
					return summary.description ?? null;
				},
			},
		);
		expect(d.recentCallNames).toEqual(["Read", "Bash"]);
		expect(d.recentCallSummaries).toEqual(["loop.ts", "run tests"]);
		expect(d.recentCallCategories).toEqual(["read", "bash"]);
	});

	it("falls back to nulls when no resolver is injected (never a phantom label)", () => {
		// Without the shell's resolver a row must degrade to its bare tool name rather
		// than inventing one from raw input fields, which is what would let the two
		// render paths word the same call differently again.
		const d = data(
			subagentSeg({
				_subagentActivity: {
					latestToolCalls: [
						{ toolName: "Read", status: "success", inputSummary: { file_path: "/a/loop.ts" } },
					],
				},
			}),
			{ lod: 5 },
		);
		expect(d.recentCallSummaries).toEqual([null]);
		expect(d.recentCallCategories).toEqual([null]);
	});
});

describe("adaptSegment — full tool payload injection (truncation fetch)", () => {
	const TRUNCATED = { _truncated: true, preview: "first chunk…", fullLength: 40_000 };
	const FULL_OUTPUT = "the complete file body";

	function readSeg(outputJson: unknown): AdapterSegment {
		return {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: { toolName: "Read", toolUseId: "tu-r", status: "success", outputJson },
				},
			],
		};
	}
	const READ_CTX: AdapterContext = { lod: 5, resolveToolCategory: () => "read" };

	function spec(seg: AdapterSegment, ctx: AdapterContext) {
		return adaptSegment(seg, ctx).find((s) => s.key === "tool-tu-r");
	}

	/** Body text of the (possibly sectioned) detail. */
	function bodyText(detail: unknown): string | undefined {
		const d = detail as {
			kind?: string;
			text?: string;
			sections?: Array<{ body?: { text?: string } }>;
		};
		if (d?.kind === "sections") {
			for (const part of d.sections ?? []) {
				if (typeof part.body?.text === "string") return part.body.text;
			}
			return undefined;
		}
		return d?.text;
	}

	it("counts the still-truncated fields so the shell can offer to fetch them", () => {
		const data = spec(readSeg(TRUNCATED), READ_CTX)?.data as {
			truncatedLeafCount?: number;
			truncatedTotalBytes?: number;
		};
		// A COUNT, not a boolean: field-level truncation can cut several fields of one
		// call, and the notice reports how many and how large.
		expect(data.truncatedLeafCount).toBe(1);
		expect(data.truncatedTotalBytes).toBeGreaterThan(0);
	});

	it("swaps in the fetched full output and clears the truncation count", () => {
		const ctx: AdapterContext = {
			...READ_CTX,
			resolveFullToolOutput: (toolUseId) => (toolUseId === "tu-r" ? FULL_OUTPUT : undefined),
		};
		const data = spec(readSeg(TRUNCATED), ctx)?.data as {
			truncatedLeafCount?: number;
			detail?: unknown;
		};
		expect(bodyText(data.detail)).toBe(FULL_OUTPUT);
		// Counted AFTER substitution, which is what makes the notice disappear and the
		// card shrink once the user has loaded the full content.
		expect("truncatedLeafCount" in data).toBe(false);
	});

	it("keeps the preview until the fetch resolves", () => {
		const ctx: AdapterContext = { ...READ_CTX, resolveFullToolOutput: () => undefined };
		const data = spec(readSeg(TRUNCATED), ctx)?.data as {
			truncatedLeafCount?: number;
			detail?: unknown;
		};
		expect(bodyText(data.detail)).toBe("first chunk…");
		expect(data.truncatedLeafCount).toBe(1);
	});

	it("substitutes the full payload for an OBJECT output whose root is a plain object", () => {
		// The regression this guards: a root-level `isTruncated` probe returns false for
		// `{_text, _metadata}`, so the fetched payload was never substituted and "load
		// full content" silently did nothing. The wrapper shape is unchanged, so no type
		// error would have caught it.
		const objectOutput = { _text: { _truncated: true, preview: "first chunk…", fullLength: 9000 } };
		const ctx: AdapterContext = {
			...READ_CTX,
			resolveFullToolOutput: (toolUseId) => (toolUseId === "tu-r" ? FULL_OUTPUT : undefined),
		};
		const data = spec(readSeg(objectOutput as never), ctx)?.data as {
			truncatedLeafCount?: number;
			detail?: unknown;
		};
		expect(bodyText(data.detail)).toBe(FULL_OUTPUT);
		expect("truncatedLeafCount" in data).toBe(false);
	});

	it("never counts or rewrites an untruncated payload", () => {
		const ctx: AdapterContext = { ...READ_CTX, resolveFullToolOutput: () => "should be ignored" };
		const data = spec(readSeg("small body"), ctx)?.data as {
			truncatedLeafCount?: number;
			detail?: unknown;
		};
		expect(bodyText(data.detail)).toBe("small body");
		expect("truncatedLeafCount" in data).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Header summary: the injected resolver is AUTHORITATIVE.
//
// Regression: an Edit/Read whose input was truncated server-side into
// `{_truncated:true, preview, _hints}` rendered a header with no target path,
// because the adapter's local fallback only reads plain `inputJson` fields. The
// chunked card never had the bug — it calls tool-display's getSummary, which
// decodes `_hints` / scans the preview. The fix is the injection point.
// ─────────────────────────────────────────────────────────────────────────────
describe("adaptSegment — tool-call header summary", () => {
	const PATH = "/home/u/proj/server/lib/agent/loop.ts";
	/** The shape the server emits for a large Edit input. */
	const TRUNCATED_EDIT_INPUT = {
		_truncated: true,
		preview: `{"file_path":"${PATH}","old_string":"a long body that got cut`,
		fullLength: 40_000,
		_hints: { file_path: PATH },
	};

	function editSeg(inputJson: unknown): AdapterSegment {
		return {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: { toolName: "Edit", toolUseId: "tu-e", status: "success", inputJson },
				},
			],
		};
	}

	function summaryOf(seg: AdapterSegment, ctx: AdapterContext): string | undefined {
		const spec = adaptSegment(seg, ctx).find((s) => s.key === "tool-tu-e");
		return (spec?.data as { summary?: string } | undefined)?.summary;
	}

	const FILE_CTX: AdapterContext = { lod: 5, resolveToolCategory: () => "file" };

	it("uses the injected resolver, so a truncated input still shows its target", () => {
		// Faithful stand-in for tool-display.getSummary's `_hints` lookup.
		const ctx: AdapterContext = {
			...FILE_CTX,
			resolveToolSummary: (tc) => {
				const input = tc.inputJson as { _hints?: { file_path?: string } } | undefined;
				const fp = input?._hints?.file_path ?? "";
				return fp ? (fp.split("/").pop() ?? fp) : "";
			},
		};
		expect(summaryOf(editSeg(TRUNCATED_EDIT_INPUT), ctx)).toBe("loop.ts");
	});

	it("without a resolver, a truncated input yields no summary (the old bug)", () => {
		expect(summaryOf(editSeg(TRUNCATED_EDIT_INPUT), FILE_CTX)).toBe("");
	});

	it("the resolver also wins for an untruncated input (parity with the chunked card)", () => {
		const ctx: AdapterContext = { ...FILE_CTX, resolveToolSummary: () => "loop.ts" };
		// The local fallback would return the FULL path; the chunked header shows the
		// basename, so the injected value must take precedence.
		expect(summaryOf(editSeg({ file_path: PATH }), ctx)).toBe("loop.ts");
		expect(summaryOf(editSeg({ file_path: PATH }), FILE_CTX)).toBe(PATH);
	});

	it("an empty resolver result is respected rather than falling back", () => {
		const ctx: AdapterContext = { ...FILE_CTX, resolveToolSummary: () => "" };
		expect(summaryOf(editSeg({ file_path: PATH }), ctx)).toBe("");
	});
});

describe("adaptSegment — per-turn usage rows", () => {
	const USAGE = { input_tokens: 100, output_tokens: 20 };
	const assistantSeg = (extra: Record<string, unknown> = {}): AdapterSegment => ({
		kind: "message",
		msg: {
			id: "a1",
			role: "assistant",
			contentJson: [{ type: "text", text: "hello" }],
			turnUsageJson: USAGE,
			...extra,
		},
	});
	const usageCtx: AdapterContext = { lod: 5, showTokenUsage: true };

	it("emits NO usage spec when the preference is off (identical item list)", () => {
		const specs = adaptSegment(assistantSeg(), CTX);
		expect(specs.map((s) => s.kind)).toEqual(["markdown"]);
	});

	it("brackets the body with a leading and a trailing usage row", () => {
		const specs = adaptSegment(assistantSeg(), usageCtx);
		expect(specs.map((s) => s.kind)).toEqual(["turn-usage", "markdown", "turn-usage"]);
		expect((specs[0]!.data as { placement: string }).placement).toBe("leading");
		expect((specs[2]!.data as { placement: string }).placement).toBe("trailing");
	});

	it("keeps the usage spec keys distinct from every block key", () => {
		const specs = adaptSegment(assistantSeg(), usageCtx);
		const keys = specs.map((s) => s.key);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys[0]).toBe("a1-usage-leading");
		expect(keys[2]).toBe("a1-usage-trailing");
	});

	it("never adds usage rows to a user message", () => {
		const specs = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "u1",
					role: "user",
					contentJson: [{ type: "text", text: "hi" }],
					turnUsageJson: USAGE,
				},
			},
			usageCtx,
		);
		expect(specs.map((s) => s.kind)).toEqual(["message-bubble"]);
	});

	it("never adds usage rows to the live streaming placeholder", () => {
		const specs = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "__streaming__",
					role: "assistant",
					contentJson: [{ type: "text", text: "partial" }],
					turnUsageJson: USAGE,
				},
			},
			usageCtx,
		);
		expect(specs.map((s) => s.kind)).toEqual(["markdown"]);
	});

	it("emits nothing when an assistant message carries no usage at all", () => {
		const specs = adaptSegment(
			{
				kind: "message",
				msg: { id: "a2", role: "assistant", contentJson: [{ type: "text", text: "x" }] },
			},
			usageCtx,
		);
		expect(specs.map((s) => s.kind)).toEqual(["markdown"]);
	});

	it("splits the trailing summary onto a second line on a compact viewport", () => {
		const specs = adaptSegment(
			assistantSeg({ turnUsageJson: { ...USAGE, cached_input_tokens: 8 }, costUsd: 0.5 }),
			{ ...usageCtx, compactUsageLines: true },
		);
		const trailing = specs.at(-1)!.data as { text: string; secondaryText?: string };
		expect(trailing.text).toBe("Σ 108 ctx · 100 in · 20 out");
		expect(trailing.secondaryText).toBe("8 cache hit · $0.5000");
	});

	it("omits secondaryText on a desktop viewport", () => {
		const specs = adaptSegment(assistantSeg({ costUsd: 0.5 }), usageCtx);
		const trailing = specs.at(-1)!.data as { text: string; secondaryText?: string };
		expect(trailing.text).toBe("Σ 100 ctx · 100 in · 20 out · $0.5000");
		expect(trailing.secondaryText).toBeUndefined();
	});

	it("applies the injected number formatter", () => {
		const specs = adaptSegment(
			assistantSeg({ turnUsageJson: { input_tokens: 1000, output_tokens: 2 } }),
			{ ...usageCtx, formatUsageNumber: (n) => n.toLocaleString("en-US") },
		);
		expect((specs[0]!.data as { text: string }).text).toBe("↑ 1,000");
	});

	it("measures through the registry at a stable, content-independent height", () => {
		const specs = adaptSegment(assistantSeg(), usageCtx);
		const entry = VLIST_REGISTRY["turn-usage"];
		const short = entry.measure(specs.at(-1)!.data, 600, 5);
		const long = entry.measure(
			{
				placement: "trailing",
				text: "Σ 999,999,999 ctx · 888,888 in · 777,777 out · $99.9999",
			},
			600,
			5,
		);
		expect(short.height).toBe(long.height);
		expect(short.height).toBeGreaterThan(0);
	});
});

/**
 * Reasoning's cross-LOD identity — the L2/L3 boundary's missing half.
 *
 * A tool call has always carried `tool-<toolUseId>` at both levels, so tool cards
 * morphed while reasoning teleported. The reason was structural rather than an
 * oversight: a folded row keys on `stableKeyBase` (the run's ordinal WITHIN ITS ACTIVITY
 * UNIT), and L3+ has no activity unit, so that ordinal is not merely different there —
 * it is uncomputable. Measured on a 16-message document, this left 8 of 40 identities
 * unpaired at L2→L3 and reasoning rows at 0/16.
 *
 * The fix is a third identity both sides CAN derive independently: message id + the
 * run's first block index + the step's ordinal.
 */
describe("reasoning steps: one identity across the L2/L3 boundary", () => {
	/** A persisted assistant turn whose single reasoning block holds two titled steps. */
	const twoStepMessage = (id = "real-msg", blocks?: unknown[]) =>
		({
			id,
			role: "assistant",
			contentJson: blocks ?? [
				{ type: "reasoning", text: "**第一步**\n\n分析正文。\n\n**第二步**\n\n继续分析。" },
			],
			toolCalls: [],
			children: [],
		}) as never;

	/** Step identities as they reach the DOM (`data-nf-unit`) at one level. */
	const stepUnitIdsAt = async (lod: number, message = twoStepMessage()) => {
		const { segmentMessages } = await import("../message-segments");
		const { groupRenderUnits } = await import("../render-units");
		const { adaptRenderUnits } = await import("./segment-adapter");
		// `enabled` mirrors the shell: the activity fold exists only at L1/L2.
		const units = groupRenderUnits(segmentMessages([message] as never), lod <= 2);
		const specs = adaptRenderUnits(units as never, { lod: lod as never });
		const out: string[] = [];
		for (const spec of specs) {
			const data = spec.data as {
				items?: { unitId?: string }[];
				steps?: { unitId?: string }[];
			};
			for (const row of data.items ?? data.steps ?? []) {
				if (row.unitId) out.push(row.unitId);
			}
		}
		return out;
	};

	it("gives a folded row and its L3+ step row the SAME unitId", async () => {
		const folded = await stepUnitIdsAt(2);
		const expanded = await stepUnitIdsAt(3);
		// Derived from facts both levels hold: message, run start block, step ordinal.
		expect(folded).toEqual(["reason-real-msg-b0-s0", "reason-real-msg-b0-s1"]);
		expect(expanded).toEqual(folded);
	});

	/**
	 * A streaming message's id is the synthetic `__streaming__` and becomes a real one at
	 * the hand-off, so an id-derived identity would pair a live row against nothing and
	 * then change under it. Both sides must therefore withhold it — and withholding on
	 * only ONE side is the dangerous shape, since the rows would silently stop pairing.
	 */
	it("withholds the cross-level identity while the turn is streaming", async () => {
		const streaming = twoStepMessage("__streaming__");
		const folded = await stepUnitIdsAt(2, streaming);
		const expanded = await stepUnitIdsAt(3, streaming);
		// L1/L2 still needs a per-row value (it is painted), just not a pairable one.
		expect(folded.every((id) => !id.startsWith("reason-__streaming__-b"))).toBe(true);
		// L3+ emits none at all rather than one that cannot be honoured.
		expect(expanded).toEqual([]);
	});

	/**
	 * The two levels GROUP reasoning differently: the activity fold pushes blocks one by
	 * one and parses each alone, while L3+ joins a run's adjacent blocks and parses the
	 * concatenation. So for a multi-block run `s2` on one side need not be the same step
	 * as `s2` on the other, and pairing them would morph one step into an unrelated one —
	 * worse than not morphing, because it looks intentional.
	 */
	it("withholds it for a multi-block run, where the two parses can disagree", async () => {
		const multiBlock = twoStepMessage("real-msg", [
			{ type: "reasoning", text: "**第一步**\n\n分析正文。" },
			{ type: "reasoning", text: "**第二步**\n\n继续分析。" },
		]);
		const expanded = await stepUnitIdsAt(3, multiBlock);
		expect(expanded).toEqual([]);
		const folded = await stepUnitIdsAt(2, multiBlock);
		expect(folded.every((id) => !/^reason-real-msg-b\d+-s\d+$/.test(id))).toBe(true);
	});

	it("keeps the identity height-neutral at both levels", async () => {
		const { measureActivityTrace, measureReasoningStepsTrace } = await import(
			"./measure/measure-tool-run"
		);
		const steps = [
			{ title: "第一步", body: "分析正文。", key: "seg0" },
			{ title: "第二步", body: "继续分析。", key: "seg1" },
		];
		const withIds = measureReasoningStepsTrace(
			steps.map((s, i) => ({ ...s, unitId: `reason-real-msg-b0-s${i}` })),
			600,
		);
		const without = measureReasoningStepsTrace(steps, 600);
		expect(withIds.height).toBe(without.height);
		expect(withIds.rows.map((r) => r.unitId)).toEqual([
			"reason-real-msg-b0-s0",
			"reason-real-msg-b0-s1",
		]);
		// And the value survives the measure layer, or it never reaches `data-nf-unit`.
		expect(without.rows[0]?.unitId).toBeUndefined();
		const activityRows = [{ title: "第一步", bodyText: "分析正文。", key: "r-run0-0-step-0" }];
		const activityWith = measureActivityTrace(
			activityRows.map((r) => ({ ...r, unitId: "reason-real-msg-b0-s0" })),
			600,
		);
		expect(activityWith.height).toBe(measureActivityTrace(activityRows, 600).height);
	});

	/**
	 * The measure cache keys on painted content, and `unitId` is painted but
	 * height-neutral — so it can move while `key` and every height-bearing field stay
	 * put. That happens on the streaming hand-off: the run gains a pairable identity the
	 * instant its turn persists. Without it in the revision, a cached entry serves rows
	 * with no `data-nf-unit` and the morph silently stops working.
	 */
	it("keys the measure cache on the identity", async () => {
		const { buildCacheKey, extractDataRevision } = await import("./measure-cache");
		const base = {
			steps: [{ title: "第一步", body: "分析正文。", key: "seg0" }],
			headerLabel: "推理",
			headerCount: "1 步",
		};
		const withId = {
			...base,
			steps: [{ ...base.steps[0], unitId: "reason-real-msg-b0-s0" }],
		};
		// The revision is what distinguishes two payloads under one spec.key…
		expect(extractDataRevision(withId)).not.toBe(extractDataRevision(base));
		// …and it must reach the key the cache is actually addressed by.
		const keyOf = (data: unknown) =>
			buildCacheKey("m1-b0", "reasoning-steps", 600, 3, undefined, extractDataRevision(data));
		expect(keyOf(withId)).not.toBe(keyOf(base));
	});
});

/**
 * A concluded review reaches its own element.
 *
 * The card went through three shapes before this one, and each failed on the same
 * property — a review conclusion is a MARKDOWN DOCUMENT with an action:
 *
 *   1. `system-simple`: one clamped line, so the findings could not fit (and since the
 *      producer wrote no display text, nothing was shown at all).
 *   2. `system-text` nested in an `injection-bubble`: a card inside a bubble, a badge lane
 *      reserved at a guessed width the real badges did not fill, a body painted line by
 *      line as PLAIN text (no markdown, no highlighting), and no scroll box.
 *   3. `review-card` — its own element: a constant header row over a maxHeight-capped
 *      scroll box holding a real markdown body.
 *
 * So these cases pin the routing and the payload, not a nesting arrangement.
 */
describe("adaptSegment — a concluded review", () => {
	const CTX: AdapterContext = { lod: 5 };

	/** The row production writes: role=user (a request) with origin=system (a reviewer). */
	const conclusionRow = (
		blocks: Array<{ type: string; [key: string]: unknown }>,
		ctx: AdapterContext = CTX,
	) =>
		adaptSegment(
			{
				kind: "message",
				msg: {
					id: "rf",
					role: "user",
					origin: "system",
					originLabel: "review",
					contentJson: blocks,
				},
			},
			ctx,
		);

	const cardData = (
		block: Record<string, unknown>,
		ctx: AdapterContext = CTX,
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
	): any => {
		const specs = conclusionRow(
			[
				{ type: "text", text: "model-facing copy" },
				{ type: "review_feedback", ...block },
			],
			ctx,
		);
		return specs[0]?.data;
	};

	it("routes to `review-card`, not to the origin notice that would claim a system row", () => {
		const specs = conclusionRow([
			{ type: "text", text: "## Code Review: Approved\n" },
			{ type: "review_feedback", verdict: "approve", findings: [], text: "Approved" },
		]);
		expect(specs).toHaveLength(1);
		expect(specs[0]?.kind).toBe("review-card");
	});

	it("is not framed in a speaker bubble — no card-in-a-card", () => {
		const specs = conclusionRow([
			{ type: "review_feedback", verdict: "approve", findings: [], text: "Approved" },
		]);
		expect(specs[0]?.kind).not.toBe("injection-bubble");
		expect(specs[0]?.kind).not.toBe("system-text");
	});

	it("does not hijack an injection row that merely carries a review block", () => {
		// `deliverInjection`'s `extraBlocks` can append one to a row whose leading
		// `system_injection` block owns it.
		const specs = conclusionRow([
			{ type: "text", text: "review concluded" },
			{ type: "system_injection", source: "review" },
			{ type: "review_feedback", verdict: "approve", findings: [] },
		]);
		expect(specs[0]?.kind).not.toBe("review-card");
	});

	it("carries the producer's markdown as the body, with verdict + action chrome", () => {
		const data = cardData({
			verdict: "request_changes",
			findings: [{ severity: "critical", message: "the index has no migration" }],
			text: "## Code Review: Changes Requested\n\n- the index has no migration\n",
		});
		// The body stays MARKDOWN: the card measures it with the markdown pipeline, so the
		// heading and the list survive instead of being flattened.
		expect(data.text).toContain("## Code Review");
		expect(data.text).toContain("- the index has no migration");
		expect(data.verdictLabel).toBe("Changes Requested");
		expect(data.color).toBe("orange");
		// Always present, so the reserved action row is never empty.
		expect(data.actionLabel).toBe("Handle");
		expect(data.applied).toBe(false);
	});

	it("composes a body from verdict + findings for rows written without text", () => {
		// The rows already in the database carry only `verdict` and `findings`. Without this
		// synthesis every historical review keeps rendering as a bare label — the reported
		// "shows nothing" bug, surviving on old data.
		const data = cardData({
			verdict: "request_changes",
			findings: [
				{ severity: "critical", file: "server/db/schema.ts", line: 2606, message: "no migration" },
				{ severity: "minor", message: "cached statement outlives the module" },
			],
		});
		expect(data.text).toContain("Changes Requested");
		expect(data.text).toContain("server/db/schema.ts:2606");
		expect(data.text).toContain("no migration");
		expect(data.text).toContain("cached statement outlives the module");
		// And it is MARKDOWN, because the card renders its body through the markdown
		// pipeline: bare `\n`-joined lines fold into one paragraph, which is how a
		// historical conclusion came out as a single run-on blob.
		expect(data.text).toContain("## ");
		expect(data.text).toContain("\n\n");
		expect(data.text).toContain("- **[critical]**");
		// The file path is inline code, so it stands out from the prose around it.
		expect(data.text).toContain("`server/db/schema.ts:2606`");
	});

	it("a composed body keeps one list item per finding", () => {
		const data = cardData({
			verdict: "request_changes",
			findings: [
				{ severity: "major", message: "first" },
				{ severity: "minor", message: "second" },
				{ severity: "suggestion", message: "third" },
			],
		});
		const items = (data.text as string).split("\n").filter((l: string) => l.startsWith("- "));
		expect(items).toHaveLength(3);
	});

	it("an approved review with no findings still says something", () => {
		const data = cardData({ verdict: "approve", findings: [] });
		expect(data.text).toBe("Approved");
		expect(data.color).toBe("green");
	});

	it("marks a revision and flips the action once a turn has been started", () => {
		const data = cardData({
			verdict: "approve",
			findings: [],
			text: "## Code Review (revised): Approved\n",
			revised: true,
			applied: true,
		});
		expect(data.revisedLabel).toBe("Revised");
		expect(data.applied).toBe(true);
		expect(data.actionLabel).toBe("Handled");
	});

	it("uses the injected localized labels", () => {
		const data = cardData(
			{ verdict: "approve", findings: [] },
			{ lod: 5, labels: { reviewVerdict_approve: "已通过", reviewFeedbackApply: "处理" } },
		);
		expect(data.text).toBe("已通过");
		expect(data.verdictLabel).toBe("已通过");
		expect(data.actionLabel).toBe("处理");
	});

	it("measures through the registry: the markdown body drives the height", () => {
		const short = cardData({ verdict: "approve", findings: [], text: "Approved" });
		const long = cardData({
			verdict: "request_changes",
			findings: [],
			text: Array.from({ length: 12 }, (_, i) => `- finding number ${i} with real prose`).join(
				"\n",
			),
		});
		const measure = (d: unknown) =>
			VLIST_REGISTRY["review-card"].measure(d as never, 800, 5).height;
		expect(measure(short)).toBeGreaterThan(0);
		expect(measure(long)).toBeGreaterThan(measure(short));
	});

	it("a very long conclusion is capped, because the body scrolls", () => {
		// The property no earlier shape had: an unbounded conclusion must not grow the row
		// without limit — the box is `overflow: auto` and the reader scrolls it.
		const huge = cardData({
			verdict: "request_changes",
			findings: [],
			text: Array.from({ length: 400 }, (_, i) => `- finding ${i}`).join("\n"),
		});
		const height = VLIST_REGISTRY["review-card"].measure(huge as never, 800, 5).height;
		expect(height).toBeLessThan(600);
	});
});
