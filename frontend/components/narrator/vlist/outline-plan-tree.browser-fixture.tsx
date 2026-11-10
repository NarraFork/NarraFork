/**
 * Browser fixture for an outline plan's ExitPlanMode card (`outline-plan-tree.browser.test.ts`,
 * plan readability): a realistic plan in the owner's format (`outline-plan-tree.browser-plans`,
 * in the reader's language) and the plan of the owner's first screenshot, written before the
 * format, through the real segment → adapter → measure → render chain with the shell's labels
 * (the preview's measured labels among them), and the reader's view held in the list's own
 * interaction state (`applyVListPlanTreeAction`), so a click re-adapts and re-measures the card
 * exactly as the session list does. With `approval`, the plan waits for a decision: the card
 * hosts the real approval form (`OutlinePlanApproval`, mounted by the vlist's permission bridge),
 * its height first predicted and then reported by the form.
 *
 * `scene: "inbox"` draws the same plan with the inbox's DOM tree (`OutlinePlanTree`), and
 * `scene: "before"` the old card (a plan-file style markdown body, everything expanded): only
 * for the screenshots.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { serializeMarkdownOutline } from "@shared/outline";
import { parsePlanTree } from "@shared/outline-plan-tree";
import { setTypography } from "@shared/pretext-layout/typography";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { OutlineOpenerProvider } from "../../../lib/outline-opener";
import { ensureTypographyCssVars } from "../../../lib/typography-css-vars";
import enChat from "../../../locales/en/chat.json";
import enCommon from "../../../locales/en/common.json";
import enNarrator from "../../../locales/en/narrator.json";
import enOutline from "../../../locales/en/outline.json";
import zhChat from "../../../locales/zh-CN/chat.json";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import zhOutline from "../../../locales/zh-CN/outline.json";
import type { PendingPermission } from "../../../types/narrator";
import { ImageViewerProvider } from "../../common/ImageViewerProvider";
import { OutlinePlanTree } from "../../outline/plan/OutlinePlanTree";
import type { NarratorComposerHandle } from "../composer/NarratorComposer";
import { usePermissionFocusNav } from "../interaction/use-permission-focus-nav";
import { segmentMessages } from "../message/message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { PermEnterHintCtx } from "../tool-call/tool-call-contexts";
import { getCategory, getCategoryColor, getSummary } from "../tool-call/tool-display";
import { toolCardInnerWidth } from "./measure/measure-tool-call";
import { FORMAT_EN, FORMAT_ZH, LEGACY } from "./outline-plan-tree.browser-plans";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "./segment-adapter";
import { useVListLabels } from "./useVListLabels";
import {
	applyVListPlanTreeAction,
	createVListInteractionState,
	resolvePlanTreeViewRow,
} from "./vlist-interaction-state";
import { buildPermissionNode } from "./vlist-permission-bridge";
import { predictInlinePermission } from "./vlist-permission-prediction";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
	lng: "zh-CN",
	fallbackLng: "zh-CN",
	defaultNS: "narrator",
	ns: ["narrator", "chat", "common", "outline"],
	resources: {
		"zh-CN": { narrator: zhNarrator, chat: zhChat, common: zhCommon, outline: zhOutline },
		en: { narrator: enNarrator, chat: enChat, common: enCommon, outline: enOutline },
	},
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

export function ready(): boolean {
	return true;
}

// ── The plans ──

export const PLANS = {
	formatZh: serializeMarkdownOutline([FORMAT_ZH]),
	formatEn: serializeMarkdownOutline([FORMAT_EN]),
	legacy: serializeMarkdownOutline([LEGACY]),
};

export interface FixtureOptions {
	/**
	 * `format` (the owner's format, in `lang`) / `legacy`: the card as it is now; `inbox`: the
	 * format plan in the inbox's DOM tree; `before`: the old markdown body.
	 */
	scene: "format" | "legacy" | "inbox" | "inbox-legacy" | "before";
	lang?: "zh-CN" | "en";
	width: number;
	scheme: "light" | "dark";
	/** The plan waits for a decision: the card hosts the approval form. */
	approval?: boolean;
	/**
	 * The session panel's keyboard navigation (`usePermissionFocusNav`) listens on the window, as
	 * in the app: for the approval scene, over the plan's own approval form; for the inbox, over
	 * a stand-in for the panel's waiting permission (its one action counted as a decision).
	 */
	keyboard?: boolean;
	viewportHeight?: number;
	fontScalePercent?: number;
	lineHeightScalePercent?: number;
}

