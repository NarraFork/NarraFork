/**
 * Browser fixture for `permission-textarea.browser.test.ts`: one live permission card at a time,
 * mounted the way the transcript mounts it (`buildPermissionNode`, the vlist's own bridge), and
 * read against the height model at the reader's typography.
 *
 * Four cards carry a textarea: a plain approval (Bash), the plan-file approval while its plan is
 * being edited, an outline plan's approval and an AskUserQuestion. `measure` paints one at a
 * width, language and typography, and reports the card's painted height beside the model's, and
 * each textarea's painted height, line box and rows beside the model's.
 *
 * `host` is where the card is mounted: `transcript` as the vlist mounts it (its bridge, with no
 * wrapper); `scoped` the same inside `.nf-type-scope` (Mantine's own text tokens mapped onto the
 * reader's typography, as the outline plan approval suite paints it); `inbox` the bare
 * `InlinePermission`, as the question inbox mounts it outside the transcript.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { typographyMetrics } from "@shared/pretext-layout/pretext-fonts";
import { setTypography } from "@shared/pretext-layout/typography";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { mantineTheme } from "../../../lib/mantine-theme";
import { ensureTypographyCssVars } from "../../../lib/typography-css-vars";
import commonEn from "../../../locales/en/common.json";
import narratorEn from "../../../locales/en/narrator.json";
import outlineEn from "../../../locales/en/outline.json";
import settingsEn from "../../../locales/en/settings.json";
import commonZh from "../../../locales/zh-CN/common.json";
import narratorZh from "../../../locales/zh-CN/narrator.json";
import outlineZh from "../../../locales/zh-CN/outline.json";
import settingsZh from "../../../locales/zh-CN/settings.json";
import type { PendingPermission } from "../../../types/narrator";
import { InlinePermission } from "../permission/InlinePermission";
import { PermEnterHintCtx } from "../tool-call/tool-call-contexts";
import {
	type AskUserQuestionData,
	measureAskUserQuestion,
	measureInlinePermission,
	planTextareaHeight,
	xsTextareaHeight,
} from "./measure/measure-permission";
import { buildPermissionNode } from "./vlist-permission-bridge";
import { predictInlinePermission } from "./vlist-permission-prediction";

const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	resources: {
		en: { narrator: narratorEn, common: commonEn, outline: outlineEn, settings: settingsEn },
		"zh-CN": { narrator: narratorZh, common: commonZh, outline: outlineZh, settings: settingsZh },
	},
	react: { useSuspense: false },
});

export function ready(): boolean {
	return true;
}

export type CardKind = "inline" | "plan-edit" | "outline-plan" | "ask";

const PLAN_TEXT = "## Plan\n\n- [ ] Read the importer\n- [ ] Add the rollback step";

const ASK_QUESTION = {
	id: "q1",
	header: "Which database should the importer write to?",
	options: [
		{ header: "SQLite", description: "The local file the app already uses" },
		{ header: "PostgreSQL", description: "The shared server, when one is configured" },
	],
	multiSelect: false,
};

function permissionOf(kind: CardKind): PendingPermission {
	const base = { id: `req-${kind}`, toolUseId: `toolu_${kind}`, ownerNarratorId: "n-measure" };
	switch (kind) {
		case "inline":
			return { ...base, toolName: "Bash", inputJson: { command: "ls -la" } };
		case "plan-edit":
			return { ...base, toolName: "ExitPlanMode", inputJson: { plan: PLAN_TEXT } };
		case "ask":
			return { ...base, toolName: "AskUserQuestion", inputJson: { questions: [ASK_QUESTION] } };
		case "outline-plan":
			return {
				...base,
				toolName: "ExitPlanMode",
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
				},
			};
	}
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

let root: Root | null = null;

export interface TextareaReading {
	/** Painted border-box height (px). */
	painted: number;
	/** Painted line box (computed `line-height`, px). */
	line: number;
	/** Painted font size (px). */
	fontSize: number;
	/** Rows the textarea paints (its height over its line box, chrome taken off). */
	rows: number;
	/** The model's height for that many rows. */
	model: number;
}

export interface CardReading {
	/** The card's painted outer height (px): what the vlist's form reporter reads. */
	rendered: number;
	/** The model's height for the same card. */
	measured: number;
	textareas: TextareaReading[];
	/** The model's textarea row (`typographyMetrics().line.xsBase`) and xs size. */
	modelLine: number;
	modelFontSize: number;
	overflowX: boolean;
}

/**
 * Paint `kind` at `width` in `lng` and typography `font`/`line` (percent), and read it against the
 * height model. Mounted fresh each time.
 */
