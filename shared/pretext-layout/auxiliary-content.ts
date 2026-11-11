import { COMMUNICATION_PREVIEW_MAX_CHARS, limitCommunicationPreview } from "../communication-tool";
import { knowledgeExcerpt } from "../knowledge-excerpt";
import { blockAtIndex, type MessageWithBody, messageBody } from "../narrator-blocks/message-blocks";
import { contextBlockViews, injectionBlockViews } from "../native-injection";
import {
	readSideCarBody,
	type SideCarBody,
	type SideCarKnowledgeHit,
	sideCarBodyToPlainText,
} from "../sidecar-body";
import type { InjectionTarget } from "./injection-target";
import type { ToolDetailData, ToolStructuredEntry } from "./tool-detail";

export interface AuxiliaryBlock {
	type: string;
	[key: string]: unknown;
}

export interface AuxiliaryMessage extends MessageWithBody<AuxiliaryBlock> {
	id?: string;
	role: string;
	origin?: string | null;
	originLabel?: string | null;
	creator?: unknown;
}

/** Same physical-block key as elementKey; no adapter import cycle. */
export function auxiliaryContentKey(msg: AuxiliaryMessage, blockIndex: number): string {
	const idBase = msg.id ?? "msg";
	const block = blockAtIndex(msg, blockIndex);
	const offset = block ? blockIndex - block.from : 0;
	return `auxiliary-${block ? `${idBase}-blk[${block.id}]${offset ? `+${offset}` : ""}` : `${idBase}-b${blockIndex}`}`;
}

/** One reader record, retaining the real logical block and its physical ownership. */
export interface AuxiliaryContentProjection {
	block: AuxiliaryBlock;
	blockIndex: number;
	sourceIndices: number[];
	source: string;
}

/** Display DTO only: not a tool call and never a tool-detail fetch identity. */
export interface AuxiliaryContentData {
	contentRole: "auxiliary";
	auxiliary: true;
	toolName: string;
	summary: string;
	category: string;
	/** Internal visual default; sourceStatus alone owns the visible status glyph. */
	status: "success" | "fail" | "running" | "pending" | "cancelled" | "denied";
	sourceStatus?: string | null;
	source: string;
	modelFacing: string;
	inspectContent: string;
	target?: InjectionTarget | null;
	detail?: ToolDetailData | null;
}

const AUXILIARY_SOURCES = new Set([
	"bg_bash",
	"bg_agent",
	"living_work_spec",
	"todo_reminder",
	"behavior_fence",
	"silent_progress",
	"turn_nudge",
	"relaxed_plan",
	"spec_update",
	"workspace_changed",
	"knowledge_base_hint",
	"subagent_message",
	"team_message",
	"agent_message",
]);
const COMMUNICATION_SOURCES = new Set(["subagent_message", "team_message", "agent_message"]);
const SOURCE_LABELS: Record<string, string> = {
	bg_bash: "Bash",
	bg_agent: "Agent",
	living_work_spec: "Tasks",
	todo_reminder: "Tasks",
	behavior_fence: "Behavior",
	silent_progress: "Progress",
	turn_nudge: "Reminder",
	relaxed_plan: "Plan",
	spec_update: "Spec",
	workspace_changed: "Workspace",
	knowledge_base_hint: "Knowledge",
	knowledge_hint: "Knowledge",
	subagent_message: "Agent",
	team_message: "Agent",
	agent_message: "Agent",
};
const SOURCE_LABEL_KEYS: Record<string, string> = {
	bg_bash: "sidecarSourceBgBash",
	bg_agent: "sidecarSourceBgAgent",
	living_work_spec: "sidecarSourceTodoReminder",
	todo_reminder: "sidecarSourceTodoReminder",
	behavior_fence: "sidecarSourceBehaviorFence",
	silent_progress: "sidecarSourceSilentProgress",
	turn_nudge: "sidecarSourceTurnNudge",
	relaxed_plan: "sidecarSourceRelaxedPlan",
	spec_update: "sidecarSourceSpecUpdate",
	workspace_changed: "sidecarSourceWorkspaceChanged",
	knowledge_base_hint: "sidecarSourceKnowledgeBaseHint",
	knowledge_hint: "sidecarSourceKnowledgeBaseHint",
	subagent_message: "sidecarSourceSubagentMessage",
	team_message: "sidecarSourceTeamMessage",
};

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function short(value: unknown): string {
	return text(value).slice(0, 160).replace(/\s+/g, " ").trim();
}
function hasHumanSource(msg: AuxiliaryMessage): boolean {
	return msg.origin === "user" || (msg.role === "user" && !msg.origin);
}
function isAuxiliaryBlock(block: AuxiliaryBlock): boolean {
	if (block.status === "pending" || block.status === "awaiting_confirmation") return false;
	if (block.type === "knowledge_hint") return true;
	if (block.type !== "system_injection" || !AUXILIARY_SOURCES.has(text(block.source))) return false;
	const body = readSideCarBody(block);
	if (COMMUNICATION_SOURCES.has(text(block.source))) {
		return (
			body?.kind === "messages" &&
			body.items.length > 0 &&
			body.items.every(
				(item) => item.showToUser !== true && item.fromType !== "user" && item.fromType !== "human",
			)
		);
	}
	// Unknown body kinds are not quietly demoted to generic log output.
	return (
		!body ||
		["notice", "prose", "tasks", "tasksDone", "knowledge", "specUpdates"].includes(body.kind)
	);
}