const TOOL_USE = "toolu_plan_readability";

function planText(options: FixtureOptions): string {
	if (options.scene === "legacy" || options.scene === "before" || options.scene === "inbox-legacy")
		return PLANS.legacy;
	return options.lang === "en" ? PLANS.formatEn : PLANS.formatZh;
}

function planInput(options: FixtureOptions) {
	const plan = planText(options);
	if (options.scene === "before") return { plan };
	return {
		mode: "outline",
		plan,
		_planRoot: {
			blockId: "root-block",
			spaceId: "space",
			pageId: "page",
			address: "MTBXwl1Y/u90Ia1yR",
			title: "历史读取10秒改告警",
			round: 1,
		},
		_planSeq: 12,
		_planBaseSeq: 0,
		_planDiff: { counts: { added: 31, removed: 0, text: 0, task: 0, moved: 0 } },
	};
}

function messages(options: FixtureOptions): NarratorMsg[] {
	const input = planInput(options);
	const status = options.approval ? "pending" : "completed";
	const outputJson = options.approval ? null : { _text: "User has approved your plan." };
	return [
		rowWithElements(
			{
				id: "a-plan",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant",
				contentText: null,
				toolCalls: [
					{ toolUseId: TOOL_USE, toolName: "ExitPlanMode", inputJson: input, outputJson, status },
				],
				createdAt: "2026-11-07T09:10:00.000Z",
			},
			[
				{
					type: "tool_use",
					id: TOOL_USE,
					name: "ExitPlanMode",
					input,
					inputJson: input,
					outputJson,
					status,
				},
			],
		) as unknown as NarratorMsg,
	];
}

function permissionOf(options: FixtureOptions): PendingPermission {
	return {
		id: "plan-request",
		toolName: "ExitPlanMode",
		toolUseId: TOOL_USE,
		ownerNarratorId: "n1",
		inputJson: planInput(options),
	} as unknown as PendingPermission;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
queryClient.setQueryData(["settings"], { outline: { enabled: true } });
let root: Root | null = null;
/** Commits of the scene (a click is answered once this moves and the frame is painted). */
let commits = 0;

// ── Decisions: what Enter would have run instead of the control under the focus ──

const decisions: string[] = [];
const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	if (method === "POST" && /\/permissions\/[^/]+\/plan\b/.test(url)) decisions.push(url);
	return realFetch(input, init);
}) as typeof window.fetch;

/** Decisions sent (the approval form's POST, or the inbox stand-in's action). */
export function decisionCount(): number {
	return decisions.length;
}

/** The panel's keyboard navigation of a waiting request, as `NarratorPanel` hosts it. */
function KeyboardHost({ permissionId, children }: { permissionId: string; children: ReactNode }) {
	const composerRef = useRef<NarratorComposerHandle | null>(null);
	const { permEnterHintCtxValue } = usePermissionFocusNav({
		pendingPermissionId: permissionId,
		pendingPermissionToolName: "ExitPlanMode",
		composerSendable: false,
		composerRef,
	});
	return (
		<PermEnterHintCtx.Provider value={permEnterHintCtxValue}>{children}</PermEnterHintCtx.Provider>
	);
}

/** A stand-in for the session panel's own waiting permission: one action, counted. */
function PanelPermission() {
	const { setButtonCount, registerActions } = useContext(PermEnterHintCtx);
	useLayoutEffect(() => {
		setButtonCount(1);
		registerActions([() => decisions.push("panel")]);
	}, [setButtonCount, registerActions]);
	return null;
}

