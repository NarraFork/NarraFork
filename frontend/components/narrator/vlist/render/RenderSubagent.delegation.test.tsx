/**
 * An Agent call sent with an outline task (outline P2 PR 9b): its card names the task under the
 * description and marks a late result, through the real segment → adapter → measure → render
 * chain. The task row is one fixed line (height by its presence only), the late badge rides the
 * fixed badge row (height-neutral); the title links the task where an outline panel can open it
 * and is plain text elsewhere; both are keyed in the measure cache.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { resetAppBaseForTest } from "@frontend/lib/base-path";
import { OutlineOpenerProvider } from "@frontend/lib/outline-opener";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import narratorEn from "../../../../locales/en/narrator.json";
import narratorZh from "../../../../locales/zh-CN/narrator.json";
import { ImageViewerProvider } from "../../../common/ImageViewerProvider";
import { segmentMessages } from "../../message/message-segments";
import type { NarratorMsg } from "../../narrator-panel-types";
import { DELEGATION_ROW_MARGIN_TOP, measureSubagentCard } from "../measure/measure-subagent";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { extractDataRevision } from "../measure-cache";
import { typographyMetrics } from "../pretext-fonts";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "../segment-adapter";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

const CTX: AdapterContext = { lod: 5 };
const opener = { open: () => true };

function mountAt(mountUrl: string): void {
	resetAppBaseForTest();
	const g = globalThis as { document?: unknown; location?: unknown };
	g.document = { baseURI: mountUrl };
	g.location = { href: mountUrl, origin: new URL(mountUrl).origin };
}

afterEach(() => {
	resetAppBaseForTest();
	const g = globalThis as { document?: unknown; location?: unknown };
	delete g.document;
	delete g.location;
});

const note = (status: string, reason?: string) =>
	[
		`<outline_report task="Kx81mPqa/Ab3dEf9Q" report="Kx81mPqa/Rp1Rp1Rp" generation="1" status="${status}"${reason ? ` reason="${reason}"` : ""}>`,
		status === "current"
			? "The report is attached under the task [[Kx81mPqa/Ab3dEf9Q|Fix the refresh race]] as [[Kx81mPqa/Rp1Rp1Rp|Report (generation 1)]] (2 blocks)."
			: "Late result: since this agent was sent, the task was taken over by someone.",
		"</outline_report>",
	].join("\n");

function agentMessage(input: Record<string, unknown>, output: string | null): NarratorMsg {
	const outputJson = output === null ? undefined : { _text: output, _metadata: {} };
	const status = output === null ? "running" : "completed";
	return rowWithElements(
		{
			id: "a-agent",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			toolCalls: [
				{ toolUseId: "tu-agent", toolName: "Agent", inputJson: input, outputJson, status },
			],
			createdAt: "2026-11-06T00:00:00Z",
		},
		[
			{
				type: "tool_use",
				id: "tu-agent",
				name: "Agent",
				input,
				inputJson: input,
				outputJson,
				status,
			},
		],
	) as unknown as NarratorMsg;
}

function specOf(message: NarratorMsg) {
	const segments = segmentMessages([message]) as unknown as AdapterSegment[];
	const spec = adaptSegments(segments, CTX).find((s) => s.kind === "subagent-card");
	if (!spec) throw new Error("no subagent card");
	return spec;
}

function render(
	message: NarratorMsg,
	options: { withOpener: boolean; labels?: Record<string, unknown> },
): Element {
	const spec = specOf(message);
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, 800, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	if (options.labels) extra.labels = options.labels;
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	const html = renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<MantineProvider>
				<ImageViewerProvider>
					<OutlineOpenerProvider value={options.withOpener ? opener : null}>
						{renderElement(spec.kind, measured, extra)}
					</OutlineOpenerProvider>
				</ImageViewerProvider>
			</MantineProvider>
		</QueryClientProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
	return document.getElementById("r") as unknown as Element;
}

const REPORT = "# Findings\nThe race is in refresh().";
const byId = (root: Element, id: string) => root.querySelector(`[data-testid="${id}"]`);

describe("the task row", () => {
	it("names the task from the note and links it inside a host, under the app's mount prefix", () => {
		mountAt("https://example.test/nf/");
		const root = render(
			agentMessage({ task: "Ab3dEf9Q", description: "Fix it" }, `${REPORT}\n\n${note("current")}`),
			{ withOpener: true },
		);
		const row = byId(root, "subagent-task");
		expect(row?.textContent).toBe("Task: Fix the refresh race");
		const link = byId(root, "subagent-task-link");
		expect(link?.getAttribute("href")).toBe("/nf/outline/ref?a=Kx81mPqa%2FAb3dEf9Q");
		expect(link?.hasAttribute("data-outline-link")).toBe(true);
		expect(byId(root, "subagent-late")).toBeNull();
	});

	it("is plain text where nothing can open the outline", () => {
		const root = render(
			agentMessage({ task: "Ab3dEf9Q", description: "Fix it" }, `${REPORT}\n\n${note("current")}`),
			{ withOpener: false },
		);
		expect(byId(root, "subagent-task-link")).toBeNull();
		expect(byId(root, "subagent-task-title")?.textContent).toBe("Fix the refresh race");
	});

	it("a background launch: the title from its launch line", () => {
		const root = render(
			agentMessage(
				{ task: "Ab3dEf9Q", run_in_background: true },
				"<background_task_id>bg1</background_task_id>\nDelegated [[Kx81mPqa/Ab3dEf9Q|Fix the refresh race]] to this agent (claim generation 1); its report will be attached under the task when it finishes.",
			),
			{ withOpener: true },
		);
		expect(byId(root, "subagent-task")?.textContent).toBe("Task: Fix the refresh race");
	});

	it("running in the foreground: what the call wrote, linked only when it is an address", () => {
		const bare = render(agentMessage({ task: "Fix the refresh race" }, null), {
			withOpener: true,
		});
		expect(byId(bare, "subagent-task")?.textContent).toBe("Task: Fix the refresh race");
		expect(byId(bare, "subagent-task-link")).toBeNull();
		const address = render(agentMessage({ task: "Kx81mPqa/Ab3dEf9Q" }, null), {
			withOpener: true,
		});
		expect(byId(address, "subagent-task-link")?.textContent).toBe("Kx81mPqa/Ab3dEf9Q");
	});

	it("an agent sent without a task has no row and the same height as before", () => {
		const root = render(agentMessage({ description: "Look around" }, REPORT), {
			withOpener: true,
		});
		expect(byId(root, "subagent-task")).toBeNull();
		const spec = specOf(agentMessage({ description: "Look around" }, REPORT));
		expect((spec.data as Record<string, unknown>).delegation).toBeUndefined();
	});

	it("adds exactly one line to the header, folded or open", () => {
		const base = { agentType: "general", description: "Fix it", isTerminal: true };
		const delegation = { title: "Fix the refresh race", address: "a/b", late: null };
		for (const opened of [false, true]) {
			const without = measureSubagentCard(base, 600, 5, { opened });
			const withRow = measureSubagentCard({ ...base, delegation }, 600, 5, { opened });
			expect(withRow.delegationRowHeight).toBe(
				DELEGATION_ROW_MARGIN_TOP + typographyMetrics().line.xs,
			);
			expect(withRow.headerHeight - without.headerHeight).toBe(withRow.delegationRowHeight);
			expect(withRow.height - without.height).toBe(withRow.delegationRowHeight);
			expect(without.delegationRowHeight).toBe(0);
		}
		// The late badge rides the badge row: no height of its own.
		const late = measureSubagentCard(
			{ ...base, delegation: { ...delegation, late: "taken_over" as const } },
			600,
			5,
			{},
		);
		expect(late.height).toBe(measureSubagentCard({ ...base, delegation }, 600, 5, {}).height);
	});
});

describe("the late badge", () => {
	it("marks a late result, its reason in the tooltip; in English and Chinese", () => {
		const message = agentMessage(
			{ task: "Fix the refresh race" },
			`${REPORT}\n\n${note("late", "taken_over")}`,
		);
		const en = render(message, { withOpener: true });
		const badge = byId(en, "subagent-late");
		expect(badge?.textContent).toBe("Late");
		expect(badge?.getAttribute("data-reason")).toBe("taken_over");
		expect(badge?.getAttribute("aria-label")).toBe(narratorEn.subagentLateReason.taken_over);
		// The late note names no title: the call's words stay, linked by the note's address.
		expect(byId(en, "subagent-task-link")?.textContent).toBe("Fix the refresh race");

		const zh = render(message, {
			withOpener: true,
			labels: {
				delegatedTask: narratorZh.subagentDelegatedTask.replace("{{title}}", "{title}"),
				lateBadge: narratorZh.subagentLateBadge,
				lateReasons: narratorZh.subagentLateReason,
			},
		});
		expect(byId(zh, "subagent-late")?.textContent).toBe("迟到");
		expect(byId(zh, "subagent-late")?.getAttribute("aria-label")).toBe(
			narratorZh.subagentLateReason.taken_over,
		);
		expect(byId(zh, "subagent-task")?.textContent).toBe("任务：Fix the refresh race");
	});

	it("a note quoted in the report is not the result's note", () => {
		const quoted = `${REPORT}\nThe last run said:\n${note("late", "taken_over")}\nNow fixed.\n\n${note("current")}`;
		const root = render(agentMessage({ task: "Ab3dEf9Q" }, quoted), { withOpener: true });
		expect(byId(root, "subagent-late")).toBeNull();
	});

	it("the title, the address and the reason are keyed in the measure cache", () => {
		const base = { agentType: "general", recentCallCount: 0, isActive: false };
		const delegation = { title: "Fix the refresh race", address: "a/b", late: null };
		const keys = [
			extractDataRevision(base),
			extractDataRevision({ ...base, delegation }),
			extractDataRevision({ ...base, delegation: { ...delegation, late: "taken_over" } }),
			extractDataRevision({ ...base, delegation: { ...delegation, late: "ended" } }),
			extractDataRevision({ ...base, delegation: { ...delegation, title: "Other" } }),
			extractDataRevision({ ...base, delegation: { ...delegation, address: "a/c" } }),
		];
		expect(new Set(keys).size).toBe(keys.length);
	});
});