export async function measure(
	kind: CardKind,
	lng: string,
	width: number,
	font: number,
	line: number,
	host: "transcript" | "scoped" | "inbox",
): Promise<CardReading> {
	ensureTypographyCssVars();
	await instance.changeLanguage(lng);
	setTypography({ fontScalePercent: font, lineHeightScalePercent: line });
	let container = document.getElementById("measure-host");
	if (!container) {
		container = document.createElement("div");
		container.id = "measure-host";
		document.body.appendChild(container);
	}
	root?.unmount();
	root = createRoot(container);
	const permission = permissionOf(kind);
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(["settings"], { agent: { questionReflectionEnabled: false } });
	const mounted = root;
	flushSync(() =>
		mounted.render(
			<I18nextProvider i18n={instance}>
				<MantineProvider theme={mantineTheme}>
					<QueryClientProvider client={queryClient}>
						<div className={host === "scoped" ? "nf-type-scope" : undefined} style={{ width }}>
							<PermEnterHintCtx.Provider
								value={{
									focusIndex: 0,
									setFocusIndex: () => {},
									setButtonCount: () => {},
									setHasFeedback: () => {},
									registerActions: () => {},
									activePermissionId: permission.id,
								}}
							>
								{/* The vlist's form reporter: a block formatting context, so the form's
								    top margin is inside the height it reads. */}
								<div data-testid="form" style={{ display: "flow-root" }}>
									{host === "inbox" ? (
										<InlinePermission permission={permission} />
									) : (
										buildPermissionNode(permission, {
											onPermissionDecision: () => {},
											onQuestionSubmit: () => {},
											onQuestionReflect: () => {},
											onQuestionDeny: () => {},
										})
									)}
								</div>
							</PermEnterHintCtx.Provider>
						</div>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		),
	);
	if (kind === "plan-edit") {
		const tn = instance.getFixedT(lng, "narrator");
		const edit = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.startsWith(tn("planEdit")),
		);
		if (!edit) throw new Error("no edit button");
		flushSync(() => edit.click());
	}
	return read(kind, lng, width);
}

/**
 * Move the typography under the card already mounted (a slider drag in the 外观 panel) and read
 * it again: only the `--nf-type-*` variables change, which re-render nothing by themselves.
 */
export async function retype(
	kind: CardKind,
	lng: string,
	width: number,
	font: number,
	line: number,
): Promise<CardReading> {
	setTypography({ fontScalePercent: font, lineHeightScalePercent: line });
	return read(kind, lng, width);
}

async function read(kind: CardKind, lng: string, width: number): Promise<CardReading> {
	// The outline plan's summary picks its form after a resize observer; autosize settles in a
	// layout effect. A few frames cover both.
	for (let frame = 0; frame < 6; frame++) await nextFrame();
	const permission = permissionOf(kind);
	const form = document.querySelector("#measure-host [data-testid=form]") as HTMLElement;
	const metrics = typographyMetrics();
	const textareas = [...form.querySelectorAll("textarea")].map((el): TextareaReading => {
		const style = getComputedStyle(el);
		const painted = el.getBoundingClientRect().height;
		const lineBox = Number.parseFloat(style.lineHeight);
		const chrome =
			Number.parseFloat(style.paddingTop) +
			Number.parseFloat(style.paddingBottom) +
			Number.parseFloat(style.borderTopWidth) +
			Number.parseFloat(style.borderBottomWidth);
		const rows = Math.round((painted - chrome) / lineBox);
		// The plan editor is the only textarea with an 8-row floor (`rows` is its minRows).
		const isPlan = el.rows >= 8;
		return {
			painted,
			line: lineBox,
			fontSize: Number.parseFloat(style.fontSize),
			rows,
			model: isPlan ? planTextareaHeight(rows) : xsTextareaHeight(rows),
		};
	});
	const buttonRows = (within: Element) =>
		new Set(
			[...within.querySelectorAll("button")]
				.filter(
					(b) => b.offsetParent !== null && !b.closest("[data-testid=outline-plan-summary-row]"),
				)
				.map((b) => Math.round(b.getBoundingClientRect().top)),
		).size;

	let measured: number;
	if (kind === "ask") {
		const data: AskUserQuestionData = {
			questions: [
				{
					header: ASK_QUESTION.header,
					options: ASK_QUESTION.options,
					multiSelect: false,
					hasCustomInput: true,
					customInputRows: textareas[0]?.rows ?? 1,
				},
			],
		};
		measured = measureAskUserQuestion(data, width).height;
	} else if (kind === "plan-edit") {
		// The prediction covers a request's first frame, never the edit mode a click opens: the
		// model is given the rows the paint shows (counts only) and computes their heights.
		const m = measureInlinePermission(
			{
				isExitPlanMode: true,
				isEditingPlan: true,
				planEditRows: textareas[0]?.rows ?? 8,
				feedbackRows: textareas[1]?.rows ?? 1,
				buttonRows: buttonRows(form),
			},
			width,
		);
		measured = m.topMargin + m.height;
	} else {
		const tn = instance.getFixedT(lng, "narrator");
		const prediction = predictInlinePermission(permission as never, {
			innerWidth: width,
			canDecide: true,
			planButtonLabels: [tn("outlinePlan.draft"), tn("outlinePlan.lock"), tn("outlinePlan.return")],
			planFeedbackPlaceholder: tn("outlinePlan.feedbackPlaceholder"),
		});
		if (!prediction) throw new Error(`no prediction for ${kind}`);
		const m = measureInlinePermission(prediction, width);
		measured = m.topMargin + m.height;
	}
	return {
		rendered: form.getBoundingClientRect().height,
		measured,
		textareas,
		modelLine: metrics.line.xsBase,
		modelFontSize: metrics.size.xs,
		overflowX: form.scrollWidth > width + 1,
	};
}
