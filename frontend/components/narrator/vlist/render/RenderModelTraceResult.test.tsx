import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { narratorsApi } from "@frontend/lib/api/narrators";
import { MantineProvider } from "@mantine/core";
import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { type AdapterSegment, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../../../locales/en/narrator.json";
import zh from "../../../../locales/zh-CN/narrator.json";
import { ExactRow } from "../ExactRow";
import { MODELTRACE_LAYOUT, modelTraceResultHeight } from "../measure/measure-modeltrace-result";
import { installCanvasStub } from "../measure/test-canvas-stub";
import type { RenderLod } from "../prepared-block";
import { measureElementCached } from "../registry";

const noop = () => {};
const toggles = {
	onToggle: noop,
	onToggleItems: noop,
	onToggleEarlier: noop,
	onToggleRow: noop,
	onToggleTranslation: noop,
	onTogglePrompt: noop,
	onToggleFileChanges: noop,
	onPlanTree: noop,
	onToggleTextExpanded: noop,
};
const renderLabels = {} as never;

beforeAll(() => {
	installCanvasStub();
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(globalThis, {
		window: win,
		document: win.document,
		navigator: win.navigator,
		HTMLElement: win.HTMLElement,
		Element: win.Element,
		Node: win.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
		}),
		requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
		cancelAnimationFrame: (handle: Timer) => clearTimeout(handle),
	});
});

const SUCCESS: ModelTraceResultBlock = {
	type: "modeltrace_result",
	results: [
		{ model: "winner", displayName: "Winner with a very long model name", probability: 0.621 },
		{ model: "second", displayName: "Second", probability: 0.2 },
		{ model: "third", displayName: "Third", probability: 0.1 },
		{ model: "fourth", displayName: "Fourth", probability: 0.05 },
		{ model: "fifth", displayName: "Fifth", probability: 0.029 },
	],
};

async function renderCard(
	block: ModelTraceResultBlock,
	{
		width = 240,
		language = "en",
		lod = 5 as RenderLod,
		theme = "dark" as "dark" | "light",
		calibrationNarratorId = undefined as string | undefined,
	} = {},
) {
	const i18n = createInstance();
	await i18n.init({
		lng: language,
		fallbackLng: "en",
		resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
	});
	const container = document.createElement("div");
	container.style.width = `${width}px`;
	document.body.appendChild(container);
	const root = createRoot(container);
	function rerender(next: ModelTraceResultBlock) {
		const segment: AdapterSegment = {
			kind: "message",
			msg: rowWithElements({ id: "modeltrace-result-message", role: "disp" }, [next as never]),
		};
		const specs = adaptSegment(segment, { lod });
		expect(specs).toHaveLength(1);
		const spec = specs[0];
		if (!spec) throw new Error("Missing ModelTrace element");
		expect(spec.kind).toBe("modeltrace-result");
		const measured = measureElementCached(spec.kind, spec.data, width, lod, spec.opts, spec.key);
		act(() => {
			root.render(
				<I18nextProvider i18n={i18n}>
					<MantineProvider forceColorScheme={theme}>
						<ExactRow
							item={{ spec, measured }}
							top={0}
							height={measured.height}
							hitHeight={measured.height}
							contentWidth={width}
							itemId={undefined}
							sourceIds={[]}
							interactionSig=""
							toggles={toggles}
							renderLabels={renderLabels}
							narratorId={calibrationNarratorId ?? "read-only-narrator"}
							canCalibrateModelTrace={calibrationNarratorId !== undefined}
						/>
					</MantineProvider>
				</I18nextProvider>,
			);
		});
		return measured;
	}
	return {
		container,
		measured: rerender(block),
		rerender,
		unmount() {
			act(() => root.unmount());
			container.remove();
		},
	};
}

function textOnly(container: HTMLElement): string {
	return Array.from(container.querySelectorAll("p"), (node) => node.textContent).join("\n");
}

