/**
 * The transcript line of a host `context_update` row (outline P2 PR 4, review S5): an update of an
 * outline session's views reads "Context updated: Current tasks / Behavior boundary" in the
 * reader's language, through both the stored-row path and the protocol-v2 path a live client
 * gets. Every other update keeps its stored text; the row itself is never changed.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { type AdapterContext, type AdapterSegment, adaptSegment } from "./segment-adapter";

beforeAll(() => {
	installCanvasStub();
});

const BASE: AdapterContext = { lod: 5 };

/** The labels `useVListLabels` resolves, for one locale's JSON. */
function labelsOf(locale: {
	sidecar: { contextViews: { updated: string; outlineTasks: string; outlineBehavior: string } };
}): AdapterContext {
	const views = locale.sidecar.contextViews;
	return {
		lod: 5,
		labels: {
			contextViewsUpdated: views.updated.replace("{{parts}}", "{parts}"),
			contextViewOutlineTasks: views.outlineTasks,
			contextViewOutlineBehavior: views.outlineBehavior,
		},
	};
}

function row(notice: string): AdapterSegment {
	return {
		kind: "message",
		msg: rowWithElements({ id: "m1", role: "sys", createdAt: "2026-11-02T10:00:00.000Z" }, [
			{ type: "text", text: notice },
			{ type: "context_update", epochId: "e1", changes: [], snapshotRef: "ref" },
		] as never),
	};
}

function line(segment: AdapterSegment, ctx: AdapterContext): string {
	const specs = adaptSegment(segment, ctx);
	expect(specs).toHaveLength(1);
	expect(specs[0]?.kind).toBe("system-text");
	return (specs[0]?.data as { text: string }).text;
}

describe("context_update rows in the transcript", () => {
	it("an outline view update reads in the reader's words", () => {
		const notice = "Context updated: outline.behavior, outline.tasks";
		expect(line(row(notice), BASE)).toBe("Context updated: Behavior boundary / Current tasks");
		expect(line(row(notice), labelsOf(en))).toBe(
			"Context updated: Behavior boundary / Current tasks",
		);
		expect(line(row(notice), labelsOf(zh))).toBe("上下文已更新：行为边界 / 当前任务");
		expect(line(row("Context updated: outline.tasks"), labelsOf(zh))).toBe(
			"上下文已更新：当前任务",
		);
		// Another key in the same update keeps its name.
		expect(line(row("Context updated: outline.tasks, senders"), BASE)).toBe(
			"Context updated: Current tasks / senders",
		);
	});

	it("any other update keeps its stored text", () => {
		for (const notice of [
			"Context updated: workspace",
			"Context updated: senders, tools.availability",
		]) {
			expect(line(row(notice), labelsOf(zh))).toBe(notice);
		}
	});

	it("a live client's row (protocol v2) reads the same", async () => {
		const protocol = await import("@server/websocket/narrator-block-protocol");
		const { decodeBlockFrame } = await import("@frontend/lib/block-protocol");
		const stored = {
			id: "m2",
			narratorId: "n1",
			parentToolUseId: null,
			role: "sys",
			contentJson: [
				{ type: "text", text: "Context updated: outline.tasks" },
				{ type: "context_update", epochId: "e1", changes: [], snapshotRef: "ref" },
			],
			contentText: "Context updated: outline.tasks",
			createdBy: "system",
			origin: "system",
			originLabel: null,
			createdAt: "2026-11-02T10:00:00.000Z",
			children: [],
		};
		const frames = protocol.toBlockFrames({
			type: "message",
			narratorId: "n1",
			message: stored,
		} as never);
		const decoded = frames.flatMap((frame) => decodeBlockFrame(frame as never)) as Array<{
			message?: unknown;
		}>;
		const msg = decoded.find((frame) => frame.message)?.message as never;
		expect(line({ kind: "message", msg } as AdapterSegment, labelsOf(zh))).toBe(
			"上下文已更新：当前任务",
		);
		// The stored row is untouched.
		expect(stored.contentJson[0]).toEqual({ type: "text", text: "Context updated: outline.tasks" });
	});
});