/** The inbox's DOM tree of the same plan (its view is the component's own state). */
function InboxScene({ options }: { options: FixtureOptions }) {
	const tree = parsePlanTree(planText(options));
	const host = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		commits++;
	});
	// The tree re-renders on its own (local state): a change to its DOM is a commit here.
	useLayoutEffect(() => {
		const el = host.current;
		if (!el) return;
		const observer = new MutationObserver(() => {
			commits++;
		});
		observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
		return () => observer.disconnect();
	}, []);
	return (
		<div
			ref={host}
			id="shot"
			data-inbox=""
			style={{
				width: options.width,
				boxSizing: "content-box",
				padding: 16,
				background: "var(--mantine-color-body)",
			}}
		>
			{tree ? <OutlinePlanTree tree={tree} /> : null}
			{options.keyboard ? (
				<KeyboardHost permissionId="panel-request">
					<PanelPermission />
				</KeyboardHost>
			) : null}
		</div>
	);
}

function Scene({ options }: { options: FixtureOptions }) {
	const { adapterLabels, renderLabels } = useVListLabels();
	const [interaction, setInteraction] = useState(() => createVListInteractionState(5));
	const [formHeight, setFormHeight] = useState<number | undefined>(undefined);
	const permission = options.approval ? permissionOf(options) : null;
	const prediction = useMemo(() => {
		if (!permission) return undefined;
		return predictInlinePermission(permission as never, {
			innerWidth: toolCardInnerWidth(options.width, false),
			canDecide: true,
			planButtonLabels: [
				i18n.t("outlinePlan.draft"),
				i18n.t("outlinePlan.lock"),
				i18n.t("outlinePlan.return"),
			],
			planFeedbackPlaceholder: i18n.t("outlinePlan.feedbackPlaceholder"),
		});
	}, [permission, options.width]);
	const ctx: AdapterContext = {
		lod: 5,
		labels: adapterLabels,
		viewportHeight: options.viewportHeight ?? 900,
		resolveToolCategory: getCategory,
		resolveToolColor: (n: string, i?: unknown) => getCategoryColor(getCategory(n, i)),
		resolveToolSummary: (tc) => {
			const call = tc as { toolName: string; inputJson?: unknown; outputJson?: unknown };
			const meta = (call.outputJson as { _metadata?: Record<string, unknown> } | undefined)
				?._metadata;
			return getSummary(call.toolName, call.inputJson, meta, adapterLabels);
		},
		planTreeView: (key) => resolvePlanTreeViewRow(interaction, key),
		...(permission
			? {
					resolveHasPendingPermission: (id?: string) => id === TOOL_USE,
					resolvePermissionFormPrediction: (id?: string) =>
						id === TOOL_USE ? prediction : undefined,
					resolvePermissionFormHeight: (id?: string) => (id === TOOL_USE ? formHeight : undefined),
				}
			: {}),
	};
	const specs = adaptSegments(
		segmentMessages(messages(options)) as unknown as AdapterSegment[],
		ctx,
	);
	useLayoutEffect(() => {
		commits++;
	});
	const cards = (
		<div
			id="shot"
			style={{
				width: options.width,
				boxSizing: "content-box",
				padding: 16,
				background: "var(--mantine-color-body)",
			}}
		>
			{specs.map((spec) => {
				const entry = VLIST_REGISTRY[spec.kind];
				if (!entry) return <div key={spec.key}>?? {spec.kind}</div>;
				const measured = entry.measure(spec.data as never, options.width, 5, spec.opts as never);
				const extra = resolveRenderExtra(spec) as Record<string, unknown>;
				extra.narratorId = "n1";
				extra.onToggle = () => {};
				extra.onTogglePrompt = () => {};
				extra.onPlanTree = (action: never) =>
					setInteraction((prev) => applyVListPlanTreeAction(prev, spec.key, action));
				if (spec.kind === "tool-call") {
					extra.labels = renderLabels.toolCall;
					if (permission) {
						extra.permissionSlot = buildPermissionNode(permission, {});
						extra.onPermissionFormHeight = (height: number) => setFormHeight(height);
					}
				}
				return (
					<div
						key={spec.key}
						data-card=""
						data-kind={spec.kind}
						data-measured={measured.height}
						style={{ position: "relative", height: measured.height, width: options.width }}
					>
						{renderElement(spec.kind, measured, extra as never)}
					</div>
				);
			})}
		</div>
	);
	return options.keyboard && permission ? (
		<KeyboardHost permissionId={permission.id}>{cards}</KeyboardHost>
	) : (
		cards
	);
}

