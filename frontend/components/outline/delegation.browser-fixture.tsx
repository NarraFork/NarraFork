/**
 * Browser fixture of outline P2 PR 9b (`delegation.browser.test.ts`): the Agent tool card of an
 * agent sent with an outline task (the task row and its link, the late badge) through the real
 * segment → adapter → measure → render chain with the shell's labels, and the session task
 * board's 「新完成」 mark, both against the test server's outline API, in either language and
 * colour scheme, at any width.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { taskBoardKeys } from "../../hooks/useTaskBoard";
import { OutlineOpenerProvider } from "../../lib/outline-opener";
import type { OutlinePanelState } from "../../lib/outline-panel";
import enChat from "../../locales/en/chat.json";
import enCommon from "../../locales/en/common.json";
import enNarrator from "../../locales/en/narrator.json";
import enOutline from "../../locales/en/outline.json";
import zhChat from "../../locales/zh-CN/chat.json";
import zhCommon from "../../locales/zh-CN/common.json";
import zhNarrator from "../../locales/zh-CN/narrator.json";
import zhOutline from "../../locales/zh-CN/outline.json";
import { ImageViewerProvider } from "../common/ImageViewerProvider";
import { segmentMessages } from "../narrator/message/message-segments";
import type { NarratorMsg } from "../narrator/narrator-panel-types";
import { getCategory, getCategoryColor, getSummary } from "../narrator/tool-call/tool-display";
import { VLIST_REGISTRY } from "../narrator/vlist/registry";
import { renderElement, resolveRenderExtra } from "../narrator/vlist/render-registry";
import {
	type AdapterContext,
	type AdapterSegment,
	adaptSegments,
} from "../narrator/vlist/segment-adapter";
import { useVListLabels } from "../narrator/vlist/useVListLabels";
import { SessionTaskBoard } from "./task-board/TaskBoardViews";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	defaultNS: "narrator",
	ns: ["narrator", "chat", "common", "outline"],
	resources: {
		en: { narrator: enNarrator, chat: enChat, common: enCommon, outline: enOutline },
		"zh-CN": { narrator: zhNarrator, chat: zhChat, common: zhCommon, outline: zhOutline },
	},
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

export interface View {
	lang: "en" | "zh-CN";
	scheme: "light" | "dark";
	width: number;
}

let root: Root | null = null;
let queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const opened: OutlinePanelState[] = [];

export function ready(): boolean {
	return true;
}

async function mount(view: View, node: React.ReactNode): Promise<void> {
	await i18n.changeLanguage(view.lang);
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	root?.unmount();
	root = createRoot(document.getElementById("root") as HTMLElement);
	root.render(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme={view.scheme}>
					<ImageViewerProvider>
						<OutlineOpenerProvider
							value={{
								open: (state) => {
									opened.push(state);
									return true;
								},
							}}
						>
							<div
								id="shot"
								style={{
									width: view.width,
									boxSizing: "border-box",
									padding: 12,
									background: "var(--mantine-color-body)",
								}}
							>
								{node}
							</div>
						</OutlineOpenerProvider>
					</ImageViewerProvider>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
}

// ── The Agent tool card ─────────────────────────────────────────────────────

let seq = 0;

function agentCall(input: Record<string, unknown>, text: string): NarratorMsg {
	const id = `a-agent-${seq++}`;
	const outputJson = { _text: text, _metadata: {} };
	return rowWithElements(
		{
			id,
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			toolCalls: [
				{
					toolUseId: `tu-${id}`,
					toolName: "Agent",
					inputJson: input,
					outputJson,
					status: "completed",
				},
			],
			createdAt: `2026-11-06T09:${String(10 + seq).padStart(2, "0")}:00.000Z`,
		},
		[
			{
				type: "tool_use",
				id: `tu-${id}`,
				name: "Agent",
				input,
				inputJson: input,
				outputJson,
				status: "completed",
			},
		],
	) as unknown as NarratorMsg;
}

function note(task: string, status: "current" | "late", reason?: string): string {
	return [
		`<outline_report task="${task}" report="${task.split("/")[0]}/Rp1Rp1Rp" generation="1" status="${status}"${reason ? ` reason="${reason}"` : ""}>`,
		status === "current"
			? `The report is attached under the task [[${task}|Fix the refresh race in the token cache]] as [[${task.split("/")[0]}/Rp1Rp1Rp|Report (generation 1)]] (4 blocks).`
			: "Late result: since this agent was sent, the task was taken over by someone (claim generation 2). The report is attached under the task as [[x/y|Late report]] (4 blocks), marked late.",
		"</outline_report>",
	].join("\n");
}

function Cards({ task, view }: { task: string; view: View }) {
	const { adapterLabels, renderLabels } = useVListLabels();
	const ctx: AdapterContext = {
		lod: 5,
		labels: adapterLabels,
		resolveToolCategory: getCategory,
		resolveToolColor: (n: string, i?: unknown) => getCategoryColor(getCategory(n, i)),
		resolveToolSummary: (tc) => {
			const call = tc as { toolName: string; inputJson?: unknown };
			return getSummary(call.toolName, call.inputJson, {}, adapterLabels);
		},
		isExpanded: () => false,
	};
	seq = 0;
	const report =
		"## Findings\nThe race is in refresh(): it reuses the token it read before the lock.";
	const messages = [
		agentCall(
			{ task, description: "Fix the refresh race", prompt: "Look at auth.ts first." },
			`${report}\n\n${note(task, "current")}`,
		),
		agentCall(
			{ task: "Fix the refresh race in the token cache", description: "Fix the refresh race" },
			`${report}\n\n${note(task, "late", "taken_over")}`,
		),
	];
	const specs = adaptSegments(segmentMessages(messages) as unknown as AdapterSegment[], ctx);
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
			{specs.map((spec) => {
				const entry = VLIST_REGISTRY[spec.kind];
				const width = view.width - 24;
				const measured = entry.measure(spec.data as never, width, 5, spec.opts as never);
				const extra = resolveRenderExtra(spec) as Record<string, unknown>;
				extra.narratorId = "n1";
				extra.onToggle = () => {};
				if (spec.kind === "subagent-card") extra.labels = renderLabels.subagent;
				return (
					<div
						key={spec.key}
						data-card=""
						data-kind={spec.kind}
						data-measured={measured.height}
						style={{ position: "relative", height: measured.height, width }}
					>
						{renderElement(spec.kind, measured, extra as never)}
					</div>
				);
			})}
		</div>
	);
}

/** Two Agent cards sent with the task at `task` (`key/sid`): a current result and a late one. */
export async function renderCards(task: string, view: View): Promise<void> {
	opened.length = 0;
	await mount(view, <Cards task={task} view={view} />);
}