describe("ModelTrace result adapter → measure → render", () => {
	it("shows the winner once, followed by four alternatives and exactly five bars", async () => {
		const { container, measured, unmount } = await renderCard(SUCCESS);
		try {
			const text = textOnly(container);
			expect(text.split(SUCCESS.results[0]?.displayName ?? "")).toHaveLength(2);
			expect(text).not.toContain("ModelTrace");
			expect(container.querySelector(".mantine-Paper-root")).toBeNull();
			expect(text).toContain("62.1%");
			expect(text).toContain(en.modelTraceFootnote);
			const bars = Array.from(container.querySelectorAll('[role="progressbar"]'));
			expect(bars).toHaveLength(5);
			for (const [index, bar] of bars.entries()) {
				expect(Number(bar.getAttribute("aria-valuenow"))).toBeCloseTo(
					(SUCCESS.results[index]?.probability ?? 0) * 100,
				);
			}
			expect(measured.height).toBe(modelTraceResultHeight(5));
			expect(container.querySelector("[data-modeltrace-result]")?.getAttribute("style")).toContain(
				`height:${measured.height}px`,
			);
			const name = container.querySelector(`p[title="${SUCCESS.results[0]?.displayName}"]`);
			expect(name?.getAttribute("data-truncate")).toBe("end");
			expect(name?.getAttribute("style")).toContain("min-width:0");
		} finally {
			unmount();
		}
	});

	it("keeps fixed geometry at narrow widths and supports Chinese/light theme", async () => {
		const narrow = await renderCard(SUCCESS, { width: 160, language: "zh-CN", theme: "light" });
		const wide = await renderCard(SUCCESS, { width: 900 });
		try {
			expect(narrow.measured.height).toBe(wide.measured.height);
			expect(textOnly(narrow.container)).toContain(zh.modelTraceFootnote);
			expect(narrow.container.querySelectorAll('[role="progressbar"]')).toHaveLength(5);
		} finally {
			narrow.unmount();
			wide.unmount();
		}
	});

	it("renders only the short error without probabilities, bars or footnote", async () => {
		const { container, measured, unmount } = await renderCard({
			type: "modeltrace_result",
			results: [],
			error: "Request timed out",
		});
		try {
			const text = textOnly(container);
			expect(text).toBe("Request timed out");
			expect(text).not.toContain("%");
			expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
			expect(measured.height).toBe(modelTraceResultHeight(0));
		} finally {
			unmount();
		}
	});

	it("normalizes historical partial weights over the displayed top five, but not scored results", async () => {
		const results = [0.3, 0.1, 0.05, 0.05, null, 0.02].map((probability, index) => ({
			model: `candidate-${index}`,
			displayName: `Candidate ${index}`,
			probability,
		}));
		const { container, rerender, unmount } = await renderCard(
			{ ...SUCCESS, decision: "partial", results },
			{ language: "zh-CN" },
		);
		const bars = () =>
			Array.from(container.querySelectorAll('[role="progressbar"]'), (bar) =>
				Number(bar.getAttribute("aria-valuenow")),
			);
		try {
			expect(textOnly(container)).toContain(zh.modelTracePartial);
			expect(textOnly(container)).not.toContain("Candidate 5");
			expect(bars()).toEqual([60, 20, 10, 10]);
			expect(results[0]?.probability).toBe(0.3);
			rerender({ ...SUCCESS, decision: "scored", results });
			expect(bars()).toEqual([30, 10, 5, 5]);
		} finally {
			unmount();
		}
	});

	it("preserves zero weights without dividing by zero", async () => {
		const { container, unmount } = await renderCard({
			...SUCCESS,
			decision: "partial",
			results: [{ model: "candidate", displayName: "Candidate", probability: 0 }],
		});
		try {
			expect(textOnly(container)).toContain("0.0%");
			expect(textOnly(container)).toContain(en.modelTracePartial);
		} finally {
			unmount();
		}
	});

	it("repaints same-key sample progress and updates geometry for the final result", async () => {
		const progress: ModelTraceResultBlock = {
			type: "modeltrace_result",
			results: [],
			calibrationRequested: true,
			progressOnly: true,
			sampleProgress: [
				{ state: "complete" },
				{ state: "running", attempt: 1 },
				{ state: "pending" },
			],
		};
		const { container, measured, rerender, unmount } = await renderCard(progress);
		const states = () =>
			Array.from(container.querySelectorAll("[data-modeltrace-sample-state]"), (slot) =>
				slot.getAttribute("data-modeltrace-sample-state"),
			);
		const slotHeight = MODELTRACE_LAYOUT.footnote + MODELTRACE_LAYOUT.gap;
		try {
			expect(textOnly(container)).toContain(en.modelTraceSampling);
			expect(textOnly(container)).not.toContain(en.modelTraceCalibrationIncomplete);
			expect(states()).toEqual(["complete", "running", "pending"]);
			expect(measured.height).toBe(modelTraceResultHeight(0) + 3 * slotHeight);
			const updated = rerender({
				...progress,
				sampleProgress: [
					{ state: "failed" },
					{ state: "retrying", attempt: 2, text: "Transient failure" },
					{ state: "cancelled" },
				],
			});
			expect(states()).toEqual(["failed", "retrying", "cancelled"]);
			expect(textOnly(container)).toContain("Sample 2: Retrying · Attempt 2 · Transient failure");
			expect(updated.height).toBe(measured.height);
			const final = rerender({
				...SUCCESS,
				decision: "scored",
				calibrationRequested: true,
				sampleProgress: [{ state: "complete" }, { state: "complete" }, { state: "complete" }],
			});
			expect(final.height).toBe(modelTraceResultHeight(5) + 3 * slotHeight);
			expect(textOnly(container)).toContain("62.1%");
			expect(textOnly(container)).not.toContain(en.modelTraceSampling);
		} finally {
			unmount();
		}
	});

	it("submits calibration with the active narrator and result ID, and retries after a POST error", async () => {
		const source: ModelTraceResultBlock = { ...SUCCESS, decision: "partial", calibrationId: "r1" };
		const { container, measured, rerender, unmount } = await renderCard(source, {
			calibrationNarratorId: "trace-child",
		});
		const { promise, resolve } = Promise.withResolvers<{ id: string }>();
		const request = spyOn(narratorsApi, "calibrateModelTrace")
			.mockRejectedValueOnce(new Error("Calibration request failed"))
			.mockImplementationOnce(() => promise);
		const button = container.querySelector("button");
		const click = () => button?.dispatchEvent(new window.Event("click", { bubbles: true }));
		try {
			expect(button?.textContent).toBe(en.modelTraceCalibrate);
			expect(measured.height).toBe(
				modelTraceResultHeight(5) + MODELTRACE_LAYOUT.calibration + MODELTRACE_LAYOUT.gap,
			);
			await act(async () => {
				click();
			});
			expect(container.querySelector('[role="alert"]')?.textContent).toBe(
				"Calibration request failed",
			);
			expect(button?.hasAttribute("disabled")).toBe(false);
			act(() => {
				click();
				click();
			});
			expect(button?.hasAttribute("data-loading")).toBe(true);
			expect(button?.hasAttribute("disabled")).toBe(true);
			expect(request.mock.calls).toEqual([
				["trace-child", "r1"],
				["trace-child", "r1"],
			]);
			await act(async () => resolve({ id: "trace-child" }));
			expect(button?.textContent).toBe(en.modelTraceCalibrationRequested);
			expect(button?.hasAttribute("data-loading")).toBe(false);
			rerender({ ...SUCCESS, decision: "scored" });
			expect(container.querySelector("button")).toBeNull();
		} finally {
			request.mockRestore();
			unmount();
		}
	});

	it("offers continued calibration only on a final card with a fresh token", async () => {
		const source: ModelTraceResultBlock = {
			type: "modeltrace_result",
			decision: "unscorable",
			calibrationRequested: true,
			calibrationId: "next-round",
			results: [],
			sampleProgress: [{ state: "complete" }, { state: "failed" }, { state: "cancelled" }],
		};
		const { container, measured, rerender, unmount } = await renderCard(source, {
			calibrationNarratorId: "trace-child",
			language: "zh-CN",
		});
		try {
			expect(container.querySelector("button")?.textContent).toBe(zh.modelTraceContinueCalibration);
			expect(textOnly(container)).toContain(zh.modelTraceCalibrationIncomplete);
			const inProgress = rerender({ ...source, progressOnly: true, decision: undefined });
			expect(container.querySelector("button")).toBeNull();
			expect(measured.height - inProgress.height).toBe(
				MODELTRACE_LAYOUT.calibration + MODELTRACE_LAYOUT.footnote + 2 * MODELTRACE_LAYOUT.gap,
			);
		} finally {
			unmount();
		}
	});

	it("never shows a calibration button on an external transcript", async () => {
		const { container, unmount } = await renderCard({
			...SUCCESS,
			decision: "partial",
			calibrationId: "r1",
		});
		try {
			expect(container.querySelector("button")).toBeNull();
		} finally {
			unmount();
		}
	});

	it("distinguishes cache reads, misses, and unknown usage when calibration is incomplete", async () => {
		const { container, measured, unmount } = await renderCard(
			{
				type: "modeltrace_result",
				decision: "unscorable",
				calibrationRequested: true,
				cacheReadTokens: [512, 0, null],
				results: [],
			},
			{ language: "zh-CN" },
		);
		try {
			expect(textOnly(container)).toContain(zh.modelTraceCalibrationIncomplete);
			expect(textOnly(container)).toContain("512 · 0 · 未知");
			expect(measured.height).toBe(
				modelTraceResultHeight(0) + 2 * (MODELTRACE_LAYOUT.footnote + MODELTRACE_LAYOUT.gap),
			);
		} finally {
			unmount();
		}
	});

	it("does not show a percentage when the weight is unavailable", async () => {
		const { container, unmount } = await renderCard({
			type: "modeltrace_result",
			decision: "partial",
			results: [{ model: "candidate", displayName: "Candidate", probability: null }],
		});
		try {
			expect(textOnly(container)).toContain("Candidate");
			expect(textOnly(container)).toContain(en.modelTracePartial);
			expect(textOnly(container)).not.toContain("%");
			expect(container.querySelector('[role="progressbar"]')).toBeNull();
		} finally {
			unmount();
		}
	});

	it.each([
		["unscorable", en.modelTraceUnscorable],
		["not_model", en.modelTraceNotModel],
	] as const)("explains the %s decision", async (decision, message) => {
		const { container, unmount } = await renderCard({
			type: "modeltrace_result",
			decision,
			results: [],
		});
		try {
			expect(textOnly(container)).toBe(message);
		} finally {
			unmount();
		}
	});

	it.each([1, 2, 3, 4, 5] as const)("keeps all five result rows at LOD %s", async (lod) => {
		const { container, measured, unmount } = await renderCard(SUCCESS, { lod });
		try {
			expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(5);
			expect(measured.height).toBe(248);
		} finally {
			unmount();
		}
	});

	it("rejects invalid historical probabilities without painting misleading bars", async () => {
		const { container, measured, unmount } = await renderCard({
			type: "modeltrace_result",
			results: [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.1].map((probability) => ({
				model: "invalid",
				displayName: "Invalid",
				probability,
			})),
		});
		try {
			expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
			expect(measured.height).toBe(modelTraceResultHeight(0));
		} finally {
			unmount();
		}
	});

	it("bounds unexpected history payloads and localizes an empty result fallback", async () => {
		const excessive = await renderCard({
			...SUCCESS,
			results: [...SUCCESS.results, ...SUCCESS.results],
		});
		const empty = await renderCard(
			{ type: "modeltrace_result", results: [] },
			{ language: "zh-CN" },
		);
		try {
			expect(excessive.container.querySelectorAll('[role="progressbar"]')).toHaveLength(
				MODELTRACE_LAYOUT.maxResults,
			);
			expect(textOnly(empty.container)).toContain(zh.modelTraceUnavailable);
			expect(empty.container.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
		} finally {
			excessive.unmount();
			empty.unmount();
		}
	});
});
