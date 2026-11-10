/**
 * Browser fixture of an outline plan's approval (outline P2 PR 8): the real `InlinePermission`
 * form for a waiting ExitPlanMode of an outline session, which renders `OutlinePlanApproval`,
 * against the test server's outline API, its decision route and the page's change hints over the
 * app's own narrator socket (`outline-plan-approval.browser.test.ts`). With `keyboard`, the panel's
 * keyboard navigation (`usePermissionFocusNav`) hosts it, as in a session's panel. `measureCard`
 * paints a card at a width and type size, mounted by the vlist's own bridge (`buildPermissionNode`),
 * and reads it against the vlist's prediction.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { typographyMetrics } from "@shared/pretext-layout/pretext-fonts";
import { setTypography } from "@shared/pretext-layout/typography";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { type ReactNode, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { mantineTheme } from "../../../lib/mantine-theme";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import { ensureTypographyCssVars } from "../../../lib/typography-css-vars";
import commonEn from "../../../locales/en/common.json";
import narratorEn from "../../../locales/en/narrator.json";
import outlineEn from "../../../locales/en/outline.json";
import commonZh from "../../../locales/zh-CN/common.json";
import narratorZh from "../../../locales/zh-CN/narrator.json";
import outlineZh from "../../../locales/zh-CN/outline.json";
import type { PendingPermission } from "../../../types/narrator";
import type { NarratorComposerHandle } from "../../narrator/composer/NarratorComposer";
import { usePermissionFocusNav } from "../../narrator/interaction/use-permission-focus-nav";
import { InlinePermission } from "../../narrator/permission/InlinePermission";
import { PermEnterHintCtx } from "../../narrator/tool-call/tool-call-contexts";
import { measureInlinePermission } from "../../narrator/vlist/measure/measure-permission";
import { buildPermissionNode } from "../../narrator/vlist/vlist-permission-bridge";
import { predictInlinePermission } from "../../narrator/vlist/vlist-permission-prediction";

const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	resources: {
		en: { narrator: narratorEn, common: commonEn, outline: outlineEn },
		"zh-CN": { narrator: narratorZh, common: commonZh, outline: outlineZh },
	},
	react: { useSuspense: false },
});

export function ready(): boolean {
	return true;
}

/**
 * The panel's keyboard navigation of the waiting request (no composer text), and a stand-in for
 * the composer: an empty textarea whose Enter it hands over as the real one does (its own
 * handler prevents the newline; the panel's shortcut then decides).
 */
function KeyboardHost({
	permission,
	children,
}: {
	permission: PendingPermission;
	children: ReactNode;
}) {
	const textarea = useRef<HTMLTextAreaElement | null>(null);
	const composerRef = useRef<NarratorComposerHandle | null>({
		ownsTextarea: (el: unknown) => el === textarea.current,
		isTextEmpty: () => !textarea.current?.value,
	} as unknown as NarratorComposerHandle);
	const { permEnterHintCtxValue } = usePermissionFocusNav({
		pendingPermissionId: permission.id,
		pendingPermissionToolName: permission.toolName,
		composerSendable: false,
		composerRef,
	});
	return (
		<PermEnterHintCtx.Provider value={permEnterHintCtxValue}>
			{children}
			<textarea
				ref={textarea}
				data-testid="composer"
				aria-label="composer"
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey && !e.currentTarget.value) e.preventDefault();
				}}
			/>
		</PermEnterHintCtx.Provider>
	);
}

/** What the plain permission form decided (`decision:feedback`), in order. */
const decided: string[] = [];

export function decisions(): string[] {
	return [...decided];
}

/** The focused element's text (a button's label without the ⏎ hint), or null for the page. */
export function focusedLabel(): string | null {
	const el = document.activeElement as HTMLElement | null;
	if (!el || el === document.body) return null;
	return el.textContent?.replace("⏎", "").trim() ?? "";
}