/** Shared classifier for grouping, standalone adaptation and recency. No prose projection. */
export function auxiliaryContentViews(
	msg: AuxiliaryMessage,
	visibleBlockIndices?: readonly number[],
): AuxiliaryContentProjection[] {
	if (hasHumanSource(msg)) return [];
	const blocks = messageBody(msg);
	const visible = visibleBlockIndices ? new Set(visibleBlockIndices) : undefined;
	const views = [...contextBlockViews(blocks), ...injectionBlockViews(blocks)];
	const result: AuxiliaryContentProjection[] = [];
	const seen = new Set<number>();
	for (const view of views) {
		const block = { ...blocks[view.blockIndex], ...view.block } as AuxiliaryBlock;
		if (seen.has(view.blockIndex) || !isAuxiliaryBlock(block)) continue;
		// A filtered segment owns the structured block, not a coincidental companion.
		if (visible && !visible.has(view.blockIndex)) continue;
		seen.add(view.blockIndex);
		result.push({
			block,
			blockIndex: view.blockIndex,
			sourceIndices: view.sourceIndices.filter((index) => !visible || visible.has(index)),
			source: view.block.type === "knowledge_hint" ? "knowledge_hint" : text(view.block.source),
		});
	}
	// Attribution is authoritative; no sender/type guessing from legacy prose.
	if (
		result.length === 0 &&
		msg.origin === "assistant" &&
		(msg.originLabel === "agentMessage" || msg.originLabel?.startsWith("agentMessage:")) &&
		!blocks.some((block) => block.type === "system_injection")
	) {
		for (const [blockIndex, block] of blocks.entries()) {
			if (block.type !== "text" || (visible && !visible.has(blockIndex))) continue;
			result.push({ block, blockIndex, sourceIndices: [blockIndex], source: "subagent_message" });
		}
	}
	return result.sort((a, b) => a.blockIndex - b.blockIndex);
}

function sourceCategory(source: string): string {
	if (source === "bg_bash") return "bash";
	if (source === "bg_agent") return "agent";
	if (source.includes("knowledge")) return "knowledge";
	if (COMMUNICATION_SOURCES.has(source)) return "send";
	if (source === "living_work_spec" || source === "todo_reminder") return "tasks";
	if (source === "workspace_changed") return "workspace";
	return "generic";
}
function nativeKnowledgeBody(block: AuxiliaryBlock): SideCarBody | undefined {
	if (block.type !== "knowledge_hint") return readSideCarBody(block);
	const entries = Array.isArray(block.entries) ? block.entries : [];
	return { kind: "knowledge", hits: entries as SideCarKnowledgeHit[] };
}

function joinContent<T>(items: readonly T[], read: (item: T) => string, preview: boolean): string {
	if (!preview) return items.map(read).join("\n\n");
	let result = "";
	for (const item of items) {
		if (result.length > 0) result += "\n\n";
		if (result.length > COMMUNICATION_PREVIEW_MAX_CHARS) break;
		// Keep one extra character so the capped descriptor can report truncation.
		result += read(item).slice(0, COMMUNICATION_PREVIEW_MAX_CHARS + 1 - result.length);
		if (result.length > COMMUNICATION_PREVIEW_MAX_CHARS) break;
	}
	return result;
}

function cappedDetail(
	value: string,
	id: string,
	preview: boolean,
	format: "text" | "markdown",
	sourceTruncated = false,
): ToolDetailData {
	const bounded = preview ? limitCommunicationPreview(value) : { text: value, truncated: false };
	return {
		kind: "sections",
		sections: [
			{
				key: "auxiliary.body",
				body: {
					kind: "capped",
					id,
					source: "output.auxiliary",
					format,
					live: false,
					followTarget: { kind: "end" },
					cap: "agent-result",
					text: bounded.text,
					...(bounded.truncated || sourceTruncated ? { textTruncated: true } : {}),
				},
			},
		],
	};
}

export function auxiliaryVisualStatus(status?: string | null): AuxiliaryContentData["status"] {
	if (status === "fail" || status === "failed" || status === "error") return "fail";
	if (status === "running" || status === "executing") return "running";
	if (status === "pending" || status === "initializing") return "pending";
	if (status === "cancelled" || status === "interrupted") return "cancelled";
	if (status === "denied") return "denied";
	return "success";
}

