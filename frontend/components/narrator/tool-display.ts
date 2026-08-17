export type ToolCategory =
	| "read"
	| "file"
	| "bash"
	| "search"
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
	| "recall"
	| "skill"
	| "browser"
	| "knowledge"
	| "generic";

const READ_TOOLS = new Set(["Read"]);
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);
const BASH_TOOLS = new Set(["Bash", "Shell", "Execute"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Find"]);
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
const RECALL_TOOLS = new Set(["Recall"]);
const SKILL_TOOLS = new Set(["Skill"]);
const BROWSER_TOOLS = new Set(["Browser"]);
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
	if (RECALL_TOOLS.has(name)) return "recall";
	if (SKILL_TOOLS.has(name)) return "skill";
	if (BROWSER_TOOLS.has(name)) return "browser";
	if (KNOWLEDGE_TOOLS.has(name)) return "knowledge";
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
		case "webSearch":
		case "webFetch":
		case "browser":
			return "teal";
		case "tasks":
			return "teal";
		case "share":
			return "green";
		case "taskOutput":
		case "await":
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

function extractStringArrayField(val: unknown, key: string): string[] {
	if (!val || isTruncated(val) || typeof val !== "object") return [];
	const raw = (val as Record<string, unknown>)[key];
	return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

export function getFilePath(input: unknown): string {
	return extractField(input, "file_path", "filePath", "path");
}

function getSendTargetLabels(input: unknown): string[] {
	if (!input || isTruncated(input) || typeof input !== "object") return [];
	const obj = input as Record<string, unknown>;
	const labels: string[] = [];
	const push = (value: unknown) => {
		if (typeof value === "string" && value.trim()) labels.push(value.trim());
	};
	push(obj.id);
	push(obj.name);
	if (Array.isArray(obj.ids)) obj.ids.forEach(push);
	if (Array.isArray(obj.names)) obj.names.forEach(push);
	return [...new Set(labels)];
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

export function getSummary(
	toolName: string,
	input: unknown,
	metadata?: Record<string, unknown>,
): string {
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
			const targets = getSendTargetLabels(input).map((target) => formatAgentIdForDisplay(target));
			const targetLabel = targets.length === 1 ? targets[0] : `${targets.length} targets`;
			const flags: string[] = [];
			if (!isTruncated(input) && typeof input === "object" && input) {
				const obj = input as Record<string, unknown>;
				if (obj.doInterrupt) flags.push("interrupt");
				if (obj.await) flags.push("await");
			}
			const base = `to ${targetLabel || "subagent"}`;
			return flags.length > 0 ? `${base} · ${flags.join(" · ")}` : base;
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
