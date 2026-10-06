import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import type { MeasureElement } from "@shared/pretext-layout/layout-pipeline";
import type { NarratorMsg, PendingPermission } from "../narrator-panel-types";
import { measureInlinePermission } from "./measure/measure-permission";
import {
	type MeasuredToolCall,
	type MeasuredToolCallGroup,
	type MeasureToolCallOpts,
	measureToolCall,
	measureToolCallGroup,
	type ToolCallData,
	toolCardInnerWidth,
} from "./measure/measure-tool-call";
import type { MeasuredCollapsibleTrace } from "./measure/measure-tool-run";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { extractDataRevision } from "./measure-cache";
import { buildPretextDocumentLayout } from "./pretext-document-layout";
import { measureElementCached } from "./registry";
import { predictInlinePermission } from "./vlist-permission-prediction";
import { type ResizePermissionResolver, reflowPermissionForms } from "./vlist-resize-permission";
import { previewResize } from "./vlist-resize-preview";

let disposeCanvas: () => void;
let documentId = 0;
beforeAll(() => {
	disposeCanvas = installCanvasStub();
});
afterAll(() => disposeCanvas());

function request(toolUseId: string): PendingPermission {
	return {
		id: `request-${toolUseId}`,
		toolUseId,
		toolName: "Bash",
		inputJson: { command: "pwd" },
		decisionReason: "Please confirm the execution target before continuing this operation. ".repeat(
			5,
		),
		executionDeviceId: "local",
		executionCwd: `/workspace/${"nested-project/".repeat(8)}`,
	};
}

function prediction(permission: PendingPermission, width: number) {
	const result = predictInlinePermission(permission, {
		innerWidth: toolCardInnerWidth(width, false),
		canDecide: true,
	});
	if (!result) throw new Error("fixture must host an InlinePermission");
	return result;
}

/** Real messages -> segment/group/adapter -> permission prediction -> cached card measures. */
function fixture({
	count = 6,
	width = 860,
	lod = 5,
	oldHeight = 900,
}: {
	count?: number;
	width?: number;
	lod?: 2 | 5;
	oldHeight?: number;
} = {}) {
	const id = `permission-resize-${++documentId}`;
	const requests = Array.from({ length: count }, (_, i) => request(`${id}-t${i}`));
	const byTool = new Map(requests.map((permission) => [permission.toolUseId, permission]));
	const tools: TreeMessage = {
		id: `${id}-assistant`,
		narratorId: id,
		parentToolUseId: null,
		role: "assistant",
		contentJson: requests.map((permission) => ({
			type: "tool_use",
			id: permission.toolUseId ?? "",
			name: "Bash",
			input: { command: "pwd" },
			status: "pending",
		})),
		contentText: null,
		toolCalls: [],
		createdAt: "2026-08-01T00:00:00.000Z",
		children: [],
		seq: 0,
	};
	const tail: TreeMessage = {
		...tools,
		id: `${id}-user`,
		role: "user",
		contentJson: [{ type: "text", text: "Following message keeps the segment gap observable." }],
		seq: 1,
	};
	const built = buildPretextDocumentLayout([tools, tail] as NarratorMsg[], {
		layoutRevision: id,
		documentRevision: id,
		widthBucket: String(width),
		contentWidth: width,
		lod,
		viewportHeight: 400,
		gap: 4,
		segmentGap: 48,
		topPadding: 16,
		bottomPadding: 24,
		resolveToolCategory: () => "shell",
		resolveHasPendingPermission: (toolUseId) => byTool.has(toolUseId),
		resolvePermissionFormPrediction: (toolUseId) => {
			const permission = byTool.get(toolUseId);
			return permission ? prediction(permission, width) : undefined;
		},
		resolvePermissionFormHeight: () => oldHeight,
	});
	const resolve: ResizePermissionResolver = (toolUseId, nextWidth) => {
		const permission = byTool.get(toolUseId);
		return permission ? { prediction: prediction(permission, nextWidth) } : undefined;
	};
	return { ...built, id, requests, byTool, resolve, lod, width, committedWidth: width };
}

