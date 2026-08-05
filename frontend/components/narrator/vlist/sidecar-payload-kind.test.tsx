/**
 * sidecar-payload-kind.test.tsx — the sidecar payload's DISCRIMINANT, the cache-key
 * invariants around it, and the truncation notice reaching the DOM.
 *
 * ── Why a discriminant at all ────────────────────────────────────────────────
 *
 * `extractDataRevision` has to route a sidecar payload down one of two branches:
 * a STANDALONE element's own data (keyed by its own source + full text) or a tool
 * card's `sidecars` ARRAY (keyed per item). It used to pick by shape —
 * "`fullText` is a string AND `source` is a string AND `sidecars` is not an array"
 * — which is a guess, not an identification: any future payload that happens to
 * carry those two field names lands in branch 1 and gets keyed by a revision
 * describing something else. A wrong revision means a cache HIT on a stale entry,
 * i.e. new content painted into the height reserved for old content.
 *
 * So the adapter stamps `payloadKind` and the revision reads THAT. Which only holds
 * if every construction point stamps it — the type declares the field optional (so
 * hand-written measure fixtures stay valid), so that invariant is asserted here
 * instead, through the real adapter on both construction paths.
 *
 * ── The property that must NOT regress ───────────────────────────────────────
 *
 * Adding fields to the payload must leave a sidecar-FREE card byte-identical: the
 * whole point of `buildToolSidecarData` returning null (and of the empty
 * `sidecarExpanded` array being omitted) is that the overwhelmingly common case
 * keeps the cache key it had before the feature existed.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	type AdapterSegment,
	adaptSegment,
	type SidecarSpecData,
} from "@shared/pretext-layout/segment-adapter";
import { SIDECAR_PAYLOAD_KIND } from "@shared/pretext-layout/sidecar";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MeasuredSidecar } from "./measure/measure-sidecar";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { extractDataRevision } from "./measure-cache";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";

const WIDTH = 700;
const TRUNCATED = "[Preview truncated — use copy for the full content.]";

beforeAll(() => {
	installCanvasStub();
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	if (typeof g.matchMedia !== "function") {
		g.matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		});
	}
	if (typeof g.ResizeObserver !== "function") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	if (typeof g.requestAnimationFrame !== "function") {
		g.requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number;
	}
	if (typeof g.cancelAnimationFrame !== "function") {
		g.cancelAnimationFrame = (handle: number) => clearTimeout(handle as unknown as Timer);
	}
});

const LABELS: Record<string, string> = { sidecarTruncated: TRUNCATED };

/** A message whose sidecars become STANDALONE sidecar element specs. */
function messageSegment(content: string): AdapterSegment {
	return {
		kind: "message",
		msg: {
			id: "m1",
			role: "assistant",
			contentJson: [{ type: "text", text: "body" }],
			// biome-ignore lint/suspicious/noExplicitAny: structural sidecar mirror
			sideCars: [{ target: "user_message", source: "bg_agent", content, orderIndex: 0 }] as any,
		},
		visibleBlockIndices: [0],
	};
}

/** A tool run whose sidecars become the card's `sidecars` ARRAY. */
function toolSegment(sideCars?: unknown[]): AdapterSegment {
	return {
		kind: "tool-run",
		sourceMessages: [],
		items: [
			{
				blockIndex: 0,
				isSubagent: false,
				tc: {
					toolUseId: "tu-bash",
					toolName: "Bash",
					status: "success",
					...(sideCars ? { sideCars } : {}),
				},
			},
		],
	};
}

describe("payloadKind — every adapter construction point stamps it", () => {
	it("stamps a STANDALONE sidecar element's data", () => {
		const spec = adaptSegment(messageSegment("injected"), { lod: 5, labels: LABELS }).find(
			(s) => s.kind === "sidecar",
		);
		if (!spec) throw new Error("no sidecar spec");
		expect((spec.data as SidecarSpecData).payloadKind).toBe(SIDECAR_PAYLOAD_KIND);
	});

	it("stamps every item of a TOOL CARD's sidecars array", () => {
		const spec = adaptSegment(
			toolSegment([
				{ target: "tool_result", source: "bg_bash", content: "one", orderIndex: 0 },
				{ target: "tool_result", source: "spec_update", content: "two", orderIndex: 1 },
			]),
			{ lod: 5, labels: LABELS },
		)[0];
		const list = (spec?.data as { sidecars?: SidecarSpecData[] }).sidecars ?? [];
		expect(list).toHaveLength(2);
		for (const item of list) expect(item.payloadKind).toBe(SIDECAR_PAYLOAD_KIND);
	});

	it("carries the localized truncation label on both paths", () => {
		// Composed by the adapter (never hard-coded in the render layer), because the
		// measure pass reserves a row for it.
		const standalone = adaptSegment(messageSegment("x"), { lod: 5, labels: LABELS }).find(
			(s) => s.kind === "sidecar",
		);
		expect((standalone?.data as SidecarSpecData).truncatedLabel).toBe(TRUNCATED);
		const tool = adaptSegment(
			toolSegment([{ target: "tool_result", source: "bg_bash", content: "y", orderIndex: 0 }]),
			{ lod: 5, labels: LABELS },
		)[0];
		const list = (tool?.data as { sidecars?: SidecarSpecData[] }).sidecars ?? [];
		expect(list[0]?.truncatedLabel).toBe(TRUNCATED);
	});
});

