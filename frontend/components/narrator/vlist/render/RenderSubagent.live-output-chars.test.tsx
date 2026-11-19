/** The Agent header shows its prompt length only while execution is being prepared. */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTopLevelStreamingChunksMsg } from "../../narrator-message-helpers";
import { measureSubagentCard, type SubagentCardData } from "../measure/measure-subagent";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { renderElement, resolveRenderExtra } from "../render-registry";
import { type AdapterContext, adaptSegments } from "../segment-adapter";
import { applyStreamingToolChunk, type StreamingToolStore } from "../streaming-tool-chunks";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());
const WIDTH = 700;

function cardData(
	inputJson: unknown,
	status = "initializing",
	extra: Record<string, unknown> = {},
	context: Partial<AdapterContext> = {},
) {
	const spec = adaptSegments(
		[
			{
				kind: "tool-run",
				sourceMessages: [],
				items: [
					{
						blockIndex: 0,
						isSubagent: true,
						tc: { toolUseId: "agent", toolName: "Agent", inputJson, status, ...extra },
					},
				],
			},
		],
		{ lod: 5, ...context },
	)[0];
	if (!spec || spec.kind !== "subagent-card") throw new Error("missing Agent card");
	return spec;
}

function renderCard(
	inputJson: unknown,
	status = "initializing",
	extra: Record<string, unknown> = {},
	opened = false,
) {
	return renderSpec(cardData(inputJson, status, extra), opened);
}

