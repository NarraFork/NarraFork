import {
	communicationSelectors,
	communicationTargetLabel,
	deriveCommunicationState,
	formatCommunicationState,
	resolveCommunicationTargets,
} from "@shared/pretext-layout/communication-state";
import { workspaceSummary } from "@shared/pretext-layout/workspace-tool-display";

/** Only a live foreground Bash command can be detached; never stop/Agent/Send calls. */
export function isRunningForegroundBash(
	toolName: string | undefined,
	input: unknown,
	status: string | undefined,
	metadata?: Record<string, unknown>,
): boolean {
	if (toolName !== "Bash" || (status !== "executing" && status !== "running")) return false;
	if (!input || typeof input !== "object") return false;
	const args = input as Record<string, unknown>;
	return (
		typeof args.command === "string" &&
		args.command.trim().length > 0 &&
		!args.stop &&
		args.background !== true &&
		args.run_in_background !== true &&
		!metadata?.background_task_id &&
		metadata?.detached !== true
	);
}

export type ToolCategory =
	| "read"
	| "file"
	| "bash"
	| "search"
	| "structure"
	| "structureEdit"
	| "webSearch"
	| "webFetch"
	| "tasks"
	| "taskOutput"
	| "agent"
	| "await"
	| "send"
	| "ask"
	| "plan"
	| "pipeline"
	| "terminal"
	| "share"
	| "transfer"
	| "recall"
	| "skill"
	| "browser"
	| "knowledge"
	| "schedule"
	| "contextAsk"
	| "workspace"
	| "generic";