describe("extractDataRevision — the marker, not the shape, picks the branch", () => {
	it("keys a standalone payload by its own source + body", () => {
		const build = (content: string) =>
			adaptSegment(messageSegment(content), { lod: 5, labels: LABELS }).find(
				(s) => s.kind === "sidecar",
			)?.data;
		const a = extractDataRevision(build("first body"));
		const b = extractDataRevision(build("a completely different injected body"));
		expect(a).toContain("|sc:bg_agent");
		expect(a).not.toBe(b);
	});

	it("keys a tool card by its per-item bodies", () => {
		const build = (content: string) =>
			adaptSegment(
				toolSegment([{ target: "tool_result", source: "bg_bash", content, orderIndex: 0 }]),
				{ lod: 5, labels: LABELS },
			)[0]?.data;
		const a = extractDataRevision(build("one"));
		const b = extractDataRevision(build("a different injected body entirely"));
		expect(a).toContain("|scs:1");
		expect(a).not.toBe(b);
	});

	it("does NOT mistake a foreign payload carrying fullText + source for a sidecar", () => {
		// The exact collision the shape sniff allowed. Without the marker this took
		// the standalone branch and was keyed by a revision describing nothing it owns.
		const foreign = { fullText: "some other body", source: "somewhere-else" };
		expect(extractDataRevision(foreign) ?? "").not.toContain("|sc:");
	});

	it("keeps a sidecar-FREE tool card's revision byte-identical to no-sidecar data", () => {
		// The property the feature was built to preserve: adding fields to the sidecar
		// payload must not perturb the (overwhelmingly common) card that has none.
		const withoutField = adaptSegment(toolSegment(), { lod: 5, labels: LABELS })[0];
		const withEmptyList = adaptSegment(toolSegment([]), { lod: 5, labels: LABELS })[0];
		expect((withoutField?.data as { sidecars?: unknown }).sidecars ?? null).toBeNull();
		expect(extractDataRevision(withEmptyList?.data)).toBe(extractDataRevision(withoutField?.data));
		// And no `sidecarExpanded` key in opts (digestOpts skips absent fields, so the
		// opts digest — and therefore the whole cache key — is unchanged).
		expect(withoutField?.opts).not.toHaveProperty("sidecarExpanded");
		expect(withEmptyList?.opts).not.toHaveProperty("sidecarExpanded");
	});
});

// ── render: the notice must actually reach the DOM at the reserved height ─────

function renderCard(measured: MeasuredSidecar): { container: Element; unmount: () => void } {
	const extra = resolveRenderExtra({
		kind: "sidecar",
		key: "sc",
		data: measured.payload as unknown as Record<string, unknown>,
	} as never);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	act(() => {
		reactRoot.render(
			<MantineProvider>{renderElement("sidecar", measured, extra)}</MantineProvider>,
		);
	});
	return {
		container: container as unknown as Element,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

function measureBody(fullText: string, expanded: boolean): MeasuredSidecar {
	const data: SidecarSpecData = {
		payloadKind: SIDECAR_PAYLOAD_KIND,
		source: "bg_agent",
		sourceLabel: "Background agent",
		color: "blue",
		target: "user_message",
		previewText: "preview",
		fullText,
		truncatedLabel: TRUNCATED,
	};
	return VLIST_REGISTRY.sidecar.measure(data, WIDTH, 5, { expanded }) as MeasuredSidecar;
}

const OVER_CAP = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");

describe("RenderSidecar — the reader learns the body was clipped", () => {
	it("paints the adapter's notice when the line cap hit", () => {
		const card = renderCard(measureBody(OVER_CAP, true));
		expect(card.container.textContent).toContain(TRUNCATED);
		card.unmount();
	});

	it("paints nothing extra when the body fits", () => {
		const card = renderCard(measureBody("one\ntwo\nthree", true));
		expect(card.container.textContent).not.toContain(TRUNCATED);
		card.unmount();
	});

	it("paints nothing extra while collapsed (there is no body yet)", () => {
		const card = renderCard(measureBody(OVER_CAP, false));
		expect(card.container.textContent).not.toContain(TRUNCATED);
		card.unmount();
	});

	it("keeps the copy button on the COMPLETE text, not the clipped view", () => {
		// The notice tells the reader to copy; that has to actually yield everything
		// the payload holds.
		const measured = measureBody(OVER_CAP, true);
		expect(measured.payload.fullText).toBe(OVER_CAP);
		expect(measured.bodyTruncated).toBe(true);
	});
});