/** Each card: its measured and painted heights, its task row, link and late badge. */
export function cards() {
	return [...document.querySelectorAll<HTMLElement>("[data-card]")].map((card) => {
		const paper = card.firstElementChild as HTMLElement | null;
		const row = card.querySelector<HTMLElement>("[data-testid=subagent-task]");
		const late = card.querySelector<HTMLElement>("[data-testid=subagent-late]");
		return {
			kind: card.dataset.kind ?? "",
			measured: Number(card.dataset.measured),
			painted: paper ? Math.round(paper.getBoundingClientRect().height * 10) / 10 : 0,
			row: row?.textContent ?? null,
			rowFits: row ? row.scrollHeight <= row.clientHeight + 1 : null,
			link:
				card.querySelector<HTMLAnchorElement>("[data-testid=subagent-task-link]")?.textContent ??
				null,
			late: late?.textContent ?? null,
			lateReason: late?.getAttribute("aria-label") ?? null,
		};
	});
}

/** Click the task link of the card at `index`. */
export function clickTaskLink(index: number): boolean {
	const card = document.querySelectorAll<HTMLElement>("[data-card]")[index];
	const link = card?.querySelector<HTMLAnchorElement>("[data-testid=subagent-task-link]");
	if (!link) return false;
	link.click();
	return true;
}

/** What the links asked the host to open. */
export function openedPlaces(): Array<{ spaceId?: string; blockId?: string }> {
	return opened.map((state) => ({ spaceId: state.spaceId, blockId: state.blockId }));
}

// ── The task board ──────────────────────────────────────────────────────────

/** Mount a session's board. */
export async function openBoard(narratorId: string, view: View): Promise<void> {
	await mount(view, <SessionTaskBoard narratorId={narratorId} />);
}

/** Read the board again (its query), as a later change or a refresh would. */
export async function refetchBoard(): Promise<void> {
	await queryClient.invalidateQueries({ queryKey: taskBoardKeys.all });
}

/** The board's rows: title and whether it is marked 「新完成」, with the mark's text. */
export function boardRows() {
	return [...document.querySelectorAll<HTMLElement>("[data-testid=task-row]")].map((row) => ({
		title: row.dataset.title ?? "",
		newlyDone: row.dataset.newlyDone === "true",
		mark: row.querySelector("[data-testid=task-badge-newly-done]")?.textContent ?? null,
	}));
}

/** Whether the page scrolls sideways (it must not, at phone width). */
export function horizontalOverflow(): number {
	const doc = document.documentElement;
	const shot = document.getElementById("shot");
	return Math.max(
		doc.scrollWidth - doc.clientWidth,
		shot ? shot.scrollWidth - shot.clientWidth : 0,
	);
}
