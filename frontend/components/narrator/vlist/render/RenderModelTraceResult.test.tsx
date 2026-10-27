import { beforeAll, describe, expect, it } from "bun:test";
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
import { MODELTRACE_LAYOUT, modelTraceResultHeight } from "../measure/measure-modeltrace-result";
import { installCanvasStub } from "../measure/test-canvas-stub";
import type { RenderLod } from "../prepared-block";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";

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
	{ width = 240, language = "en", lod = 5 as RenderLod, theme = "dark" as "dark" | "light" } = {},
) {
	const i18n = createInstance();
	await i18n.init({
		lng: language,
		fallbackLng: "en",
		resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
	});
	const segment: AdapterSegment = {
		kind: "message",
		msg: rowWithElements({ id: "modeltrace-result-message", role: "disp" }, [block as never]),
	};
	const specs = adaptSegment(segment, { lod });
	expect(specs).toHaveLength(1);
	const spec = specs[0];
	if (!spec) throw new Error("Missing ModelTrace element");
	expect(spec.kind).toBe("modeltrace-result");
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, width, lod, spec.opts);
	const container = document.createElement("div");
	container.style.width = `${width}px`;
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider forceColorScheme={theme}>
					{renderElement(spec.kind, measured, resolveRenderExtra(spec))}
				</MantineProvider>
			</I18nextProvider>,
		);
	});
	return {
		container,
		measured,
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