/** Render a scene; resolves once it is committed and painted. */
export async function render(options: FixtureOptions): Promise<void> {
	ensureTypographyCssVars();
	await i18n.changeLanguage(options.lang ?? "zh-CN");
	setTypography({
		fontScalePercent: options.fontScalePercent ?? 100,
		lineHeightScalePercent: options.lineHeightScalePercent ?? 100,
	});
	const host = document.getElementById("root") as HTMLElement;
	root?.unmount();
	root = createRoot(host);
	const before = commits;
	root.render(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme={options.scheme}>
					<ImageViewerProvider>
						<OutlineOpenerProvider value={{ open: () => true }}>
							{options.scene === "inbox" || options.scene === "inbox-legacy" ? (
								<InboxScene options={options} />
							) : (
								<Scene options={options} />
							)}
						</OutlineOpenerProvider>
					</ImageViewerProvider>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
	await settled(before);
}

/** Wait for a commit after `before`, then for its frame to be painted. */
async function settled(before: number): Promise<void> {
	while (commits === before) await new Promise((resolve) => requestAnimationFrame(resolve));
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/** Commits so far (the test waits for it to move after a click). */
export function commitCount(): number {
	return commits;
}

/** The element `selector` matches inside the plan's card (or the inbox's tree). */
function find(selector: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-card] ${selector}, [data-inbox] ${selector}`);
}

/**
 * Click the element `selector` matches (Alt held with `alt`, as Alt+click); resolves once
 * re-rendered.
 */
export async function click(selector: string, alt = false): Promise<boolean> {
	const el = find(selector);
	if (!el) return false;
	const before = commits;
	el.dispatchEvent(
		new MouseEvent("click", { bubbles: true, cancelable: true, altKey: alt, view: window }),
	);
	await settled(before);
	return true;
}

/** Focus the element `selector` matches (the test then types with the real keyboard). */
export function focus(selector: string): boolean {
	const el = find(selector);
	el?.focus();
	return !!el && document.activeElement === el;
}

/** Resolves once a commit after `before` is painted. */
export async function afterCommit(before: number): Promise<void> {
	await settled(before);
}

/** Wait until the card's measured height has stopped moving (a reported form height). */
export async function steady(): Promise<void> {
	let last = "";
	for (let frame = 0; frame < 30; frame++) {
		const now = [...document.querySelectorAll<HTMLElement>("[data-card]")]
			.map(
				(card) =>
					`${card.dataset.measured}:${card.firstElementChild?.getBoundingClientRect().height}`,
			)
			.join("|");
		if (now === last) return;
		last = now;
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	}
}

export interface PlanRowReport {
	key: string;
	depth: number;
	role: string;
	/** "1" open, "0" closed, undefined: no children. */
	open?: string;
	/** It has a fold arrow / a checkbox or bullet. */
	arrow: boolean;
	marker: boolean;
	/** Its quick control's state (`expand` / `collapse`), null when it has none. */
	subtree: string | null;
	/** Its text ends in an ellipsis (clamped). */
	ellipsis: boolean;
	text: string;
	/** The preview line under it: its text, its label, whether it ends in an ellipsis. */
	preview: { text: string; label: string | null; ellipsis: boolean } | null;
	/** The row's painted height and what its lines take. */
	height: number;
	lines: number;
	/** Its text is a control (it is longer than its clamp). */
	textToggles: boolean;
}

/** Where the focus is: the plan row it is in and which of its controls. */
export function focused(): { row: string | null; control: string | null } {
	const el = document.activeElement as HTMLElement | null;
	const row = el?.closest<HTMLElement>("[data-plan-row]") ?? null;
	const control = !el
		? null
		: el.matches("[data-plan-toggle]")
			? "toggle"
			: el.matches("[data-plan-subtree]")
				? `subtree:${el.dataset.planSubtree}`
				: el.matches("[data-plan-preview]")
					? "preview"
					: el.matches("[data-plan-text]")
						? "text"
						: el === document.body
							? "body"
							: el.tagName.toLowerCase();
	return { row: row?.dataset.planRow ?? null, control };
}

export interface CardReport {
	measured: number;
	painted: number;
	/** How far anything reaches past the card's content box (px). */
	spill: number;
	toolbar: string | null;
	allLabel: string | null;
	rows: PlanRowReport[];
	box: { height: number; scrollHeight: number; clientHeight: number } | null;
	approval: boolean;
	overflowX: boolean;
	/** A plan row whose text paints past its own box (px). */
	rowSpill: number;
	/** How far the toolbar line's words reach into the rows' box below it (px). */
	toolbarOverlap: number;
	/** How far a preview line's words reach past its row (below it, or past the box's right). */
	previewSpill: number;
	markdownBlocks: number;
}

function rowReport(row: HTMLElement): PlanRowReport {
	const rect = row.getBoundingClientRect();
	const text =
		row.querySelector<HTMLElement>("[data-plan-text]") ??
		(row.matches("[data-plan-text]") ? row : null);
	const preview =
		row.querySelector<HTMLElement>("[data-plan-preview]") ??
		(row.nextElementSibling?.matches("[data-plan-preview]")
			? (row.nextElementSibling as HTMLElement)
			: null);
	return {
		key: row.dataset.planRow ?? "",
		depth: Number(row.dataset.planDepth),
		role: row.dataset.planRole ?? "",
		open: row.dataset.planOpen,
		arrow: !!row.querySelector("[data-plan-toggle]"),
		marker: !!row.querySelector(".vlist-plan-marker"),
		subtree: row.querySelector<HTMLElement>("[data-plan-subtree]")?.dataset.planSubtree ?? null,
		ellipsis: !!text?.querySelector("[data-plan-ellipsis]"),
		text: text?.textContent ?? "",
		preview: preview
			? {
					text: preview.querySelector("[data-plan-preview-text]")?.textContent ?? "",
					label: preview.querySelector("[data-plan-preview-label]")?.textContent ?? null,
					ellipsis:
						!!preview.querySelector(":scope > [data-plan-ellipsis]") ||
						(preview.querySelector("[data-plan-preview-text]")?.textContent ?? "").endsWith("…"),
				}
			: null,
		height: Math.round(rect.height * 10) / 10,
		lines: text ? text.children.length : 0,
		textToggles: text?.getAttribute("role") === "button",
	};
}

export interface InboxReport {
	rows: PlanRowReport[];
	toolbar: string | null;
	allLabel: string | null;
	overflowX: boolean;
	/** How far a preview's words reach past the tree's right edge (px). */
	previewSpill: number;
}

/** The inbox's tree as drawn. */
export function inboxReport(): InboxReport {
	const tree = document.querySelector<HTMLElement>("[data-inbox] [data-testid=outline-plan-tree]");
	if (!tree) throw new Error("no inbox tree");
	const right = tree.getBoundingClientRect().right;
	let previewSpill = 0;
	// The preview's text and label boxes (the runs inside the text are clipped by it).
	for (const el of tree.querySelectorAll<HTMLElement>("[data-plan-preview] > *")) {
		const r = el.getBoundingClientRect();
		if (r.width > 0) previewSpill = Math.max(previewSpill, r.right - right);
	}
	const summary = tree.firstElementChild;
	return {
		rows: [...tree.querySelectorAll<HTMLElement>("[data-plan-row]")].map(rowReport),
		toolbar: summary?.querySelector("p")?.textContent ?? null,
		allLabel: tree.querySelector("[data-testid=outline-plan-tree-all]")?.textContent ?? null,
		overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
		previewSpill: Math.round(previewSpill * 10) / 10,
	};
}

export function report(): CardReport {
	const card = document.querySelector<HTMLElement>("[data-card][data-kind=tool-call]");
	if (!card) throw new Error("no plan card");
	const paper = card.firstElementChild as HTMLElement;
	const box = paper.getBoundingClientRect();
	const style = getComputedStyle(paper);
	const top =
		box.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
	const bottom =
		box.bottom -
		Number.parseFloat(style.borderBottomWidth) -
		Number.parseFloat(style.paddingBottom);
	let spill = 0;
	for (const child of paper.querySelectorAll<HTMLElement>("*")) {
		const r = child.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		let visibleTop = r.top;
		let visibleBottom = r.bottom;
		for (let up = child.parentElement; up && up !== paper; up = up.parentElement) {
			if (getComputedStyle(up).overflowY === "visible") continue;
			const clip = up.getBoundingClientRect();
			visibleTop = Math.max(visibleTop, clip.top);
			visibleBottom = Math.min(visibleBottom, clip.bottom);
		}
		if (visibleBottom <= visibleTop) continue;
		spill = Math.max(spill, top - visibleTop, visibleBottom - bottom);
	}
	let rowSpill = 0;
	let previewSpill = 0;
	const boxRight = card
		.querySelector<HTMLElement>("[data-plan-box]")
		?.getBoundingClientRect().right;
	const rowEls = [...card.querySelectorAll<HTMLElement>("[data-plan-row]")];
	for (const row of rowEls) {
		const rect = row.getBoundingClientRect();
		for (const frag of row.querySelectorAll<HTMLElement>("[data-plan-text] *")) {
			const r = frag.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			rowSpill = Math.max(rowSpill, r.bottom - rect.bottom, rect.top - r.top);
		}
		for (const el of row.querySelectorAll<HTMLElement>("[data-plan-preview] *")) {
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			previewSpill = Math.max(previewSpill, r.bottom - rect.bottom);
			if (boxRight !== undefined) previewSpill = Math.max(previewSpill, r.right - boxRight);
		}
	}
	const rows = rowEls.map(rowReport);
	const planBoxOuter = card.querySelector<HTMLElement>("[data-plan-box]");
	// The box scrolls in its scrollport (the list's overlay scrollbars), when it has one.
	const planBox =
		planBoxOuter?.querySelector<HTMLElement>("[data-content-scrollport]") ?? planBoxOuter;
	let toolbarOverlap = 0;
	const boxTop = planBox?.getBoundingClientRect().top;
	for (const word of card.querySelectorAll<HTMLElement>("[data-plan-summary], [data-plan-all]")) {
		if (boxTop === undefined) break;
		toolbarOverlap = Math.max(toolbarOverlap, word.getBoundingClientRect().bottom - boxTop);
	}
	return {
		measured: Number(card.dataset.measured),
		painted: Math.round(paper.getBoundingClientRect().height * 10) / 10,
		spill: Math.round(spill * 10) / 10,
		toolbar: card.querySelector("[data-plan-summary]")?.textContent ?? null,
		allLabel: card.querySelector("[data-plan-all]")?.textContent ?? null,
		rows,
		box: planBox
			? {
					height: Math.round(planBox.getBoundingClientRect().height * 10) / 10,
					scrollHeight: planBox.scrollHeight,
					clientHeight: planBox.clientHeight,
				}
			: null,
		approval: !!card.querySelector("[data-testid=outline-plan-approval]"),
		overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
		rowSpill: Math.round(rowSpill * 10) / 10,
		toolbarOverlap: Math.round(toolbarOverlap * 10) / 10,
		previewSpill: Math.round(previewSpill * 10) / 10,
		markdownBlocks: card.querySelectorAll("[data-tool-markdown]").length,
	};
}
