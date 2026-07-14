import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorToolCalls } from "../db/schema";

const RECENT_ACTIVITY_LIMIT = 3;
const MAX_ACTIVITY_ROWS = 5;
const DB_FIELD_LIMIT = 160;
const DISPLAY_SUMMARY_LIMIT = 96;

export interface SubagentToolActivity {
	at: string;
	toolName: string;
	status: string;
	summary?: string;
}

export interface SubagentToolActivityHints {
	description?: unknown;
	filePath?: unknown;
	path?: unknown;
	pattern?: unknown;
	query?: unknown;
	url?: unknown;
	mode?: unknown;
	action?: unknown;
	targetId?: unknown;
	targetName?: unknown;
	awaitType?: unknown;
	subagentType?: unknown;
	skillName?: unknown;
	device?: unknown;
	direction?: unknown;
	localPath?: unknown;
	remotePath?: unknown;
	questionHeader?: unknown;
	resourceId?: unknown;
}

function boundedJsonText(path: string) {
	return sql<string | null>`CASE
		WHEN json_valid(${narratorToolCalls.inputJson})
		THEN substr(CAST(json_extract(${narratorToolCalls.inputJson}, ${path}) AS TEXT), 1, ${DB_FIELD_LIMIT})
		ELSE NULL
	END`;
}

function asCompactText(value: unknown, maxLength = DISPLAY_SUMMARY_LIMIT): string {
	if (value === null || value === undefined) return "";
	const normalized = String(value).replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function basename(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1] || path;
}

function compactPath(value: unknown): string {
	const path = asCompactText(value, DB_FIELD_LIMIT);
	return path ? asCompactText(basename(path)) : "";
}

function joinParts(...parts: Array<string | undefined>): string | undefined {
	const text = parts.filter((part): part is string => !!part).join(": ");
	return text ? asCompactText(text) : undefined;
}

/**
 * Build a deliberately small, non-sensitive description of a tool call.
 * Long fields such as command, prompt, message, content, old_string/new_string,
 * rule, and tool output are never accepted by this formatter or selected by the query.
 */
export function summarizeSubagentToolCall(
	toolName: string,
	hints: SubagentToolActivityHints,
): string | undefined {
	const description = asCompactText(hints.description);
	const filePath = compactPath(hints.filePath || hints.path);
	const searchPath = compactPath(hints.path);
	const pattern = asCompactText(hints.pattern, 64);
	const query = asCompactText(hints.query);
	const url = asCompactText(hints.url, 72);
	const mode = asCompactText(hints.mode, 24);
	const action = asCompactText(hints.action, 32);
	const target = asCompactText(hints.targetId || hints.targetName, 48);
	const resourceId = asCompactText(hints.resourceId, 48);

	switch (toolName) {
		case "Bash":
			return description || undefined;
		case "Read":
		case "Write":
		case "Edit":
			return filePath || undefined;
		case "Grep":
		case "Glob":
			return joinParts(pattern || undefined, searchPath ? `in ${searchPath}` : undefined);
		case "WebSearch":
			return query || undefined;
		case "WebFetch":
			return joinParts(mode || undefined, url || undefined);
		case "Agent":
		case "Task":
			return joinParts(
				asCompactText(hints.subagentType, 24) || undefined,
				description || undefined,
			);
		case "Await":
			return joinParts(asCompactText(hints.awaitType, 16) || "agent", target || undefined);
		case "Send":
			return target ? `to ${target}` : undefined;
		case "Skill":
			return asCompactText(hints.skillName, 48) || undefined;
		case "Browser":
			return joinParts(action || undefined, url || undefined);
		case "KnowledgeSearch":
			return query || undefined;
		case "KnowledgeRead":
		case "KnowledgeCreate":
		case "KnowledgeEdit":
		case "KnowledgeReview":
		case "KnowledgeAdmin":
			return joinParts(action || undefined, resourceId || undefined);
		case "AskUserQuestion":
			return asCompactText(hints.questionHeader) || undefined;
		case "ShareFile":
			return filePath || undefined;
		case "SwitchDevice":
			return asCompactText(hints.device, 48) || undefined;
		case "TransferFile": {
			const transferPath = compactPath(hints.remotePath || hints.localPath);
			return joinParts(asCompactText(hints.direction, 16) || undefined, transferPath || undefined);
		}
		default:
			return action || description || undefined;
	}
}