/** Mount the approval form of one waiting plan (under the panel's keyboard navigation). */
export function open(permission: PendingPermission, options: { keyboard?: boolean } = {}): void {
	// The diff's page subscription rides the narrator socket, as in the app.
	narratorWSManager.connect();
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(["settings"], { outline: { enabled: true } });
	const root = document.getElementById("root") as HTMLElement;
	createRoot(root).render(
		<I18nextProvider i18n={instance}>
			<MantineProvider>
				<QueryClientProvider client={queryClient}>
					<div style={{ maxWidth: 720, padding: 16, boxSizing: "border-box" }}>
						{options.keyboard ? (
							<KeyboardHost permission={permission}>
								<InlinePermission permission={permission} onDecision={record} />
							</KeyboardHost>
						) : (
							<InlinePermission permission={permission} onDecision={record} />
						)}
					</div>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
}

function record(_id: string, decision: "allow" | "deny", feedback?: string): void {
	decided.push(`${decision}:${feedback ?? ""}`);
}

export function socketConnected(): boolean {
	return narratorWSManager.connected;
}

const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;

export function text(selector: string): string | null {
	return q(selector)?.textContent ?? null;
}

export function count(selector: string): number {
	return document.querySelectorAll(selector).length;
}

/** Click the first button whose text is `label` (inside `within` when given). */
export function clickButton(label: string, within?: string): boolean {
	const scope = within ? q(within) : document.body;
	const button = [...(scope?.querySelectorAll("button") ?? [])].find(
		(b) => b.textContent?.trim() === label,
	);
	button?.click();
	return !!button;
}

export function click(selector: string): boolean {
	const el = q(selector);
	el?.click();
	return !!el;
}

/** Type into a textarea or input the React way. */
export function type(selector: string, value: string): void {
	const el = q(selector) as HTMLTextAreaElement | HTMLInputElement | null;
	if (!el) throw new Error(`no ${selector}`);
	const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
	Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The label of the button Enter would press (the one carrying the "⏎" hint). */
export function enterTarget(): string | null {
	const button = [...document.querySelectorAll("button")].find((b) =>
		b.textContent?.trim().endsWith("⏎"),
	);
	return button?.textContent?.replace("⏎", "").trim() ?? null;
}

/** Take the focus out of any field (Enter then reaches the panel's keyboard navigation). */
export function blur(): void {
	(document.activeElement as HTMLElement | null)?.blur();
}

/** How many lines the element paints (its height over its line height). */
export function lines(selector: string): number {
	const el = q(selector);
	if (!el) return 0;
	return Math.round(
		el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight),
	);
}

/** The texts of every element `selector` matches, in order. */
export function texts(selector: string): string[] {
	return [...document.querySelectorAll(selector)].map((e) => e.textContent ?? "");
}

/** The texts of the diff's entries, in order. */
export function entries(): string[] {
	return [...document.querySelectorAll("[data-testid=outline-plan-diff-entry]")].map(
		(e) => e.textContent ?? "",
	);
}

/** The option labels of the open combobox. */
export function options(): string[] {
	return [...document.querySelectorAll("[role=option]")].map((o) => o.textContent ?? "");
}

export function chooseOption(label: string): boolean {
	const option = [...document.querySelectorAll("[role=option]")].find(
		(o) => o.textContent === label,
	) as HTMLElement | undefined;
	option?.click();
	return !!option;
}

/** Whether the page scrolls sideways (it must not, at any width). */
export function overflowsX(): boolean {
	return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
}

let measureRoot: Root | null = null;

/** A waiting outline plan's request as the vlist sees it (version 2, a few changes). */
function samplePermission(review: number): PendingPermission {
	return {
		id: "measure-request",
		toolName: "ExitPlanMode",
		toolUseId: "toolu_measure",
		ownerNarratorId: "n-measure",
		inputJson: {
			mode: "outline",
			plan: "- [ ] Plan",
			_planRoot: {
				blockId: "b",
				spaceId: "s",
				pageId: "p",
				address: "k/AbCdEfGh",
				title: "Plan",
				round: 2,
			},
			_planSeq: 10,
			_planBaseSeq: 5,
			_planDiff: { counts: { added: 3, removed: 1, text: 2, task: 1, moved: 0 } },
			...(review > 0
				? {
						_planReview: {
							blockId: "rv",
							address: "k/RvRvRvRv",
							round: 2,
							count: review,
							submittedSeq: 10,
							comments: Array.from({ length: review }, (_, i) => ({
								text: `Concern ${i}`,
								target: null,
							})),
						},
					}
				: {}),
		},
	} as unknown as PendingPermission;
}

/**
 * Paint one card at `width` in `lng` and type size `font`/`line` (percent), and read each region
 * against the vlist's prediction: the summary line, the feedback box's rows, the button rows.
 */
export async function measureCard(
	lng: string,
	width: number,
	font: number,
	line: number,
	review: number,
) {
	ensureTypographyCssVars();
	await instance.changeLanguage(lng);
	setTypography({ fontScalePercent: font, lineHeightScalePercent: line });
	let host = document.getElementById("measure-host");
	if (!host) {
		host = document.createElement("div");
		host.id = "measure-host";
		document.body.appendChild(host);
	}
	measureRoot?.unmount();
	measureRoot = createRoot(host);
	const permission = samplePermission(review);
	const root = measureRoot;
	flushSync(() =>
		root.render(
			<I18nextProvider i18n={instance}>
				<MantineProvider theme={mantineTheme}>
					<QueryClientProvider client={new QueryClient()}>
						<div className="nf-type-scope" style={{ width, boxSizing: "border-box" }}>
							<PermEnterHintCtx.Provider
								value={{
									focusIndex: 0,
									setFocusIndex: () => {},
									setButtonCount: () => {},
									setHasFeedback: () => {},
									registerActions: () => {},
									activePermissionId: "measure-request",
								}}
							>
								{buildPermissionNode(permission, {})}
							</PermEnterHintCtx.Provider>
						</div>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		),
	);
	// The summary line's form follows its width, observed after the first paint (a resize
	// observer, then a state update): a few frames.
	for (let frame = 0; frame < 6; frame++)
		await new Promise((resolve) => requestAnimationFrame(resolve));
	const card = host.querySelector("[data-testid=outline-plan-approval]") as HTMLElement;
	const scope = host.querySelector(".nf-type-scope") as HTMLElement;
	const row = card.querySelector("[data-testid=outline-plan-summary-row]") as HTMLElement;
	const summary = card.querySelector("[data-testid=outline-plan-summary]") as HTMLElement;
	const textarea = card.querySelector("[data-testid=outline-plan-feedback]") as HTMLElement;
	const tn = instance.getFixedT(lng, "narrator");
	const prediction = predictInlinePermission(permission as never, {
		innerWidth: width,
		canDecide: true,
		planButtonLabels: [tn("outlinePlan.draft"), tn("outlinePlan.lock"), tn("outlinePlan.return")],
		planFeedbackPlaceholder: tn("outlinePlan.feedbackPlaceholder"),
	});
	const measured = prediction ? measureInlinePermission(prediction, width).height : null;
	const rowLine = Number.parseFloat(getComputedStyle(summary).lineHeight);
	const textareaLine = Number.parseFloat(getComputedStyle(textarea).lineHeight);
	const decisionTops = new Set(
		[...card.querySelectorAll("button")]
			.filter((b) => !row.contains(b))
			.map((b) => Math.round(b.getBoundingClientRect().top)),
	);
	return {
		rendered: (scope.firstElementChild as HTMLElement).getBoundingClientRect().height,
		measured,
		summaryLines: Math.round(row.getBoundingClientRect().height / rowLine),
		summaryText: summary.textContent,
		summaryClipped: summary.scrollWidth > summary.clientWidth + 1,
		narrow: row.hasAttribute("data-narrow"),
		feedbackRows: Math.round((textarea.getBoundingClientRect().height - 11) / textareaLine),
		predictedFeedbackRows: prediction?.feedbackRows ?? null,
		buttonRows: decisionTops.size,
		predictedButtonRows: prediction?.buttonRows ?? null,
		/** The feedback box's row as the measure model and as the browser has it. */
		modelTextareaRow: typographyMetrics().line.xsBase,
		paintedTextareaRow: textareaLine,
		overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
	};
}
