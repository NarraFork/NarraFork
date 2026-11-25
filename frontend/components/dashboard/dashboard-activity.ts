import {
	normalizeSubagentToolInputSummary,
	projectSubagentToolInputSummary,
	type SubagentToolInputSummary,
} from "@shared/subagent-tool-summary";
import { isLiveToolStatusRegression } from "@shared/tool-row-status";

/** Tool rows a dashboard card keeps; matches the server's activity snapshot size. */
export const ACTIVITY_TOOL_ROWS = 4;
/** Bounded out-of-order lifecycle facts, never rendered as anonymous recent rows. */
export const ACTIVITY_UNMATCHED_TOOL_LIMIT = 32;

export interface ActivityToolRow {
	toolUseId: string;
	toolName: string;
	status: string;
	inputSummary?: SubagentToolInputSummary;
}

/** Live overlay on top of the REST list row; absent fields mean "no news yet". */
export interface NarratorActivity {
	tools: ActivityToolRow[];
	/** Execution may precede a start or follow eviction from the four visible rows. */
	unmatchedToolStatuses?: ReadonlyMap<string, string>;
	status?: string;
	substatus?: string[];
	title?: string;
	activeBackgroundWorkCount?: number;
}

export type ActivityState = ReadonlyMap<string, NarratorActivity>;

export const ACTIVITY_EVENT_TYPES = [
	"activity_snapshot",
	"tool_started",
	"tool_executing",
	"tool_completed",
	"tool_use_discarded",
	"status_change",
	"substatus_change",
	"title_updated",
	"background_task_count_changed",
] as const;

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function upsertTool(tools: ActivityToolRow[], row: ActivityToolRow): ActivityToolRow[] {
	const index = tools.findIndex((tool) => tool.toolUseId === row.toolUseId);
	if (index === -1) return [...tools, row].slice(-ACTIVITY_TOOL_ROWS);
	const next = [...tools];
	next[index] = { ...tools[index], ...row };
	return next;
}

/**
 * Apply one WS frame to the dashboard's activity state.
 *
 * The same reducer serves activity-level frames and full-stream frames: a
 * narrator that is also open in a panel arrives unprojected, so subagent child
 * events are skipped and an input summary is derived here when the server did not
 * send one — the same rule `narrator-activity-projection` applies server-side.
 * Returns the same map when the frame changes nothing.
 */
export function applyActivityEvent(
	state: ActivityState,
	data: Record<string, unknown>,
): ActivityState {
	const narratorId = str(data.narratorId);
	if (!narratorId) return state;
	if (str(data.parentToolUseId)) return state;
	const current: NarratorActivity = state.get(narratorId) ?? { tools: [] };
	let next: NarratorActivity | null = null;

	switch (data.type) {
		case "activity_snapshot": {
			const rows = Array.isArray(data.toolCalls) ? data.toolCalls : [];
			const unmatched = new Map(current.unmatchedToolStatuses);
			next = {
				...current,
				tools: rows
					.flatMap((raw): ActivityToolRow[] => {
						const row = raw as Record<string, unknown>;
						const toolUseId = str(row.toolUseId);
						const toolName = str(row.toolName);
						if (!toolUseId || !toolName) return [];
						const inputSummary = normalizeSubagentToolInputSummary(row.inputSummary);
						const status = str(row.status) ?? "";
						const observedStatus = unmatched.get(toolUseId);
						unmatched.delete(toolUseId);
						return [
							{
								toolUseId,
								toolName,
								status:
									observedStatus && isLiveToolStatusRegression(observedStatus, status)
										? observedStatus
										: status,
								...(inputSummary ? { inputSummary } : {}),
							},
						];
					})
					.slice(-ACTIVITY_TOOL_ROWS),
				unmatchedToolStatuses: unmatched.size ? unmatched : undefined,
			};
			break;
		}
		case "tool_started": {
			const toolUseId = str(data.toolUseId);
			const toolName = str(data.toolName);
			if (!toolUseId || !toolName) return state;
			const inputSummary =
				normalizeSubagentToolInputSummary(data.inputSummary) ??
				projectSubagentToolInputSummary(data.input);
			const existing = current.tools.find((tool) => tool.toolUseId === toolUseId);
			const observedStatus = existing?.status ?? current.unmatchedToolStatuses?.get(toolUseId);
			const unmatched = new Map(current.unmatchedToolStatuses);
			unmatched.delete(toolUseId);
			next = {
				...current,
				unmatchedToolStatuses: unmatched.size ? unmatched : undefined,
				tools: upsertTool(current.tools, {
					toolUseId,
					toolName,
					// Parsed arguments are not execution: only `tool_executing` turns blue.
					// Late starts must not rewind an executing or settled row.
					status:
						observedStatus && isLiveToolStatusRegression(observedStatus, "initializing")
							? observedStatus
							: "initializing",
					...(inputSummary ? { inputSummary } : {}),
				}),
			};
			break;
		}
		case "tool_executing":
		case "tool_completed": {
			const toolUseId = str(data.toolUseId);
			const existing = current.tools.find((tool) => tool.toolUseId === toolUseId);
			if (!toolUseId) return state;
			const status = data.type === "tool_executing" ? "running" : (str(data.status) ?? "");
			if (!existing) {
				const observedStatus = current.unmatchedToolStatuses?.get(toolUseId);
				if (data.type !== "tool_executing" && !observedStatus) return state;
				if (
					observedStatus &&
					(observedStatus === status || isLiveToolStatusRegression(observedStatus, status))
				)
					return state;
				// An unmatched execution might be an early event OR an evicted older
				// call. Neither may append to the visible list or displace newer starts.
				const unmatched = new Map(current.unmatchedToolStatuses);
				unmatched.set(toolUseId, status);
				while (unmatched.size > ACTIVITY_UNMATCHED_TOOL_LIMIT) {
					const oldest = unmatched.keys().next().value;
					if (oldest === undefined) break;
					unmatched.delete(oldest);
				}
				next = { ...current, unmatchedToolStatuses: unmatched };
				break;
			}
			if (status === existing.status || isLiveToolStatusRegression(existing.status, status))
				return state;
			next = { ...current, tools: upsertTool(current.tools, { ...existing, status }) };
			break;
		}
		case "tool_use_discarded": {
			const ids = new Set(strings(data.toolUseIds) ?? []);
			const tools = current.tools.filter((tool) => !ids.has(tool.toolUseId));
			const unmatched = new Map(current.unmatchedToolStatuses);
			for (const id of ids) unmatched.delete(id);
			if (
				tools.length === current.tools.length &&
				unmatched.size === (current.unmatchedToolStatuses?.size ?? 0)
			)
				return state;
			next = { ...current, tools, unmatchedToolStatuses: unmatched.size ? unmatched : undefined };
			break;
		}
		case "status_change":
			next = {
				...current,
				status: str(data.status) ?? current.status,
				substatus: strings(data.substatus) ?? current.substatus,
			};
			break;
		case "substatus_change":
			next = { ...current, substatus: strings(data.substatus) ?? current.substatus };
			break;
		case "title_updated":
			next = { ...current, title: str(data.title) ?? current.title };
			break;
		case "background_task_count_changed": {
			const count =
				typeof data.activeBackgroundWorkCount === "number"
					? data.activeBackgroundWorkCount
					: typeof data.activeBackgroundTaskCount === "number"
						? data.activeBackgroundTaskCount
						: undefined;
			if (count === undefined) return state;
			next = { ...current, activeBackgroundWorkCount: count };
			break;
		}
		default:
			return state;
	}
	const copy = new Map(state);
	copy.set(narratorId, next);
	return copy;
}