function card(data: unknown): ToolCallData {
	const result = data as ToolCallData;
	if (!result.permissionForm || !result.toolUseId)
		throw new Error("expected an adapted permission card");
	return result;
}

function measureCalls() {
	const calls: string[] = [];
	const measure: MeasureElement = (...args) => {
		calls.push(args[5] ?? "");
		return measureElementCached(...args);
	};
	return { calls, measure };
}

function gapGeometry(index: ReturnType<typeof fixture>["index"]) {
	let cursor = index.manifest.metrics.topPadding;
	for (const [i, item] of index.manifest.items.entries()) {
		expect(index.itemStart(i)).toBe(cursor);
		cursor += item.height;
		expect(index.itemEnd(i)).toBe(cursor);
		if (i < index.manifest.items.length - 1)
			cursor += item.gapAfter ?? index.manifest.metrics.itemGap;
	}
	expect(index.totalHeight).toBe(cursor + index.manifest.metrics.bottomPadding);
}

describe("permission forms reflow through real card measurements", () => {
	it("passes the new outer width to fresh prediction and never carries the old painted height", () => {
		const base = fixture();
		const first = base.items.find((item) => item.spec.kind === "tool-call");
		if (!first) throw new Error("fixture produced no standalone tool card");
		const old = card(first.spec.data);
		const oldPrediction = old.permissionForm?.prediction;
		const calls: [string, number][] = [];
		const result = previewResize({
			...base,
			width: 420,
			view: { scrollTop: 0, viewportHeight: 400, pinnedToBottom: false },
			measure: measureElementCached,
			resolvePermissionForm: (toolUseId, width) => {
				calls.push([toolUseId, width]);
				return base.resolve(toolUseId, width);
			},
		});
		const i = result.items.findIndex((item) => item.spec.key === first.spec.key);
		const next = card(result.items[i]?.spec.data);
		const permission = base.byTool.get(old.toolUseId);
		if (!permission) throw new Error("request missing");
		expect(calls).toContainEqual([old.toolUseId ?? "", 420]);
		expect(next.permissionForm?.height).toBeUndefined();
		expect(next.permissionForm?.prediction).toEqual(prediction(permission, 420));
		expect(next.permissionForm?.prediction).not.toEqual(oldPrediction);
		const measured = result.items[i]?.measured as MeasuredToolCall;
		const predicted = measureInlinePermission(
			next.permissionForm?.prediction ?? {},
			measured.contentWidth,
			5,
		);
		expect(measured.permissionFormHeight).toBe(predicted.topMargin + predicted.height);
		expect(measured.permissionFormHeight).not.toBe(900);
		expect(measured).toEqual(measureToolCall(next, 420, 5, first.spec.opts as MeasureToolCallOpts));
		expect(old.permissionForm?.height).toBe(900);
		expect(old.permissionForm?.prediction).toBe(oldPrediction);
		expect(first.contentWidth).toBe(860);
		gapGeometry(result.index);
	});

	it("reflows real low-LOD trace items[].card while preserving the old trace snapshot", () => {
		const base = fixture({ lod: 2, count: 3 });
		const first = base.items.find((item) => item.spec.kind === "activity-trace");
		if (!first) throw new Error("fixture produced no activity trace");
		const old = first.spec.data as { items: { key: string; card: ToolCallData }[] };
		expect(old.items).toHaveLength(3);
		const result = previewResize({
			...base,
			width: 420,
			view: { scrollTop: 0, viewportHeight: 400, pinnedToBottom: false },
			measure: measureElementCached,
			resolvePermissionForm: base.resolve,
		});
		const trace = result.items.find((item) => item.spec.key === first.spec.key);
		const next = trace?.spec.data as typeof old;
		expect(next).not.toBe(old);
		expect(next.items).not.toBe(old.items);
		for (const [i, row] of next.items.entries()) {
			expect(row.card.permissionForm?.height).toBeUndefined();
			expect(old.items[i]?.card.permissionForm?.height).toBe(900);
		}
		const measured = trace?.measured as MeasuredCollapsibleTrace;
		const drilled = measured.rows.filter((row) => row.cardMeasured != null);
		expect(drilled).toHaveLength(3);
		for (const row of drilled) {
			const nested = row.cardMeasured as MeasuredToolCall;
			expect(nested.permissionFormHeight).toBeGreaterThan(0);
			expect(nested.permissionFormHeight).not.toBe(900);
		}
		gapGeometry(result.index);
	});

	it("reflows a grouped card array without touching unchanged cards or mutating the input", () => {
		const base = fixture({ count: 2 });
		const a = card(base.items[0]?.spec.data);
		const b = card(base.items[1]?.spec.data);
		const unchanged: ToolCallData = { ...b, permissionForm: undefined };
		const original = [a, unchanged];
		const result = reflowPermissionForms(original, 420, base.resolve) as ToolCallData[];
		expect(result).not.toBe(original);
		expect(result[0]).not.toBe(a);
		expect(result[0]?.permissionForm?.height).toBeUndefined();
		expect(result[1]).toBe(unchanged);
		expect(a.permissionForm?.height).toBe(900);
		const measured = measureToolCallGroup(result, 420, 5, { expanded: true });
		expect(measured.children[0]?.permissionFormHeight).not.toBe(900);
		expect(measured.children[0]?.permissionFormHeight).toBeGreaterThan(0);
		expect(measured.children[1]?.permissionFormHeight).toBe(0);
	});

	it("reflows the real registry tool-call-group payload's toolCalls array", () => {
		const base = fixture({ count: 2 });
		const data = { toolCalls: base.items.slice(0, 2).map((item) => card(item.spec.data)) };
		const calls: string[] = [];
		const result = reflowPermissionForms(data, 420, (toolUseId, width) => {
			calls.push(toolUseId);
			return base.resolve(toolUseId, width);
		}) as typeof data;
		expect(calls).toHaveLength(2);
		expect(result.toolCalls).not.toBe(data.toolCalls);
		const measured = measureElementCached(
			"tool-call-group",
			result,
			420,
			5,
			{ expanded: true },
			`${base.id}-group`,
			base.id,
		) as MeasuredToolCallGroup;
		expect(measured.children).toHaveLength(2);
		for (const child of measured.children) expect(child.permissionFormHeight).not.toBe(900);
		expect(data.toolCalls.every((entry) => entry.permissionForm?.height === 900)).toBe(true);
	});

	it("does not read or enumerate arbitrary huge input/output objects and keeps their references", () => {
		const base = fixture({ count: 1 });
		const old = card(base.items[0]?.spec.data);
		let reads = 0;
		const opaque = () =>
			new Proxy(
				{ byteLength: 128 * 1024 * 1024 },
				{
					get: () => {
						reads++;
						throw new Error("tool input/output must not be read");
					},
					ownKeys: () => {
						reads++;
						throw new Error("tool input/output must not be enumerated");
					},
					getOwnPropertyDescriptor: () => {
						reads++;
						throw new Error("tool input/output must not be traversed");
					},
				},
			);
		const input = opaque();
		const output = opaque();
		const data = {
			...old,
			inputJson: input,
			outputJson: output,
			detailPayload: { items: input, card: output },
		};
		const result = reflowPermissionForms(data, 420, base.resolve) as typeof data;
		expect(result.inputJson).toBe(input);
		expect(result.outputJson).toBe(output);
		expect(result.detailPayload).toBe(data.detailPayload);
		expect(reads).toBe(0);
		expect(data.permissionForm?.height).toBe(900);
		expect(result.permissionForm?.height).toBeUndefined();
		measureToolCall(result, 420);
		expect(reads).toBe(0);
	});

	for (const resolver of [undefined, (() => undefined) satisfies ResizePermissionResolver]) {
		it(`drops old form height with ${resolver ? "an unresolved request" : "no resolver"}`, () => {
			const base = fixture({ count: 1 });
			const old = card(base.items[0]?.spec.data);
			const result = reflowPermissionForms(old, 420, resolver) as ToolCallData;
			expect(result.permissionForm?.height).toBeUndefined();
			expect(result.permissionForm?.prediction).toBe(old.permissionForm?.prediction);
			expect(old.permissionForm?.height).toBe(900);
			const measured = measureToolCall(result, 420, 5);
			expect(measured.permissionFormHeight).not.toBe(900);
			expect(measured.permissionFormHeight).toBeGreaterThan(0);
		});
	}

	it("same-width dirtyKeys measures only the visible dirty card and keeps all other frames by reference", () => {
		const base = fixture({ count: 8 });
		const visible = base.items[3];
		const offscreen = base.items[7];
		if (!visible || !offscreen) throw new Error("fixture cards missing");
		const { calls, measure } = measureCalls();
		const dirtyKeys = new Set([visible.spec.key, offscreen.spec.key]);
		const result = previewResize({
			...base,
			width: base.width,
			dirtyKeys,
			overscan: 0,
			view: { scrollTop: base.index.itemStart(3) + 9, viewportHeight: 100, pinnedToBottom: false },
			measure,
			resolvePermissionForm: (toolUseId, width) => {
				const form = base.resolve(toolUseId, width);
				return form ? { ...form, height: 500 } : undefined;
			},
		});
		expect(calls).toEqual([visible.spec.key]);
		expect([...result.changedKeys]).toEqual([visible.spec.key]);
		expect(result.needsMore).toBe(false);
		expect(result.items[3]?.measured).not.toBe(visible.measured);
		expect((result.items[3]?.measured as MeasuredToolCall).permissionFormHeight).toBe(500);
		for (const [i, item] of base.items.entries()) {
			if (i === 3) continue;
			expect(result.items[i]).toBe(item);
			expect(result.items[i]?.spec).toBe(item.spec);
			expect(result.items[i]?.measured).toBe(item.measured);
			expect(result.items[i]?.contentWidth).toBe(base.width);
		}
		expect(dirtyKeys.size).toBe(2);
		gapGeometry(result.index);
	});

	it("budgets same-width dirty form reports, advertises needsMore and skips clean current-width rows", () => {
		const base = fixture({ count: 6 });
		const dirtyKeys = new Set(
			base.items.filter((item) => item.spec.kind === "tool-call").map((item) => item.spec.key),
		);
		const { calls, measure } = measureCalls();
		const resolve: ResizePermissionResolver = (toolUseId, width) => {
			const form = base.resolve(toolUseId, width);
			return form ? { ...form, height: 450 } : undefined;
		};
		const input = {
			...base,
			width: base.width,
			dirtyKeys,
			maxItems: 2,
			overscan: 0,
			view: { scrollTop: 0, viewportHeight: base.index.totalHeight, pinnedToBottom: false },
			measure,
			resolvePermissionForm: resolve,
		};
		let result = previewResize(input);
		expect(calls).toHaveLength(2);
		expect(result.changedKeys.size).toBe(2);
		expect(result.needsMore).toBe(true);
		for (let batch = 0; batch < 3; batch++) {
			for (const key of result.changedKeys) dirtyKeys.delete(key);
			const previous = calls.length;
			result = previewResize({ ...input, index: result.index, items: result.items });
			expect(calls.length - previous).toBeLessThanOrEqual(2);
		}
		expect(result.needsMore).toBe(false);
		expect(dirtyKeys.size).toBe(0);
		expect(calls).toHaveLength(6);
		expect(new Set(calls).size).toBe(6);
		expect(result.items.at(-1)).toBe(base.items.at(-1));
	});

	it("uses the reported height via resolver, rekeys cached form geometry and preserves every gap", () => {
		const base = fixture({ count: 3 });
		const first = base.items[0];
		if (!first) throw new Error("fixture card missing");
		const old = card(first.spec.data);
		const beforeRevision = extractDataRevision(old);
		const dirtyKeys = new Set([first.spec.key]);
		const result = previewResize({
			...base,
			width: base.width,
			dirtyKeys,
			view: { scrollTop: 0, viewportHeight: 300, pinnedToBottom: false },
			measure: measureElementCached,
			resolvePermissionForm: (toolUseId, width) => {
				const form = base.resolve(toolUseId, width);
				return form ? { ...form, height: 333 } : undefined;
			},
		});
		const next = card(result.items[0]?.spec.data);
		const measured = result.items[0]?.measured as MeasuredToolCall;
		expect(extractDataRevision(next)).not.toBe(beforeRevision);
		expect(measured.permissionFormHeight).toBe(333);
		expect(measured).toEqual(
			measureToolCall(next, base.width, 5, first.spec.opts as MeasureToolCallOpts),
		);
		expect(result.index.manifest.items[0]?.height).toBe(measured.height);
		expect(result.index.totalHeight - base.index.totalHeight).toBe(333 - 900);
		expect(result.index.manifest.items.map((item) => item.gapAfter)).toEqual(
			base.index.manifest.items.map((item) => item.gapAfter),
		);
		expect(base.index.manifest.items.some((item) => item.gapAfter === 0)).toBe(true);
		expect(base.index.manifest.items.some((item) => item.gapAfter === 48)).toBe(true);
		gapGeometry(result.index);
		const cached = measureElementCached(
			"tool-call",
			next,
			base.width,
			5,
			first.spec.opts,
			first.spec.key,
			base.index.manifest.documentRevision,
		);
		expect(cached).toBe(measured);
		expect(cached).not.toBe(first.measured);
		expect((first.measured as MeasuredToolCall).permissionFormHeight).toBe(900);
	});

	it("nested trace card form height invalidates its unchanged-width cache entry", () => {
		const base = fixture({ lod: 2, count: 2 });
		const first = base.items.find((item) => item.spec.kind === "activity-trace");
		if (!first) throw new Error("trace missing");
		const updated = reflowPermissionForms(first.spec.data, 860, (toolUseId, width) => {
			const form = base.resolve(toolUseId, width);
			return form ? { ...form, height: 377 } : undefined;
		});
		expect(extractDataRevision(updated)).not.toBe(extractDataRevision(first.spec.data));
		const measured = measureElementCached(
			first.spec.kind,
			updated,
			860,
			2,
			first.spec.opts,
			first.spec.key,
			base.id,
		) as MeasuredCollapsibleTrace;
		expect(measured).not.toBe(first.measured);
		for (const row of measured.rows)
			expect((row.cardMeasured as MeasuredToolCall).permissionFormHeight).toBe(377);
	});

	it("group child form height invalidates a real registry group cache entry at the same width", () => {
		const base = fixture({ count: 2 });
		const toolCalls = base.items.slice(0, 2).map((item) => card(item.spec.data));
		const key = `${base.id}-cached-group`;
		const opts = { expanded: true };
		const data = { toolCalls };
		const original = measureElementCached(
			"tool-call-group",
			data,
			860,
			5,
			opts,
			key,
			base.id,
		) as MeasuredToolCallGroup;
		const updated = {
			toolCalls: reflowPermissionForms(toolCalls, 860, (toolUseId, width) => {
				const form = base.resolve(toolUseId, width);
				return form ? { ...form, height: 377 } : undefined;
			}) as ToolCallData[],
		};
		const measured = measureElementCached(
			"tool-call-group",
			updated,
			860,
			5,
			opts,
			key,
			base.id,
		) as MeasuredToolCallGroup;
		expect(measured).toEqual(measureToolCallGroup(updated.toolCalls, 860, 5, opts));
		expect(measured).not.toBe(original);
		for (const child of measured.children) expect(child.permissionFormHeight).toBe(377);
		for (const child of original.children) expect(child.permissionFormHeight).toBe(900);
	});
});
