import type { FileReferenceContext } from "@shared/file-reference";
import { normalizeFileReferenceContext } from "@shared/file-reference-context";
import type { ElementSpec } from "@shared/pretext-layout/segment-adapter";
import type { ToolCappedDetail, ToolDetailData } from "@shared/pretext-layout/tool-detail";
import type { MeasuredSubagent } from "./measure/measure-subagent";
import type { MeasuredToolCall, MeasuredToolDetail } from "./measure/measure-tool-call";

export type VListViewKind = "code" | "markdown" | "diff" | "term";

/** List location is not content identity: a tool can move into a folded trace. */
export interface VListViewOwner {
	specKey: string;
	traceItemIndex?: number;
}

/** Toolbar projection of a body. Tool painters consume the original model. */
export interface VListViewTarget {
	id: string;
	/** Semantic source for tools; BODY_SLOT for ordinary messages. */
	slot: string;
	owner: VListViewOwner;
	model?: ToolCappedDetail;
	kind: VListViewKind;
	fileReferenceContext?: FileReferenceContext | null;
	title?: string;
	text: string;
	codeLang?: string;
	codeLangPath?: string;
	customHighlight?: "struct-view";
	truncated?: boolean;
	rowShowsPrefix?: boolean;
	sourceInline?: boolean;
}

export interface VListViewTargetLabels {
	sections?: Partial<Record<string, string>>;
	prompt?: string;
	reasoning?: string;
	thinking?: string;
}

export const BODY_SLOT = "body";
export const PROMPT_SLOT = "input.prompt";
export const RESULT_SLOT = "output.main";

function viewOwner(owner: string | VListViewOwner): VListViewOwner {
	return typeof owner === "string" ? { specKey: owner } : owner;
}

function targetFromModel(
	owner: string | VListViewOwner,
	model: ToolCappedDetail,
	title?: string,
	rowShowsPrefix?: boolean,
): VListViewTarget | null {
	if (model.format === "media") return null;
	return {
		id: model.id,
		slot: model.source,
		owner: viewOwner(owner),
		model,
		kind: model.format === "text" ? "code" : model.format,
		text: model.text ?? "",
		...(title ? { title } : {}),
		...(model.codeLang ? { codeLang: model.codeLang } : {}),
		...(model.codeLangPath ? { codeLangPath: model.codeLangPath } : {}),
		...(model.customHighlight ? { customHighlight: model.customHighlight } : {}),
		...(model.textTruncated ? { truncated: true } : {}),
		...(rowShowsPrefix ? { rowShowsPrefix: true } : {}),
		...(model.format === "markdown" ? { sourceInline: true } : {}),
	};
}

export function resolveToolDetailViewTargets(
	owner: string | VListViewOwner,
	measured: Pick<MeasuredToolCall, "detail">,
	labels?: VListViewTargetLabels,
): VListViewTarget[] {
	return measured.detail ? resolveDetailViewTargets(owner, measured.detail, labels) : [];
}

/** One canonical sections traversal; no tags, caps, indices or diff reconstruction. */
export function resolveDetailViewTargets(
	owner: string | VListViewOwner,
	detail: MeasuredToolDetail,
	labels?: VListViewTargetLabels,
): VListViewTarget[] {
	const targets: VListViewTarget[] = [];
	for (const section of detail.sections) {
		const body = section.measuredBody;
		if (body.model.kind !== "capped") continue;
		const target = targetFromModel(
			owner,
			body.model,
			section.label ? labels?.sections?.[section.label] : undefined,
			body.bodyIsPrefix,
		);
		if (target) targets.push(target);
	}
	return targets;
}

/** Fullscreen refresh uses source data even when the inline card is not measured. */
export function resolveToolDetailModelTargets(
	owner: string | VListViewOwner,
	detail: ToolDetailData | null | undefined,
	labels?: VListViewTargetLabels,
): VListViewTarget[] {
	const targets: VListViewTarget[] = [];
	for (const section of detail?.sections ?? []) {
		if (section.body.kind !== "capped") continue;
		const target = targetFromModel(
			owner,
			section.body,
			section.label ? labels?.sections?.[section.label] : undefined,
		);
		if (target) targets.push(target);
	}
	return targets;
}