function selectActivityTimestamp(row: {
	createdAt: string;
	streamStartedAt: string | null;
	permissionStartedAt: string | null;
	executionStartedAt: string | null;
	completedAt: string | null;
}): string {
	return (
		row.completedAt ??
		row.executionStartedAt ??
		row.permissionStartedAt ??
		row.streamStartedAt ??
		row.createdAt
	);
}

export async function getRecentSubagentToolActivity(
	narratorId: string,
	limit = RECENT_ACTIVITY_LIMIT,
): Promise<SubagentToolActivity[]> {
	const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_ACTIVITY_ROWS);
	const rows = await db
		.select({
			toolName: narratorToolCalls.toolName,
			status: narratorToolCalls.status,
			createdAt: narratorToolCalls.createdAt,
			streamStartedAt: narratorToolCalls.streamStartedAt,
			permissionStartedAt: narratorToolCalls.permissionStartedAt,
			executionStartedAt: narratorToolCalls.executionStartedAt,
			completedAt: narratorToolCalls.completedAt,
			description: boundedJsonText("$.description"),
			filePath: boundedJsonText("$.file_path"),
			path: boundedJsonText("$.path"),
			pattern: boundedJsonText("$.pattern"),
			query: boundedJsonText("$.query"),
			url: boundedJsonText("$.url"),
			mode: boundedJsonText("$.mode"),
			action: boundedJsonText("$.action"),
			targetId: boundedJsonText("$.id"),
			targetName: boundedJsonText("$.name"),
			awaitType: boundedJsonText("$.type"),
			subagentType: boundedJsonText("$.subagent_type"),
			skillName: boundedJsonText("$.skill"),
			device: boundedJsonText("$.device"),
			direction: boundedJsonText("$.direction"),
			localPath: boundedJsonText("$.localPath"),
			remotePath: boundedJsonText("$.remotePath"),
			questionHeader: boundedJsonText("$.questions[0].header"),
			resourceId: boundedJsonText("$.entryId"),
		})
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.narratorId, narratorId))
		.orderBy(desc(narratorToolCalls.createdAt))
		.limit(boundedLimit);

	return rows.map((row) => ({
		at: selectActivityTimestamp(row),
		toolName: row.toolName,
		status: row.status,
		summary: summarizeSubagentToolCall(row.toolName, row),
	}));
}

function formatRelativeAge(timestamp: string, nowMs: number): string {
	const timestampMs = Date.parse(timestamp);
	if (!Number.isFinite(timestampMs)) return "time unknown";
	const elapsedMs = Math.max(0, nowMs - timestampMs);
	const seconds = Math.floor(elapsedMs / 1000);
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function formatActivityStatus(status: string): string {
	switch (status) {
		case "initializing":
			return "preparing";
		case "pending":
			return "awaiting permission";
		case "success":
			return "completed";
		case "fail":
			return "failed";
		default:
			return status;
	}
}

export function formatRecentSubagentActivity(
	activities: SubagentToolActivity[],
	nowMs = Date.now(),
): string {
	if (activities.length === 0) {
		return (
			"Recent subagent activity: no tool calls have been recorded yet; " +
			"the subagent may still be reasoning."
		);
	}

	const lines = activities.map((activity) => {
		const parsed = Date.parse(activity.at);
		const timestamp = Number.isFinite(parsed) ? new Date(parsed).toISOString() : activity.at;
		const summary = activity.summary ? `: ${asCompactText(activity.summary)}` : "";
		return (
			`- ${timestamp} (${formatRelativeAge(activity.at, nowMs)}) — ${activity.toolName} ` +
			`[${formatActivityStatus(activity.status)}]${summary}`
		);
	});
	return `Recent subagent activity (UTC):\n${lines.join("\n")}`;
}