const READ_TOOLS = new Set(["Read"]);
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);
// "Shell" is a legacy alias kept only so older stored history still classifies as
// a shell call; the server always mints "Bash".
const BASH_TOOLS = new Set(["Bash", "Shell", "Execute"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Find"]);
/**
 * StructView gets its own category rather than sharing `search`.
 *
 * Its input has NO overlap with Grep's: `file_path` + `mode` versus `pattern` + `path`.
 * While it was classified as a search, the detail card read `pattern`/`glob`/`path`,
 * found nothing, and dropped its entire header — and the collapsed row fell through to
 * showing just the bare tool name, so a reader could not see which file or mode.
 */
const STRUCTURE_TOOLS = new Set(["StructView"]);
/**
 * StructSed is separate from `structure` for the same reason StructView is separate from
 * `search`: the inputs do not line up. It carries `command`, not `mode`, so the structure
 * formatter would report every call as "outline" — a delete would read as a read.
 *
 * It is also a WRITE, and a reader scanning a run must be able to tell a structural edit
 * from a structural inspection at a glance.
 */
const STRUCTURE_EDIT_TOOLS = new Set(["StructSed"]);
const WEB_SEARCH_TOOLS = new Set(["WebSearch"]);
const WEB_FETCH_TOOLS = new Set(["WebFetch"]);
const SPEC_TASKS_URI = "spec://tasks.json";
const TASK_OUTPUT_TOOLS = new Set(["TaskOutput"]);

/**
 * Whether a file tool operates on the Dynamic Spec task queue
 * (spec://tasks.json). Used to render task-list details instead of a raw file diff.
 *
 * Reads the STREAMING path field too (`_streamingFilePath`, written by
 * `topLevelStreamingChunkToToolFields` while the model is still writing the
 * arguments). Without it the same call resolves to `read`/`file` while streaming
 * and to `tasks` once persisted — so its category glyph CHANGED at the hand-off,
 * which is exactly the kind of jump the folded low-LOD row must not have. The
 * category also selects the detail classifier, so a stable answer keeps the
 * streaming card's body consistent with the persisted one as well.
 */
export function isSpecTasksToolUse(name: string, input: unknown): boolean {
	if (name !== "Read" && name !== "Write" && name !== "Edit") return false;
	const fp = getFilePath(input) || getStreamingFilePath(input);
	return fp === SPEC_TASKS_URI;
}

/** The path a streaming tool call has extracted so far, if any. */
function getStreamingFilePath(input: unknown): string {
	if (!input || isTruncated(input) || typeof input !== "object") return "";
	const raw = (input as Record<string, unknown>)._streamingFilePath;
	return typeof raw === "string" ? raw : "";
}
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const AWAIT_TOOLS = new Set(["Await"]);
const SEND_TOOLS = new Set(["Send"]);
const ASK_TOOLS = new Set(["AskUserQuestion"]);
const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);
const PIPELINE_TOOLS = new Set(["StartPipeline", "ExtractPipeline", "EndPipeline"]);
const TERMINAL_TOOLS = new Set(["Terminal"]);
const SHARE_TOOLS = new Set(["ShareFile"]);
const TRANSFER_TOOLS = new Set(["TransferFile"]);
const RECALL_TOOLS = new Set(["Recall"]);
const SCHEDULE_TOOLS = new Set(["ScheduledTask"]);
const SKILL_TOOLS = new Set(["Skill"]);
const BROWSER_TOOLS = new Set(["Browser"]);
/**
 * ContextAsk reads another subagent's persisted context through the summary
 * model. Its input (`id` + `questions[]`) overlaps with neither Send's message
 * nor AskUserQuestion's option cards, so the generic JSON dump made a collapsed
 * row read `ContextAsk · ContextAsk` and an expanded one show raw arguments.
 */
const CONTEXT_ASK_TOOLS = new Set(["ContextAsk"]);
const KNOWLEDGE_TOOLS = new Set([
	"KnowledgeSearch",
	"KnowledgeRead",
	"KnowledgeLibrary",
	"KnowledgeCreate",
	"KnowledgeEdit",
	"KnowledgeReview",
	"KnowledgeAdmin",
]);

export function getCategory(name: string, input?: unknown): ToolCategory {
	// Spec task-queue file operations render as a task list, not a raw file diff.
	if (input !== undefined && isSpecTasksToolUse(name, input)) return "tasks";
	if (READ_TOOLS.has(name)) return "read";
	if (FILE_TOOLS.has(name)) return "file";
	if (BASH_TOOLS.has(name)) return "bash";
	if (STRUCTURE_TOOLS.has(name)) return "structure";
	if (STRUCTURE_EDIT_TOOLS.has(name)) return "structureEdit";
	if (SEARCH_TOOLS.has(name)) return "search";
	if (WEB_SEARCH_TOOLS.has(name)) return "webSearch";
	if (WEB_FETCH_TOOLS.has(name)) return "webFetch";
	if (TASK_OUTPUT_TOOLS.has(name)) return "taskOutput";
	if (AGENT_TOOLS.has(name)) return "agent";
	if (AWAIT_TOOLS.has(name)) return "await";
	if (SEND_TOOLS.has(name)) return "send";
	if (ASK_TOOLS.has(name)) return "ask";
	if (PLAN_TOOLS.has(name)) return "plan";
	if (PIPELINE_TOOLS.has(name)) return "pipeline";
	if (TERMINAL_TOOLS.has(name)) return "terminal";
	if (SHARE_TOOLS.has(name)) return "share";
	if (TRANSFER_TOOLS.has(name)) return "transfer";
	if (RECALL_TOOLS.has(name)) return "recall";
	if (SCHEDULE_TOOLS.has(name)) return "schedule";
	if (SKILL_TOOLS.has(name)) return "skill";
	if (BROWSER_TOOLS.has(name)) return "browser";
	if (KNOWLEDGE_TOOLS.has(name)) return "knowledge";
	if (CONTEXT_ASK_TOOLS.has(name)) return "contextAsk";
	if (["Worktree", "SwitchWorkingDirectory", "SwitchDevice"].includes(name)) return "workspace";
	return "generic";
}

export type ToolDisplayColor =
	| "gray"
	| "green"
	| "yellow"
	| "red"
	| "blue"
	| "teal"
	| "indigo"
	| "pink"
	| "orange"
	| "violet"
	| "cyan"
	| "lime"
	| "grape";

export function getCategoryColor(cat: ToolCategory): ToolDisplayColor {
	switch (cat) {
		case "read":
			return "lime";
		case "file":
			return "violet";
		case "bash":
			return "orange";
		case "search":
			return "cyan";
		// Shares search's cyan: both answer a question about code rather than returning
		// its contents, and a reader scanning a run benefits from grep and StructView
		// reading as the same kind of step. The mode chip in the card disambiguates.
		case "structure":
			return "cyan";
		// NOT search's cyan: this one writes. It takes `file` violet so a reader scanning a
		// run groups it with Write and Edit, rather than reading as another inspection step
		// that happens to carry a different chip.
		case "structureEdit":
			return "violet";
		case "webSearch":
		case "webFetch":
		case "browser":
			return "teal";
		case "tasks":
			return "teal";
		case "share":
			return "green";
		// Not share's green: the two are adjacent in meaning (both hand a file
		// somewhere) and a reader scanning a long run needs to tell "published a
		// download link" from "moved bytes to a device" at a glance. Blue is already
		// send/ask's colour, but those never sit next to a transfer the way a share
		// does, and the glyph disambiguates.
		case "transfer":
			return "blue";
		case "taskOutput":
		case "await":
		// Same indigo: both fetch information from another session / auxiliary model
		// rather than mutating files or talking to the user. Send/ask's blue stays
		// with the communication pair.
		case "contextAsk":
			return "indigo";
		case "agent":
			return "pink";
		case "send":
		case "ask":
			return "blue";
		case "plan":
		case "skill":
			return "grape";
		case "knowledge":
			return "grape";
		case "pipeline":
			return "indigo";
		case "terminal":
			return "yellow";
		case "recall":
			return "cyan";
		// Shares terminal's yellow rather than taking a new hue. The palette's unused
		// slot is red, which reads as failure on a row that succeeded. Terminal and
		// ScheduledTask calls rarely sit next to each other, and the glyph plus the
		// `ScheduledTask · …` title disambiguate when they do.
		case "schedule":
			return "yellow";
		default:
			return "gray";
	}
}

export function basename(p: string): string {
	const parts = p.split("/");
	return parts[parts.length - 1] || p;
}

/**
 * Truncation readers.
 *
 * These used to be a hand-maintained COPY of the shared implementation (the two
 * had to be edited in lockstep). Now that truncation is field-level there is no
 * preview scraping left to duplicate, so this module re-exports the shared
 * versions and the drift risk is gone.
 *
 * `isTruncated` recognizes a truncated LEAF. To ask whether a whole payload
 * contains truncated data, use `hasTruncatedLeaf` — after field-level projection
 * an object payload's ROOT is a plain object, so a root probe reports false.
 */
export {
	extractField,
	extractNumericField,
	isTruncated,
	resolveDisplayText,
} from "@shared/pretext-layout/tool-detail";
export {
	collectTruncatedLeaves,
	hasTruncatedLeaf,
	readLeafText,
	stringifyForDisplay,
} from "@shared/pretext-layout/tool-io-projection";

// Local aliases so the summary builders below can call these directly (a
// re-export does not bind the names in this module's scope).
import { extractField, extractNumericField, isTruncated } from "@shared/pretext-layout/tool-detail";
import { readLeafText } from "@shared/pretext-layout/tool-io-projection";
import {
	hasSubagentToolInputSummary,
	type SubagentToolInputSummary,
	subagentSummaryToPartialInput,
} from "@shared/subagent-tool-summary";
import { agentTargetDisplay, formatAgentIdForDisplay } from "./agent-id-display";

/**
 * The `task.name` field of a ScheduledTask call, if the nested object survived
 * field-level projection. Returns "" when the payload is truncated at any level —
 * the caller then falls back to the task id.
 */
function readTaskFieldName(input: unknown): string {
	if (!input || isTruncated(input) || typeof input !== "object") return "";
	const task = (input as Record<string, unknown>).task;
	if (!task || isTruncated(task) || typeof task !== "object") return "";
	return readLeafText((task as Record<string, unknown>).name) ?? "";
}

function extractStringArrayField(val: unknown, key: string): string[] {
	if (!val || isTruncated(val) || typeof val !== "object") return [];
	const raw = (val as Record<string, unknown>)[key];
	return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

/** True when `value` is the cumulative-char payload ContextAsk streams via emitOutput. */
function isNumericOutputString(value: unknown): value is string {
	return typeof value === "string" && /^\d+$/.test(value.trim());
}

/**
 * Live character count for a running ContextAsk, or null.
 *
 * The tool reuses `tool_output` to stream a bare cumulative count (see
 * context-ask.ts `onProgress`); the reader wants that as a counter, not as a
 * streaming body of digits.
 */
function contextAskLiveOutputChars(metadata: Record<string, unknown> | undefined): number | null {
	const raw = metadata?._streamingOutput;
	if (!isNumericOutputString(raw)) return null;
	const n = Number(raw.trim());
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Resolved target label for a ContextAsk call (metadata title wins over input.id). */
function contextAskTargetLabel(
	input: unknown,
	metadata: Record<string, unknown> | undefined,
): string {
	const target = metadata?.target;
	const title =
		target && typeof target === "object" && !isTruncated(target)
			? readLeafText((target as Record<string, unknown>).title)
			: undefined;
	return agentTargetDisplay(title, extractField(input, "id"));
}

/** Question count for a ContextAsk call, or null when the input is a status summary. */
function contextAskQuestionCount(
	input: unknown,
	metadata: Record<string, unknown> | undefined,
): number | null {
	const fromMeta = Array.isArray(metadata?.questions) ? metadata.questions.length : undefined;
	const fromInput = extractStringArrayField(input, "questions").length;
	const count = fromMeta ?? (fromInput > 0 ? fromInput : undefined);
	return count != null && count > 0 ? count : null;
}

export function getFilePath(input: unknown): string {
	return extractField(input, "file_path", "filePath", "path");
}

function short(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

/**
 * Header summary for the knowledge-base tool family. Shared by every renderer
 * (ToolCallCard and the vlist) so they show the same one-line label.
 * Reads from input first, then falls back to persisted metadata
 * (outputJson._metadata) for fields like the resolved entry title.
 */
export function knowledgeSummary(
	toolName: string,
	input: unknown,
	metadata?: Record<string, unknown>,
): string {
	const meta = metadata ?? {};
	switch (toolName) {
		case "KnowledgeSearch": {
			const q = extractField(input, "query") || (meta.query as string) || "";
			const count = typeof meta.resultCount === "number" ? meta.resultCount : undefined;
			if (q) return count != null ? `${short(q, 48)} · ${count}` : short(q, 60);
			return count != null ? `${count} results` : "Search";
		}
		case "KnowledgeRead": {
			const title = (meta.title as string) || extractField(input, "entryId");
			return title ? short(title, 60) : "Read entry";
		}
		case "KnowledgeCreate": {
			const title = extractField(input, "title") || (meta.title as string) || "";
			const direct = meta.direct === true;
			if (title) return direct ? `${short(title, 52)} · global` : short(title, 60);
			return "Create entry";
		}
		case "KnowledgeEdit": {
			const action = extractField(input, "action") || (meta.action as string) || "edit";
			const target =
				extractField(input, "entryId") ||
				extractField(input, "personalEntryId") ||
				(meta.entryId as string) ||
				(meta.personalEntryId as string) ||
				"";
			return target ? `${action} · ${short(target, 16)}` : action;
		}
		case "KnowledgeReview": {
			const action = extractField(input, "action") || (meta.action as string) || "review";
			const sub = extractField(input, "submissionId") || (meta.submissionId as string) || "";
			return sub ? `${action} · ${short(sub, 16)}` : action;
		}
		case "KnowledgeLibrary": {
			const action = extractField(input, "action") || (meta.action as string) || "list";
			const count = typeof meta.count === "number" ? meta.count : undefined;
			return count != null ? `${action} · ${count}` : action;
		}
		case "KnowledgeAdmin": {
			const action = extractField(input, "action") || (meta.action as string) || "admin";
			return action;
		}
		default:
			return toolName;
	}
}

/** Only routing fields belong in a collapsed notification row, never its message body. */
function notificationSummary(input: unknown): string {
	const action = extractField(input, "action");
	const target = extractField(input, "user_id") || extractField(input, "username");
	const channels = extractStringArrayField(input, "channels");
	const routingChannels = channels.filter((value) => value === "dingtalk" || value === "feishu");
	return short(
		[
			action === "list_channels" || action === "send" ? action : "Notification",
			target ? `→ ${short(target, 40)}` : "",
			...(routingChannels.length > 0
				? new Set(routingChannels)
				: action === "send"
					? ["available channels"]
					: []),
		]
			.filter(Boolean)
			.join(" · "),
		100,
	);
}

export function getSummary(
	toolName: string,
	input: unknown,
	metadata?: Record<string, unknown>,
	labels?: Record<string, string>,
): string {
	// Keep the existing generic category/icon and detail renderer. Notification is not
	// inter-agent Send: sharing its category would render the wrong communication card.
	if (toolName === "Notification") {
		const fields =
			input && typeof input === "object"
				? (input as Record<string, unknown>)._streamingFields
				: undefined;
		return notificationSummary(fields && typeof fields === "object" ? fields : input);
	}
	if (
		typeof input === "object" &&
		input &&
		(input as Record<string, unknown>)._streamingChars != null
	) {
		const fields = (input as Record<string, unknown>)._streamingFields as
			| Record<string, string>
			| undefined;
		const filePath = (input as Record<string, unknown>)._streamingFilePath as string | undefined;
		const chars = Number((input as Record<string, unknown>)._streamingChars) || 0;
		if (fields && (toolName === "Agent" || toolName === "Task")) {
			const parts = [fields.subagent_type, fields.description].filter(Boolean);
			if (parts.length > 0) return parts.join(": ");
		}
		if (toolName === "Edit") {
			const streamingFieldName = (input as Record<string, unknown>)._streamingFieldName;
			const phase =
				streamingFieldName === "new_string" || fields?.new_string ? "replacing" : "matching";
			return `${phase} ${filePath ? basename(filePath) : "Edit"}`;
		}
		if (filePath) return `${basename(filePath)} (${chars} chars)`;
		return chars > 0 ? `${chars} chars` : "";
	}
	const cat = getCategory(toolName, input);
	switch (cat) {
		case "workspace":
			return short(workspaceSummary(toolName, input, labels), 80);
		case "read": {
			const fp = getFilePath(input);
			if (!fp) return "";
			const base = basename(fp);
			const offset = extractNumericField(input, "offset");
			const limit = extractNumericField(input, "limit");
			const totalLines = typeof metadata?.totalLines === "number" ? metadata.totalLines : undefined;
			if (limit === -1) return `${base} (read_all)`;
			if (offset != null && limit != null) return `${base} (${offset}~${offset + limit - 1})`;
			if (offset != null) return `${base} (${offset}~)`;
			if (limit != null) return `${base} (1~${limit})`;
			if (totalLines != null) return `${base} (${totalLines}L)`;
			return base;
		}
		case "file": {
			const fp = getFilePath(input);
			return fp ? basename(fp) : "";
		}
		case "bash": {
			const desc = extractField(input, "description");
			if (desc) return short(desc, 80);
			const cmd = extractField(input, "command");
			return cmd ? short(cmd, 80) : toolName;
		}
		case "search": {
			const pat = extractField(input, "pattern", "glob");
			const searchPath = extractField(input, "path");
			if (!pat && !searchPath) return toolName;
			return short(`${pat || toolName}${searchPath ? ` in ${basename(searchPath)}` : ""}`, 60);
		}
		case "structure": {
			const fp = getFilePath(input);
			const base = fp ? basename(fp) : "";
			// Absent `mode` means the tool's own default, so the row reads the same before
			// and after the argument finishes streaming instead of changing under the reader.
			const mode = extractField(input, "mode") || "outline";
			if (!base) return toolName;
			switch (mode) {
				case "extract": {
					const symbol = extractField(input, "symbol");
					return symbol ? short(`${base} › ${symbol}`, 60) : `${base} · extract`;
				}
				case "enclosing": {
					const position = extractField(input, "position");
					return position ? `${base}:${position}` : `${base} · enclosing`;
				}
				case "print": {
					const address = extractField(input, "address");
					return address ? short(`${base} · ${address}`, 60) : `${base} · print`;
				}
				default:
					return short(`${base} · ${mode}`, 60);
			}
		}
		case "structureEdit": {
			const fp = getFilePath(input);
			const base = fp ? basename(fp) : "";
			if (!base) return toolName;
			// The command is the load-bearing word here: a reader must be able to tell a
			// delete from an insert without expanding the card. No default is substituted —
			// unlike StructView's `mode`, `command` is required, so an absent one means the
			// argument is still streaming and inventing "replace" would misreport it.
			const command = extractField(input, "command");
			// Whichever address form was used; they are mutually exclusive.
			const target = extractField(input, "symbol") || extractField(input, "address");
			if (!command) return base;
			return short(target ? `${base} · ${command} ${target}` : `${base} · ${command}`, 60);
		}
		case "webSearch": {
			const q = extractField(input, "query");
			return q ? short(q, 60) : "Web Search";
		}
		case "webFetch": {
			const url = extractField(input, "url");
			const mode = extractField(input, "mode");
			if (!url) return mode || "WebFetch";
			return mode ? `${mode}: ${short(url, 50)}` : short(url, 50);
		}
		case "tasks":
			return toolName === "Read" ? "Read tasks" : "Update tasks";
		case "taskOutput": {
			const taskId = extractField(input, "task_id");
			return taskId ? `Check ${taskId}` : "Check task output";
		}
		case "agent": {
			const parts = [
				extractField(input, "subagent_type"),
				extractField(input, "description"),
			].filter(Boolean);
			return parts.length > 0 ? parts.join(": ") : toolName;
		}
		case "await": {
			const awaitType = extractField(input, "type") || "task";
			// Prefer the server-resolved alias; a bare nanoid selector is truncated.
			const id =
				agentTargetDisplay(
					metadata?.targetLabel as string | undefined,
					extractField(input, "id"),
				) || "unknown";
			const waitForText = extractField(input, "wait_for_text");
			return waitForText
				? `${awaitType}: ${id} · wait "${short(waitForText, 24)}"`
				: `${awaitType}: ${id}`;
		}
		case "send": {
			const selectors = communicationSelectors(input);
			const targets = resolveCommunicationTargets(metadata, metadata?._sendDeliveryTargets);
			const targetLabels =
				Array.isArray(metadata?.targets) || targets.length
					? targets.map(communicationTargetLabel)
					: selectors.map((target) => formatAgentIdForDisplay(target));
			const targetLabel = targetLabels.length > 0 ? targetLabels.join(", ") : "subagent";
			const obj =
				!isTruncated(input) && typeof input === "object" && input
					? (input as Record<string, unknown>)
					: undefined;
			const state = deriveCommunicationState({
				targets,
				targetCount: metadata?.targetCount,
				selectorCount: Array.isArray(metadata?.targets) ? 0 : selectors.length,
				awaitReply: typeof obj?.await === "boolean" ? obj.await : metadata?.await === true,
				status: typeof metadata?.status === "string" ? metadata.status : undefined,
			});
			const flags = [formatCommunicationState(state, labels)];
			if (obj?.doInterrupt || metadata?.doInterrupt) flags.push("interrupt");
			return `to ${targetLabel} · ${flags.join(" · ")}`;
		}
		case "ask": {
			// Field-level projection keeps the `questions` array intact (the schema
			// allows at most 4, far under the element guard), so the first header is a
			// direct read — the old `_hints._firstHeader` projection is gone.
			if (typeof input === "object" && input) {
				const questions = (input as Record<string, unknown>).questions;
				if (Array.isArray(questions) && questions[0] && typeof questions[0] === "object") {
					const header = (questions[0] as Record<string, unknown>).header;
					return readLeafText(header) ?? "Question";
				}
			}
			return "Question";
		}
		case "plan":
			return toolName === "ExitPlanMode" ? "Plan ready" : "Enter plan mode";
		case "pipeline": {
			if (toolName === "StartPipeline") {
				const label = extractField(input, "label");
				const maxPreview = extractNumericField(input, "maxPreviewChars");
				const suffix = maxPreview != null ? ` · preview≤${maxPreview}` : "";
				return label ? `start: ${short(label, 60)}${suffix}` : `start capture${suffix}`;
			}
			const rule = extractField(input, "rule");
			if (rule) return short(rule, 80);
			const aliases = extractStringArrayField(input, "aliases");
			if (aliases.length > 0) return `aliases ${aliases.join(", ")}`;
			return toolName === "ExtractPipeline" ? "extract pipeline" : "finish pipeline";
		}
		case "terminal": {
			const action = extractField(input, "action");
			const tid = extractField(input, "terminal_id");
			if (action === "list") return "List terminals";
			if (action === "read") return tid ? `Read ${tid.slice(0, 8)}…` : "Read";
			if (action === "write") return short(extractField(input, "input") || "Write", 50);
			return action || "Terminal";
		}
		case "share": {
			const fp = getFilePath(input);
			return fp ? basename(fp) : "Share";
		}
		case "transfer": {
			const direction = extractField(input, "direction");
			const remotePath = extractField(input, "remotePath");
			const localPath = extractField(input, "localPath");
			// The device NAME comes from metadata: the input only carries the nanoid,
			// which tells the reader nothing. Falls back to nothing rather than to the
			// id — a bare `SXz3MqJ…` in the header is noise, and the detail card shows
			// the resolved name anyway.
			const deviceName = readLeafText(metadata?.deviceName);
			// Name the file being moved, not the source: for both directions the
			// interesting basename is the same one, and remotePath is the side the
			// user typically named explicitly.
			const name = remotePath ? basename(remotePath) : localPath ? basename(localPath) : "";
			const arrow = direction === "upload" ? "→" : "←";
			if (!name) return deviceName ? `${arrow} ${deviceName}` : direction || "Transfer";
			return short(deviceName ? `${name} ${arrow} ${deviceName}` : name, 60);
		}
		case "skill": {
			const skillName = extractField(input, "skill", "name");
			const skillArgs = extractField(input, "args");
			if (!skillName) return "Skill";
			return skillArgs ? short(`${skillName}: ${skillArgs}`, 60) : skillName;
		}
		case "recall": {
			const action = extractField(input, "action");
			if (action === "search") return short(extractField(input, "query") || "Search", 60);
			return action || "Recall";
		}
		case "browser": {
			const action = extractField(input, "action");
			const url = extractField(input, "url");
			const selector = extractField(input, "selector");
			if (url) return `${action || "Browser"}: ${short(url, 45)}`;
			if (selector) return `${action || "Browser"}: ${short(selector, 40)}`;
			return action || "Browser";
		}
		case "knowledge":
			return knowledgeSummary(toolName, input, metadata);
		case "contextAsk": {
			const target = contextAskTargetLabel(input, metadata);
			const questionCount = contextAskQuestionCount(input, metadata);
			const liveChars = contextAskLiveOutputChars(metadata);
			const parts: string[] = [];
			if (target) parts.push(target);
			// Live char count beats the static question tally: the reader scanning a
			// running card cares that the answer is growing, not how many questions
			// were already visible in the header a second ago.
			if (liveChars != null) {
				parts.push(
					labels?.contextAskOutputChars
						? labels.contextAskOutputChars.replace("{count}", String(liveChars))
						: `${liveChars} chars`,
				);
			} else if (questionCount != null) {
				parts.push(
					labels?.contextAskQuestions
						? labels.contextAskQuestions.replace("{count}", String(questionCount))
						: `${questionCount} questions`,
				);
			} else {
				parts.push(labels?.contextAskStatusSummary ?? "status summary");
			}
			// Never fall through to `toolName` — that is what produced
			// `ContextAsk · ContextAsk` in the folded row.
			return parts.join(" · ");
		}
		case "schedule": {
			const action = extractField(input, "action");
			// The task NAME is the only useful identifier here; a bare nanoid id tells the
			// reader nothing. `create`/`update` carry it in `task.name`, the id-based actions
			// do not, so those fall back to a short id rather than showing nothing.
			const taskName = readTaskFieldName(input);
			const taskId = extractField(input, "id");
			const label = taskName || (taskId ? `${taskId.slice(0, 8)}…` : "");
			if (!action) return label ? `Schedule: ${label}` : "Schedule";
			return label ? short(`${action}: ${label}`, 60) : action;
		}
		default:
			return toolName;
	}
}

/** Row titles are capped so one long summary cannot dominate a fold. */
export const TRACE_ROW_TITLE_MAX_CHARS = 80;

/** `Tool · summary` for a compact row, truncated to {@link TRACE_ROW_TITLE_MAX_CHARS}. */
export function traceRowTitle(toolName: string, summary: string | null | undefined): string {
	// `Task` is the wire name; every surface shows the friendlier "Agent".
	const name = toolName === "Task" ? "Agent" : toolName;
	const text = summary ? `${name} · ${summary}` : name;
	return text.length > TRACE_ROW_TITLE_MAX_CHARS
		? `${text.slice(0, TRACE_ROW_TITLE_MAX_CHARS - 3)}…`
		: text;
}

/**
 * Row label detail for ONE subagent recent-call header: `Bash` → its
 * `description`, `Read` → the file's basename, `Await` → `type: id`.
 *
 * Formatting is delegated to {@link getSummary}, the SAME formatter the expanded
 * tool card uses, so a row and its card cannot word one call differently. It is
 * fed a PARTIAL input rebuilt from the whitelisted keys the server projected
 * (`input_json` itself never reaches the client for these rows — see
 * shared/subagent-tool-summary.ts); verified to degrade cleanly, e.g. a `Read`
 * carrying only `file_path` yields `component.tsx` with no phantom line range.
 *
 * Returns null when there is nothing extra to say, which keeps a row from reading
 * `Bash · Bash`: `getSummary` answers with a placeholder rather than an empty
 * string for an input it cannot label (`Bash` → "Bash", `Await` →
 * "task: unknown"), so a summary equal to the tool name — or to that Await
 * placeholder — counts as "no detail".
 *
 * Lives here, beside `getSummary`, because BOTH render paths need it: the chunked
 * `SubagentActivityRow` and the vlist adapter (through a resolver the shell
 * injects). A copy in either would let the two rows drift.
 */
export function subagentRecentCallSummary(
	toolName: string,
	inputSummary: SubagentToolInputSummary | null | undefined,
): string | null {
	if (!hasSubagentToolInputSummary(inputSummary)) return null;
	const text = getSummary(toolName, subagentSummaryToPartialInput(inputSummary)).trim();
	if (!text || text === toolName) return null;
	if (text === "task: unknown") return null;
	return text;
}