/** Summary construction is bounded; full projection happens only for an actually visible body. */
export function buildAuxiliaryContentData(
	projection: AuxiliaryContentProjection,
	opts: {
		labels?: Record<string, string>;
		includeDetail?: boolean;
		preview?: boolean;
		id?: string;
	} = {},
): AuxiliaryContentData {
	const { block, source } = projection;
	const body = nativeKnowledgeBody(block);
	let label = opts.labels?.[SOURCE_LABEL_KEYS[source]] || SOURCE_LABELS[source] || source;
	let summary = short(block.summary);
	let target: InjectionTarget | null = null;
	let sourceStatus = typeof block.status === "string" ? block.status : undefined;
	let content = "";
	let sourceTruncated = false;
	let format: "text" | "markdown" = "markdown";
	let detail: ToolDetailData | undefined;
	if (body?.kind === "tasksDone") {
		const task = body.items[0];
		label = body.flavor === "agent" ? "Agent" : "Bash";
		summary = task ? short(task.alias || task.title || task.id) : summary;
		sourceStatus =
			body.items.find((item) => ["fail", "failed", "error"].includes(item.status))?.status ||
			task?.status ||
			sourceStatus;
		if (body.flavor === "agent" && task?.id)
			target = { kind: "narrator", narratorId: task.id, messageId: task.resultMessageId };
		if (opts.includeDetail)
			content = joinContent(body.items, (item) => item.preview, opts.preview === true);
		sourceTruncated = body.items.some((item) => item.truncated === true);
		format = body.flavor === "bash" ? "text" : "markdown";
	} else if (body?.kind === "messages") {
		const message = body.items[0];
		if (message) {
			label = short(message.fromTitle || message.fromLabel || message.fromId) || label;
			summary = short(message.text);
		}
		if (message?.fromId)
			target = {
				kind: "narrator",
				narratorId: message.fromId,
				messageId: message.fromToolUseId ?? message.fromMessageId,
			};
		if (opts.includeDetail)
			content = joinContent(body.items, (item) => item.text, opts.preview === true);
	} else if (body?.kind === "knowledge") {
		summary = `${body.hits.length} · ${short(body.hits[0]?.title)}`;
		if (opts.includeDetail) {
			const entries: ToolStructuredEntry[] = (opts.preview ? body.hits.slice(0, 5) : body.hits).map(
				(hit) => ({
					title: hit.title || hit.entryId,
					snippet: knowledgeExcerpt(
						opts.preview ? text(hit.summary).slice(0, 1024) : text(hit.summary),
						{ title: hit.title },
					),
					target: hit.entryId
						? { kind: "knowledge", entryId: hit.entryId, scope: hit.scope ?? "global" }
						: undefined,
				}),
			);
			detail = {
				kind: "sections",
				sections: [
					{ key: "auxiliary.knowledge", body: { kind: "structured", bodyLines: [], entries } },
				],
			};
		}
	} else if (body?.kind === "tasks") {
		summary = `${body.taskCount ?? body.tasks?.length ?? 0} · ${short(body.tasks?.[0]?.text) || body.variant}`;
		if (opts.includeDetail)
			detail = {
				kind: "sections",
				sections: [
					{
						key: "auxiliary.tasks",
						body: {
							kind: "spec-tasks",
							tasks: (opts.preview ? (body.tasks ?? []).slice(0, 8) : (body.tasks ?? [])).map(
								(task) => ({
									text: opts.preview ? task.text.slice(0, 512) : task.text,
									status: task.role,
									protected: task.protected === true,
								}),
							),
						},
					},
				],
			};
	} else if (body?.kind === "specUpdates") {
		summary = body.items
			.slice(0, 3)
			.map((item) => short(item.uri))
			.join(" · ");
		if (body.items.length === 1) target = { kind: "spec", uri: body.items[0].uri };
		if (opts.includeDetail) {
			const displayBody = opts.preview
				? {
						...body,
						items: body.items.slice(0, 3).map((item) => ({
							...item,
							uri: item.uri.slice(0, 512),
							preview: item.preview?.slice(0, 2048),
							taskSummary: item.taskSummary?.slice(0, 2048),
						})),
					}
				: body;
			content = sideCarBodyToPlainText(source, displayBody, opts.labels);
		}
	} else {
		summary ||= body?.kind === "prose" ? short(body.text) : short(block.text);
		if (opts.includeDetail)
			content =
				body?.kind === "prose"
					? body.text
					: body
						? sideCarBodyToPlainText(source, body, opts.labels)
						: text(block.text) || text(block.modelText);
	}
	const modelFacing = text(block.modelText) || text(block.text);
	return {
		contentRole: "auxiliary",
		auxiliary: true,
		toolName: label,
		summary,
		category: sourceCategory(source),
		status: auxiliaryVisualStatus(sourceStatus),
		...(sourceStatus ? { sourceStatus } : {}),
		source,
		modelFacing,
		inspectContent: modelFacing,
		target,
		...(opts.includeDetail
			? {
					detail:
						detail ??
						cappedDetail(
							content,
							opts.id ?? `auxiliary:${source}`,
							opts.preview === true,
							format,
							sourceTruncated,
						),
				}
			: {}),
	};
}
