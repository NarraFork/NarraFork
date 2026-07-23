import { describe, expect, it } from "bun:test";
import { isValidElement } from "react";
import type { MeasuredElement } from "./prepared-block";
import { VLIST_ELEMENT_KINDS, type VListElementKind } from "./registry";
import { RenderMarkdown } from "./render/RenderMarkdown";
import { RenderMessageBubble } from "./render/RenderMessageBubble";
import { RenderPruneDivider } from "./render/RenderMisc";
import { RenderToolRun, RenderTraceCountLine } from "./render/RenderToolRun";
import { type RenderExtra, renderElement } from "./render-registry";

// A minimal MeasuredElement stub — renderElement only forwards it as a prop, so
// element-type routing can be asserted without running the component bodies.
const STUB: MeasuredElement = {
	height: 10,
	blocks: [],
	frame: { blocks: [], contentHeight: 10, usedWidth: 0 },
	contentWidth: 100,
	usedWidth: 0,
};

/** Read the component function a rendered element routes to. */
function elementType(node: React.ReactNode): unknown {
	return isValidElement(node) ? (node as React.ReactElement).type : null;
}

describe("render-registry dispatch", () => {
	it("returns a valid React element for every registered kind", () => {
		for (const kind of VLIST_ELEMENT_KINDS) {
			const extra: RenderExtra = kindExtra(kind);
			const node = renderElement(kind, STUB, extra);
			expect(isValidElement(node)).toBe(true);
		}
	});

	it("routes representative kinds to the correct render component", () => {
		expect(elementType(renderElement("markdown", STUB))).toBe(RenderMarkdown);
		expect(elementType(renderElement("message-bubble", STUB, { role: "user" }))).toBe(
			RenderMessageBubble,
		);
		// Several trace kinds share RenderToolRun / RenderTraceCountLine.
		expect(elementType(renderElement("tool-run-summary", STUB))).toBe(RenderToolRun);
		expect(elementType(renderElement("activity-trace", STUB))).toBe(RenderToolRun);
		expect(elementType(renderElement("reasoning-steps", STUB))).toBe(RenderToolRun);
		expect(elementType(renderElement("tool-run-count", STUB))).toBe(RenderTraceCountLine);
		expect(elementType(renderElement("reasoning-count", STUB))).toBe(RenderTraceCountLine);
		expect(elementType(renderElement("prune-divider", STUB, { data: { label: "x" } }))).toBe(
			RenderPruneDivider,
		);
	});

	it("passes the message-bubble role through to props", () => {
		const node = renderElement("message-bubble", STUB, { role: "user" });
		const props = isValidElement(node) ? (node as React.ReactElement).props : {};
		expect((props as { role: string }).role).toBe("user");
	});

	it("defaults message-bubble role to assistant when unspecified", () => {
		const node = renderElement("message-bubble", STUB);
		const props = isValidElement(node) ? (node as React.ReactElement).props : {};
		expect((props as { role: string }).role).toBe("assistant");
	});

	it("resolveRenderExtra derives web-search isSearching from status", async () => {
		const { resolveRenderExtra } = await import("./render-registry");
		// completed → not searching; anything else → searching (else a running
		// search renders as done — the render-path cast risk this closes).
		expect(
			(
				resolveRenderExtra({ kind: "web-search", data: { status: "completed" } }) as {
					isSearching: boolean;
				}
			).isSearching,
		).toBe(false);
		expect(
			(
				resolveRenderExtra({ kind: "web-search", data: { status: "searching" } }) as {
					isSearching: boolean;
				}
			).isSearching,
		).toBe(true);
		expect(
			(resolveRenderExtra({ kind: "web-search", data: {} }) as { isSearching: boolean })
				.isSearching,
		).toBe(false);
	});

	it("resolveRenderExtra passes message-bubble role and subagent description", async () => {
		const { resolveRenderExtra } = await import("./render-registry");
		expect(
			(resolveRenderExtra({ kind: "message-bubble", data: { role: "user" } }) as { role: string })
				.role,
		).toBe("user");
		expect(
			(
				resolveRenderExtra({ kind: "subagent-card", data: { description: "d" } }) as {
					description: string;
				}
			).description,
		).toBe("d");
	});

	it("resolveRenderExtra forwards interaction callbacks from measured specs", async () => {
		const { resolveRenderExtra } = await import("./render-registry");
		const onToggle = () => {};
		const onToggleItems = () => {};
		const onToggleEarlier = () => {};
		const onToggleRow = (_index: number) => {};
		const extra = resolveRenderExtra({
			kind: "activity-trace",
			data: { items: [] },
			opts: { onToggle, onToggleItems, onToggleEarlier, onToggleRow },
		});
		expect(extra.onToggle).toBe(onToggle);
		expect(extra.onToggleItems).toBe(onToggleItems);
		expect(extra.onToggleEarlier).toBe(onToggleEarlier);
		expect(extra.onToggleRow).toBe(onToggleRow);
	});

	it("resolveRenderExtra forwards kind+data for system-text / ask-in-passing", async () => {
		const { resolveRenderExtra } = await import("./render-registry");
		const extra = resolveRenderExtra({
			kind: "system-text",
			data: { kind: "error", text: "boom" },
		}) as {
			kind: string;
			data: unknown;
		};
		expect(extra.kind).toBe("error");
		expect(extra.data).toEqual({ kind: "error", text: "boom" });
	});

	it("dispatch covers exactly the registry kinds (no missing case)", () => {
		// If a kind were missing from the switch, renderElement returns undefined
		// (not a valid element) — the first test would already fail; this asserts
		// symmetry with the measure registry explicitly.
		const rendered = VLIST_ELEMENT_KINDS.filter((k) =>
			isValidElement(renderElement(k, STUB, kindExtra(k))),
		);
		expect(rendered.length).toBe(VLIST_ELEMENT_KINDS.length);
	});
});

/** Provide the minimal extra props a few kinds need to render an element. */
function kindExtra(kind: VListElementKind): RenderExtra {
	switch (kind) {
		case "message-bubble":
			return { role: "assistant" };
		case "ask-in-passing":
			return { kind: "pending" };
		case "subagent-card":
			return { description: "desc" };
		case "prune-divider":
			return { data: { label: "x" } };
		case "system-text":
			return { kind: "info", data: { text: "" } };
		default:
			return {};
	}
}
