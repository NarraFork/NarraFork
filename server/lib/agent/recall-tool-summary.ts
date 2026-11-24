import { isBashToolName } from "./tool-name";

function basename(p: string): string {
	const parts = p.split("/");
	return parts[parts.length - 1] || p;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
function extractStr(obj: any, ...keys: string[]): string {
	if (!obj || typeof obj !== "object") return "";
	for (const k of keys) {
		if (typeof obj[k] === "string") return obj[k];
	}
	return "";
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Glob"]);

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
export function getToolCallSummary(toolName: string, inputJson: any): string {
	if (!inputJson || typeof inputJson !== "object") return toolName;

	if (FILE_TOOLS.has(toolName)) {
		const fp = extractStr(inputJson, "file_path", "filePath", "path", "pattern");
		return fp ? basename(fp) : toolName;
	}
	// Legacy "Shell" rows from older Windows installs summarize the same way.
	if (isBashToolName(toolName)) {
		const cmd = extractStr(inputJson, "command");
		if (!cmd) return toolName;
		return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
	}
	if (toolName === "Grep") {
		const pat = extractStr(inputJson, "pattern");
		return pat ? (pat.length > 60 ? `${pat.slice(0, 57)}...` : pat) : toolName;
	}
	if (toolName === "WebSearch") {
		const q = extractStr(inputJson, "query");
		return q ? (q.length > 60 ? `${q.slice(0, 57)}...` : q) : "Web Search";
	}
	if (toolName === "WebFetch") {
		const url = extractStr(inputJson, "url");
		const mode = extractStr(inputJson, "mode");
		if (!url) return mode || "WebFetch";
		const short = url.length > 50 ? `${url.slice(0, 47)}...` : url;
		return mode ? `${mode}: ${short}` : short;
	}
	if (toolName === "Agent" || toolName === "Send") {
		return extractStr(inputJson, "description", "prompt", "message").slice(0, 60) || toolName;
	}
	if (toolName === "Terminal") {
		const action = extractStr(inputJson, "action");
		return action || "Terminal";
	}
	if (toolName === "ShareFile") {
		const fp = extractStr(inputJson, "path");
		return fp ? basename(fp) : "Share";
	}
	if (toolName === "AskUserQuestion") {
		const qs = inputJson.questions;
		if (Array.isArray(qs) && qs.length > 0) {
			return extractStr(qs[0], "header") || "Question";
		}
		return "Question";
	}
	if (toolName === "TaskCreate") return "Update todos";
	if (toolName === "EnterPlanMode") return "Enter plan mode";
	if (toolName === "ExitPlanMode") return "Plan ready";
	return toolName;
}