function renderSpec(spec: ReturnType<typeof cardData>, opened = false) {
	const measured = measureSubagentCard(spec.data as SubagentCardData, WIDTH, 5, { opened });
	const html = renderToStaticMarkup(
		<MantineProvider defaultColorScheme="dark">
			{renderElement(spec.kind, measured, resolveRenderExtra(spec))}
		</MantineProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body>`);
	return { document, measured };
}

const badge = (root: ReturnType<typeof renderCard>) =>
	root.document.querySelector('[data-testid="subagent-prompt-chars"]');

describe("RenderSubagent prompt length badge", () => {
	it("repaints equal saturated tails through the real ExactRow memo with one cached measurement", async () => {
		const { window } = parseHTML("<!doctype html><html><body></body></html>");
		const globals = {
			window,
			document: window.document,
			navigator: window.navigator,
			HTMLElement: window.HTMLElement,
			Element: window.Element,
			Node: window.Node,
			IS_REACT_ACT_ENVIRONMENT: true,
			requestAnimationFrame: () => 0,
			cancelAnimationFrame: () => {},
			matchMedia: () => ({
				matches: false,
				addEventListener() {},
				removeEventListener() {},
				addListener() {},
				removeListener() {},
			}),
			ResizeObserver: class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		};
		const previous = new Map(
			Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
		);
		for (const [key, value] of Object.entries(globals))
			Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
		const { ExactRow } = await import("../ExactRow");
		const measurementModule = await import("../measure/measure-subagent");
		const measure = spyOn(measurementModule, "measureSubagentCard");
		const store: StreamingToolStore = new Map();
		const nextSpec = () => {
			const message = buildTopLevelStreamingChunksMsg([...store.values()], "n", null);
			const tc = message?.toolCalls?.[0];
			if (!tc || !message) throw new Error("missing synthetic Agent");
			const spec = adaptSegments(
				[
					{
						kind: "tool-run",
						sourceMessages: [],
						items: [
							{
								blockIndex: 0,
								isSubagent: true,
								tc: { ...tc },
								msg: message,
							},
						],
					},
				],
				{ lod: 5 },
			)[0];
			if (!spec) throw new Error("missing spec");
			return spec;
		};
		applyStreamingToolChunk(store, {
			toolUseId: "agent",
			toolName: "Agent",
			inputCharsTotal: 20050,
			extractedFields: { description: "same description" },
			streamingField: { name: "prompt", delta: "x".repeat(20000), offset: 0, startsField: true },
		});
		const first = nextSpec();
		const measured = measurementModule.measureSubagentCard(
			first.data as SubagentCardData,
			WIDTH,
			5,
		);
		const firstPreview = (first.data as { prompt: string }).prompt;
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
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
		};
		const labels = { subagent: { promptChars: "{count} chars" } };
		const sourceIds: readonly string[] = [];
		const render = (spec: typeof first) =>
			act(async () =>
				root.render(
					<MantineProvider>
						<ExactRow
							item={{ spec: { ...spec, opts: first.opts }, measured }}
							top={0}
							height={measured.height}
							hitHeight={measured.height}
							contentWidth={WIDTH}
							itemId={undefined}
							sourceIds={sourceIds}
							interactionSig="fixed"
							toggles={toggles}
							renderLabels={labels as never}
							narratorId="n"
						/>
					</MantineProvider>,
				),
			);
		try {
			await render(first);
			expect(host.querySelector('[data-testid="subagent-prompt-chars"]')?.textContent).toBe(
				"20000 chars",
			);
			for (const count of [20001, 20002]) {
				applyStreamingToolChunk(store, {
					toolUseId: "agent",
					toolName: "Agent",
					inputCharsTotal: count + 50,
					streamingField: { name: "prompt", delta: "x", offset: count - 1 },
				});
				const next = nextSpec();
				expect([next.key, next.kind, next.unitId, next.lifecycleId]).toEqual([
					first.key,
					first.kind,
					first.unitId,
					first.lifecycleId,
				]);
				expect((next.data as { prompt: string }).prompt).toBe(firstPreview);
				expect((first.data as { promptChars: number }).promptChars).toBe(20000);
				await render(next);
				expect(host.querySelector('[data-testid="subagent-prompt-chars"]')?.textContent).toBe(
					`${count} chars`,
				);
			}
			const last = nextSpec();
			await render({
				...last,
				data: { ...(last.data as Record<string, unknown>), showPromptChars: false },
			});
			expect(host.querySelector('[data-testid="subagent-prompt-chars"]')).toBeNull();
			expect(measure).toHaveBeenCalledTimes(1);
		} finally {
			await act(async () => root.unmount());
			host.remove();
			measure.mockRestore();
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	});

	it("keeps delegation, late labels and recent summaries alongside the preparation badge", () => {
		const spec = cardData(
			{ prompt: "hello", task: "Kx81mPqa/Ab3dEf9Q", description: "Fix it" },
			"initializing",
			{
				_metadata: {
					outlineDelegation: {
						task: "Kx81mPqa/Ab3dEf9Q",
						title: "Fix the refresh race",
						generation: 1,
						status: "late",
						reason: "redelegated",
					},
				},
				_subagentActivity: {
					latestToolCalls: [
						{ toolName: "Bash", inputSummary: "Review workspace", status: "running" },
					],
				},
			},
			{
				resolveSubagentRecentSummary: (_name, summary) =>
					typeof summary === "string" ? summary : null,
				resolveToolCategory: () => "bash",
			},
		);
		const localized = {
			...spec,
			opts: {
				...spec.opts,
				labels: {
					delegatedTask: "任务：{title}",
					lateBadge: "迟到",
					lateReasons: { redelegated: "任务已重新委派" },
					promptChars: "提示 {count} 字符",
					promptCharsTooltip: "提示词长度",
				},
			},
		};
		for (const opened of [false, true]) {
			const rendered = renderSpec(localized, opened);
			expect(badge(rendered)?.textContent).toBe("提示 5 字符");
			expect(rendered.document.querySelector('[data-testid="subagent-task"]')?.textContent).toBe(
				"任务：Fix the refresh race",
			);
			const late = rendered.document.querySelector('[data-testid="subagent-late"]');
			expect(late?.textContent).toBe("迟到");
			expect(late?.getAttribute("aria-label")).toBe("任务已重新委派");
			expect(
				rendered.document.querySelector('[data-testid="subagent-activity-label"]')?.textContent,
			).toBe("BashReview workspace");
			expect(rendered.measured.delegationRowHeight).toBeGreaterThan(0);
			const withoutBadge = measureSubagentCard(
				{ ...(spec.data as SubagentCardData), showPromptChars: false } as SubagentCardData,
				WIDTH,
				5,
				{ opened },
			);
			expect(rendered.measured.headerHeight).toBe(withoutBadge.headerHeight);
			expect(rendered.measured.height).toBe(withoutBadge.height);
		}
	});

	it("supports an explicit live output count without replacing the preparation badge", () => {
		const spec = cardData({ prompt: "hello" }, "running");
		const data = { ...(spec.data as SubagentCardData), liveOutputChars: 42 };
		const active = renderSpec({ ...spec, data });
		expect(
			active.document.querySelector('[data-testid="subagent-output-chars"]')?.textContent,
		).toBe("42 chars");
		expect(badge(active)).toBeNull();
		const preparing = renderSpec({ ...spec, data: { ...data, showPromptChars: true } });
		expect(badge(preparing)?.textContent).toBe("5 chars");
		expect(preparing.document.querySelector('[data-testid="subagent-output-chars"]')).toBeNull();
		const settled = renderSpec({ ...spec, data: { ...data, isActive: false } });
		expect(settled.document.querySelector('[data-testid="subagent-output-chars"]')).toBeNull();
	});

	it("counts only the prompt and keeps an explicit empty string distinct from missing", () => {
		expect(
			badge(
				renderCard({ prompt: "调查🙂", description: "d".repeat(500), context: "c".repeat(800) }),
			)?.textContent,
		).toBe("4 chars");
		expect(badge(renderCard({ prompt: "" }))?.textContent).toBe("0 chars");
		expect(badge(renderCard({ description: "ready" }))).toBeNull();
	});

	it("uses projected prompt fullLength rather than its preview", () => {
		expect(
			badge(renderCard({ prompt: { _truncated: true, preview: "short", fullLength: 12000 } }))
				?.textContent,
		).toBe("12000 chars");
	});

	for (const status of ["streaming", "initializing", "pending"]) {
		it(`shows the known prompt during ${status}, including a stream-start timestamp`, () => {
			expect(
				badge(renderCard({ prompt: "hello" }, status, { startedAt: 100, streamStartedAt: 100 }))
					?.textContent,
			).toBe("5 chars");
		});
	}

	for (const status of ["running", "success", "completed", "fail", "cancelled", "hold"]) {
		it(`hides the badge during ${status} despite stale input and output counts`, () => {
			const rendered = renderCard(
				{
					prompt: "hello",
					_streamingChars: 999,
					_streamingFieldName: "prompt",
					_streamingFieldValue: "hello",
				},
				status,
				{ _streamingOutput: "0", _takenOver: true },
			);
			expect(badge(rendered)).toBeNull();
			expect(rendered.document.querySelector('[data-testid="subagent-output-chars"]')).toBeNull();
		});
	}

	it("hides as soon as executionStartedAt exists even with a preparatory status", () => {
		for (const executionStartedAt of [0, 200, "2026-10-25T00:00:00Z"]) {
			expect(badge(renderCard({ prompt: "hello" }, "pending", { executionStartedAt }))).toBeNull();
		}
	});

	it("keeps folded and expanded card geometry independent of the badge", () => {
		for (const opened of [false, true]) {
			const spec = cardData({ prompt: "same prompt", description: "same description" });
			const withBadge = measureSubagentCard(spec.data as SubagentCardData, WIDTH, 5, { opened });
			const without = measureSubagentCard(
				{ ...(spec.data as SubagentCardData), showPromptChars: false } as SubagentCardData,
				WIDTH,
				5,
				{ opened },
			);
			expect(withBadge.height).toBe(without.height);
			expect(withBadge.headerHeight).toBe(without.headerHeight);
			expect(
				badge(
					renderCard(
						{ prompt: "same prompt", description: "same description" },
						"initializing",
						{},
						opened,
					),
				)?.textContent,
			).toBe("11 chars");
		}
	});
});