export function resolveSubagentModelTargets(
	owner: string | VListViewOwner,
	data: { promptBody?: ToolCappedDetail | null; resultBody?: ToolCappedDetail | null },
	opts: { title?: string } = {},
	labels?: VListViewTargetLabels,
): VListViewTarget[] {
	const targets: VListViewTarget[] = [];
	for (const [model, title] of [
		[data.promptBody, labels?.prompt],
		[data.resultBody, opts.title],
	] as const) {
		if (!model) continue;
		const target = targetFromModel(owner, model, title);
		if (target) targets.push(target);
	}
	return targets;
}

export function findViewTarget(
	targets: readonly VListViewTarget[] | undefined,
	source: string,
): VListViewTarget | undefined {
	return targets?.find((target) => target.slot === source);
}

export function viewTargetSpecKey(target: VListViewTarget): string {
	return target.owner.specKey;
}

export function resolveSubagentViewTargets(
	owner: string | VListViewOwner,
	measured: Pick<MeasuredSubagent, "promptMeasured" | "resultMeasured">,
	opts: { title?: string } = {},
	labels?: VListViewTargetLabels,
): VListViewTarget[] {
	const targets: VListViewTarget[] = [];
	for (const [body, title] of [
		[measured.promptMeasured, labels?.prompt],
		[measured.resultMeasured, opts.title],
	] as const) {
		if (!body) continue;
		const target = targetFromModel(owner, body.model, title, body.bodyIsPrefix);
		if (target) targets.push(target);
	}
	return targets;
}

/** Ordinary messages retain their own BODY_SLOT; no tool identity is fabricated. */
export function resolveRowViewTargets(
	spec: Pick<ElementSpec, "kind" | "key" | "data" | "opts">,
	labels?: VListViewTargetLabels,
	opts?: RowViewTargetOptions,
): VListViewTarget[] {
	let text: unknown;
	let title: string | undefined;
	if (spec.kind === "markdown") {
		text = spec.data;
	} else if (spec.kind === "reasoning") {
		const data = (spec.data ?? {}) as { text?: unknown; translatedText?: unknown };
		text = spec.opts?.showOriginal ? data.text : data.translatedText || data.text;
		title = labels?.reasoning ?? labels?.thinking;
	} else {
		return [];
	}
	if (typeof text !== "string" || text.length === 0) return [];
	const context = normalizeFileReferenceContext(spec.opts?.fileReferenceContext);
	return [
		{
			id: `${spec.key}:${BODY_SLOT}`,
			slot: BODY_SLOT,
			owner: { specKey: spec.key },
			kind: "markdown",
			text,
			...(title ? { title } : {}),
			...(context ? { fileReferenceContext: context } : {}),
			...(opts?.sourceInline ? { sourceInline: true } : {}),
		},
	];
}

export interface RowViewTargetOptions {
	sourceInline?: boolean;
}

export function resolvePrimaryViewTarget(
	targets: readonly VListViewTarget[],
): VListViewTarget | undefined {
	return targets.at(-1);
}

/** Only reader preferences enter this render signature, never shared measurement. */
export function viewStateSig(
	wrap: ReadonlyMap<string, boolean>,
	showSource: ReadonlyMap<string, boolean>,
	specKey: string,
	owners: ReadonlyMap<string, VListViewOwner>,
): string {
	const parts: string[] = [];
	for (const [prefix, values] of [
		["w", wrap],
		["s", showSource],
	] as const) {
		for (const [id, value] of values) {
			if (owners.get(id)?.specKey === specKey) parts.push(`${prefix}${id}=${value ? 1 : 0}`);
		}
	}
	return parts.sort().join(",");
}

/** Small descriptor comparison, including same-text lifecycle/range/focus updates. */
export function sameViewTarget(a: VListViewTarget, b: VListViewTarget): boolean {
	const descriptor = (target: VListViewTarget) => {
		const model = target.model;
		return JSON.stringify([
			target.owner,
			target.slot,
			target.kind,
			target.title,
			target.codeLang,
			target.codeLangPath,
			target.truncated,
			target.rowShowsPrefix,
			target.sourceInline,
			target.fileReferenceContext,
			model?.source,
			model?.format,
			model?.live,
			model?.revision,
			model?.range,
			model?.followTarget,
			model?.sourcePath,
			model?.diffDocument?.revision,
			model?.diffDocument?.focus,
			model?.diffDocument?.oldSource.range,
			model?.diffDocument?.newSource.range,
		]);
	};
	return a.id === b.id && a.text === b.text && descriptor(a) === descriptor(b);
}
