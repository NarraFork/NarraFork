export type ToolCategory =
	| "read"
	| "file"
	| "bash"
	| "search"
	| "webSearch"
	| "webFetch"
	| "todo"
	| "goal"
	| "taskOutput"
	| "agent"
	| "await"
	| "send"
	| "ask"
	| "plan"
	| "terminal"
	| "share"
	| "recall"
	| "skill"
	| "browser"
	| "generic";

const READ_TOOLS = new Set(["Read"]);
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);
const BASH_TOOLS = new Set(["Bash", "Shell", "Execute"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Find"]);
const WEB_SEARCH_TOOLS = new Set(["WebSearch"]);
const WEB_FETCH_TOOLS = new Set(["WebFetch"]);
const TODO_TOOLS = new Set(["TaskCreate"]);
const GOAL_TOOLS = new Set(["GetGoals", "AddGoal", "UpdateGoal"]);
const TASK_OUTPUT_TOOLS = new Set(["TaskOutput"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const AWAIT_TOOLS = new Set(["Await"]);
const SEND_TOOLS = new Set(["Send"]);
const ASK_TOOLS = new Set(["AskUserQuestion"]);
const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);
const TERMINAL_TOOLS = new Set(["Terminal"]);
const SHARE_TOOLS = new Set(["ShareFile"]);
const RECALL_TOOLS = new Set(["Recall"]);
const SKILL_TOOLS = new Set(["Skill"]);
const BROWSER_TOOLS = new Set(["Browser"]);

export function getCategory(name: string): ToolCategory {
	if (READ_TOOLS.has(name)) return "read";
	if (FILE_TOOLS.has(name)) return "file";
	if (BASH_TOOLS.has(name)) return "bash";
	if (SEARCH_TOOLS.has(name)) return "search";
	if (WEB_SEARCH_TOOLS.has(name)) return "webSearch";
	if (WEB_FETCH_TOOLS.has(name)) return "webFetch";
	if (TODO_TOOLS.has(name)) return "todo";
	if (GOAL_TOOLS.has(name)) return "goal";
	if (TASK_OUTPUT_TOOLS.has(name)) return "taskOutput";
	if (AGENT_TOOLS.has(name)) return "agent";
	if (AWAIT_TOOLS.has(name)) return "await";
	if (SEND_TOOLS.has(name)) return "send";
	if (ASK_TOOLS.has(name)) return "ask";
	if (PLAN_TOOLS.has(name)) return "plan";
	if (TERMINAL_TOOLS.has(name)) return "terminal";
	if (SHARE_TOOLS.has(name)) return "share";
	if (RECALL_TOOLS.has(name)) return "recall";
	if (SKILL_TOOLS.has(name)) return "skill";
	if (BROWSER_TOOLS.has(name)) return "browser";
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
		case "todo":
			return "teal";
		case "goal":
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

export function isTruncated(val: unknown): val is {
	_truncated: true;
	preview: string;
	fullLength: number;
	_hints?: Record<string, unknown>;
} {
	return (
		typeof val === "object" &&
		val !== null &&
		(val as { _truncated?: unknown })._truncated === true &&
		typeof (val as { preview?: unknown }).preview === "string"
	);
}

export function resolveDisplayText(val: unknown): string {
	if (val === null || val === undefined) return "";
	if (isTruncated(val)) return val.preview;
	if (typeof val === "string") return val;
	if (typeof val === "object" && val && typeof (val as { _text?: unknown })._text === "string") {
		return (val as { _text: string })._text;
	}
	try {
		return JSON.stringify(val, null, 2);
	} catch {
		return String(val);
	}
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractField(val: unknown, ...keys: string[]): string {
	if (!val) return "";
	if (!isTruncated(val)) {
		const obj = typeof val === "object" ? (val as Record<string, unknown>) : null;
		if (!obj) return "";
		for (const k of keys) {
			if (typeof obj[k] === "string") return obj[k];
		}
		return "";
	}
	const hints = val._hints;
	if (hints && typeof hints === "object") {
		for (const k of keys) {
			if (typeof hints[k] === "string") return hints[k];
		}
	}
	for (const k of keys) {
		const re = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
		const m = val.preview.match(re);
		if (m) {
			try {
				return JSON.parse(`"${m[1]}"`);
			} catch {
				return m[1];
			}
		}
		const reTrunc = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`);
		const mt = val.preview.match(reTrunc);
		if (mt) {
			try {
				return JSON.parse(`"${mt[1]}"`);
			} catch {
				return mt[1];
			}
		}
	}
	return "";
}

export function extractNumericField(val: unknown, ...keys: string[]): number | undefined {
	if (!val) return undefined;
	if (!isTruncated(val)) {
		const obj = typeof val === "object" ? (val as Record<string, unknown>) : null;
		if (!obj) return undefined;
		for (const k of keys) {
			if (typeof obj[k] === "number") return obj[k];
		}
		return undefined;
	}
	const hints = val._hints;
	if (hints && typeof hints === "object") {
		for (const k of keys) {
			if (typeof hints[k] === "number") return hints[k];
		}
	}
	for (const k of keys) {
		const re = new RegExp(`"${escapeRegExp(k)}"\\s*:\\s*(\\d+)`);
		const m = val.preview.match(re);
		if (m) return Number(m[1]);
	}
	return undefined;
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
	const cat = getCategory(toolName);
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
		case "todo":
			return "Update todos";
		case "goal": {
			if (toolName === "GetGoals") return "List goals";
			if (toolName === "UpdateGoal") return "Complete active goal";
			const objective = extractField(input, "objective");
			return objective ? short(objective, 80) : toolName;
		}
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
			const id = extractField(input, "id") || "unknown";
			const waitForText = extractField(input, "wait_for_text");
			return waitForText
				? `${awaitType}: ${id} · wait "${short(waitForText, 24)}"`
				: `${awaitType}: ${id}`;
		}
		case "send": {
			const targets = getSendTargetLabels(input);
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
			if (isTruncated(input) && typeof input._hints?._firstHeader === "string") {
				return input._hints._firstHeader;
			}
			if (!isTruncated(input) && typeof input === "object" && input) {
				const questions = (input as Record<string, unknown>).questions;
				if (Array.isArray(questions) && questions[0] && typeof questions[0] === "object") {
					return String((questions[0] as Record<string, unknown>).header ?? "Question");
				}
			}
			return "Question";
		}
		case "plan":
			return toolName === "ExitPlanMode" ? "Plan ready" : "Enter plan mode";
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
		default:
			return toolName;
	}
}
