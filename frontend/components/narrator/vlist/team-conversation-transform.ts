/**
 * team-conversation-transform.ts — Team mode of the coordinator conversation: a pure,
 * opt-in rewrite of the render units `buildPretextDocumentLayout` already built.
 *
 *  - Chips (LOD 3 and up): a maximal run of consecutive, settled `Team` calls with the same
 *    action becomes ONE `team-chip` element (「创建工作项 ×7」). Expanded, the chip is followed
 *    by the very tool-run it folded, so the reader gets the ordinary tool cards. A call that is
 *    still running or streaming, or that waits on a permission, never folds: it stays its own
 *    card and splits the run around itself. At L1/L2 the activity trace already shows each call
 *    as one named row, and re-cutting those units would break their hand-off-stable keys.
 *  - Dividers (every LOD): each team event becomes a `team-event` element inserted before the
 *    first unit that started strictly after it (a tie keeps the event after the message). With
 *    older history not loaded yet (`hasPrev`), events before the first loaded unit are left for
 *    the page that holds them.
 *
 * One O(units + events) pass; the default build never calls it. Zero DOM, zero React.
 */

import type { TeamChipLabels, TeamConversationEvent } from "../team-conversation-mode";
import type { TeamChipData, TeamEventData } from "./measure/measure-team-row";
import type { AdapterRenderUnit, ElementSpec } from "./segment-adapter";

/** The tool whose calls fold into chips. */
export const TEAM_TOOL_NAME = "Team";
const STREAMING_MESSAGE_ID = "__streaming__";
const SETTLED_STATUSES = new Set(["success", "fail", "cancelled", "error", "completed"]);
const FAILED_STATUSES = new Set(["fail", "error"]);

export interface TeamConversationLayoutOptions {
	events: readonly TeamConversationEvent[];
	chipLabels: TeamChipLabels;
	/** Changes with events / labels: joins the document revision. */
	revision: string;
	/** More (older) messages exist above the loaded window (set by the coordinator per build). */
	hasPrev?: boolean;
}

export interface TeamConversationTransformContext {
	lod: number;
	isExpanded?: (key: string) => boolean | undefined;
	hasPendingPermission?: (toolUseId: string | undefined) => boolean;
}

type SourceMessage = { id?: string; createdAt?: unknown; seq?: number };
type ToolItem = {
	msg?: SourceMessage | null;
	tc: { toolName?: string; toolUseId?: string; inputJson?: unknown; status?: string | null };
};
type ToolRunSeg = { kind: "tool-run"; items: ToolItem[]; sourceMessages: SourceMessage[] };

export interface TeamConversationTransformResult {
	units: AdapterRenderUnit[];
	/** Source messages of every element this pass minted, by spec key. */
	sources: Map<string, SourceMessage[]>;
}

/** Epoch ms of a server time (ISO, or SQLite's `YYYY-MM-DD HH:MM:SS` in UTC); NaN if none. */
export function parseServerTime(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value !== "string" || !value) return Number.NaN;
	const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value);
	return Date.parse(sqlite ? `${value.replace(" ", "T")}Z` : value);
}

const ACTION_IN_PREVIEW = /"action"\s*:\s*"([^"\\]{1,40})"/;

/**
 * The chip key of one `Team` call's input: its action, with `brief` split into reading and
 * writing (`brief.read` / `brief.write`). A server-truncated input (`{_truncated, preview}`)
 * is read from its preview. Null when the action cannot be read (the call keeps its card).
 */
export function teamChipActionKey(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const record = input as Record<string, unknown>;
	let action = typeof record.action === "string" ? record.action : null;
	if (!action && record._truncated === true && typeof record.preview === "string")
		action = ACTION_IN_PREVIEW.exec(record.preview)?.[1] ?? null;
	if (!action) return null;
	if (action === "brief") {
		const writes =
			typeof record.text === "string" ||
			(record._truncated === true &&
				typeof record.preview === "string" &&
				/"text"\s*:/.test(record.preview));
		return writes ? "brief.write" : "brief.read";
	}
	return action;
}

/** Whether a tool item may fold into a chip, and under which key (null: keep its card). */
export function chipKeyOf(
	item: ToolItem,
	ctx: Pick<TeamConversationTransformContext, "hasPendingPermission">,
): string | null {
	const { tc } = item;
	if (tc.toolName !== TEAM_TOOL_NAME || !tc.toolUseId) return null;
	if (item.msg?.id === STREAMING_MESSAGE_ID) return null;
	if (!tc.status || !SETTLED_STATUSES.has(tc.status)) return null;
	if (ctx.hasPendingPermission?.(tc.toolUseId)) return null;
	return teamChipActionKey(tc.inputJson);
}

/** The id the chip is keyed on (its first call's), stable while later calls join. */
export function teamChipKey(firstToolUseId: string): string {
	return `team-chip-${firstToolUseId}`;
}

export function teamEventKey(eventId: string): string {
	return `team-event-${eventId}`;
}

function chipData(items: readonly ToolItem[], key: string, labels: TeamChipLabels): TeamChipData {
	const label = labels.actions[key] ?? labels.other;
	const count = items.length;
	const countLabel = count > 1 ? ` ${labels.count(count)}` : "";
	const failed = items.filter((item) => FAILED_STATUSES.has(item.tc.status ?? "")).length;
	const failedLabel = failed > 0 ? labels.failed(failed) : "";
	return {
		label,
		count,
		countLabel,
		failed,
		failedLabel,
		status: failed > 0 ? "fail" : "success",
		text: `${label}|${countLabel}|${failedLabel}`,
	};
}

/** Owners of some items, in the segment's own order (mirrors render-units' narrowing). */
function ownersOf(items: readonly ToolItem[], seg: ToolRunSeg): SourceMessage[] {
	const owners = new Set(items.map((item) => item.msg));
	const narrowed = seg.sourceMessages.filter((msg) => owners.has(msg));
	if (narrowed.length > 0) return narrowed;
	return [...owners].filter((msg): msg is SourceMessage => !!msg);
}

interface RunEntry {
	item: ToolItem;
	unit: AdapterRenderUnit & { kind: "segment" };
	seg: ToolRunSeg;
}

/**
 * Re-emit entries as segment units, one per original segment stretch. An untouched whole
 * segment keeps its original unit object.
 */
function emitPlain(entries: readonly RunEntry[], out: AdapterRenderUnit[]): void {
	let index = 0;
	while (index < entries.length) {
		const first = entries[index] as RunEntry;
		let end = index + 1;
		while (end < entries.length && (entries[end] as RunEntry).seg === first.seg) end++;
		const items = entries.slice(index, end).map((entry) => entry.item);
		if (items.length === first.seg.items.length) out.push(first.unit);
		else
			out.push({
				kind: "segment",
				seg: { ...first.seg, items, sourceMessages: ownersOf(items, first.seg) } as never,
			});
		index = end;
	}
}

function foldChips(
	units: readonly AdapterRenderUnit[],
	ctx: TeamConversationTransformContext,
	labels: TeamChipLabels,
	sources: Map<string, SourceMessage[]>,
): AdapterRenderUnit[] {
	const out: AdapterRenderUnit[] = [];
	let run: RunEntry[] = [];
	const flushRun = () => {
		if (run.length === 0) return;
		let index = 0;
		while (index < run.length) {
			const key = chipKeyOf((run[index] as RunEntry).item, ctx);
			let end = index + 1;
			if (key === null) {
				while (end < run.length && chipKeyOf((run[end] as RunEntry).item, ctx) === null) end++;
				emitPlain(run.slice(index, end), out);
				index = end;
				continue;
			}
			while (end < run.length && chipKeyOf((run[end] as RunEntry).item, ctx) === key) end++;
			const group = run.slice(index, end);
			const items = group.map((entry) => entry.item);
			const specKey = teamChipKey(items[0]?.tc.toolUseId as string);
			const expanded = ctx.isExpanded?.(specKey) === true;
			const spec: ElementSpec = {
				kind: "team-chip",
				key: specKey,
				data: chipData(items, key, labels),
				opts: { expanded },
			};
			const owners: SourceMessage[] = [];
			for (const entry of group)
				for (const msg of ownersOf([entry.item], entry.seg))
					if (!owners.includes(msg)) owners.push(msg);
			sources.set(specKey, owners);
			out.push({ kind: "element", spec });
			if (expanded) emitPlain(group, out);
			index = end;
		}
		run = [];
	};
	for (const unit of units) {
		if (unit.kind === "segment" && unit.seg.kind === "tool-run") {
			const seg = unit.seg as unknown as ToolRunSeg;
			for (const item of seg.items) run.push({ item, unit, seg });
			continue;
		}
		flushRun();
		out.push(unit);
	}
	flushRun();
	return out;
}

function unitSources(
	unit: AdapterRenderUnit,
	sources: ReadonlyMap<string, SourceMessage[]>,
): readonly SourceMessage[] {
	if (unit.kind === "activity") return unit.sourceMessages as SourceMessage[];
	if (unit.kind === "element") return sources.get(unit.spec.key) ?? [];
	const seg = unit.seg as unknown as
		| { kind: "message"; msg: SourceMessage }
		| { kind: "tool-run"; sourceMessages: SourceMessage[] };
	return seg.kind === "message" ? [seg.msg] : seg.sourceMessages;
}

/** Start time of a unit; +∞ when unknown, so events pass before it rather than after. */
function unitTime(unit: AdapterRenderUnit, sources: ReadonlyMap<string, SourceMessage[]>): number {
	const time = parseServerTime(unitSources(unit, sources)[0]?.createdAt);
	return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

/**
 * Insert dividers by time. `events` must be ascending by `(at, id)` (the provider sorts once).
 */
export function mergeTeamEvents(
	units: readonly AdapterRenderUnit[],
	events: readonly TeamConversationEvent[],
	hasPrev: boolean,
	sources: Map<string, SourceMessage[]>,
): AdapterRenderUnit[] {
	if (events.length === 0 || units.length === 0) return [...units];
	const first = units[0] as AdapterRenderUnit;
	const floor = hasPrev ? unitTime(first, sources) : Number.NEGATIVE_INFINITY;
	const out: AdapterRenderUnit[] = [];
	let next = 0;
	// Events that belong to a page not loaded yet.
	while (next < events.length && (events[next] as TeamConversationEvent).at < floor) next++;
	const divider = (event: TeamConversationEvent, owner: readonly SourceMessage[]) => {
		const key = teamEventKey(event.id);
		const data: TeamEventData = { text: event.text, tone: event.tone };
		sources.set(key, [...owner]);
		out.push({ kind: "element", spec: { kind: "team-event", key, data } });
	};
	let previous: readonly SourceMessage[] = unitSources(first, sources);
	for (const unit of units) {
		const time = unitTime(unit, sources);
		while (next < events.length && (events[next] as TeamConversationEvent).at < time) {
			divider(events[next] as TeamConversationEvent, previous);
			next++;
		}
		out.push(unit);
		const own = unitSources(unit, sources);
		if (own.length > 0) previous = own;
	}
	while (next < events.length) {
		divider(events[next] as TeamConversationEvent, previous);
		next++;
	}
	return out;
}

/** Chips, then dividers. */
export function applyTeamConversationMode(
	units: readonly AdapterRenderUnit[],
	options: TeamConversationLayoutOptions,
	ctx: TeamConversationTransformContext,
): TeamConversationTransformResult {
	const sources = new Map<string, SourceMessage[]>();
	const chipped = ctx.lod >= 3 ? foldChips(units, ctx, options.chipLabels, sources) : [...units];
	return {
		units: mergeTeamEvents(chipped, options.events, options.hasPrev === true, sources),
		sources,
	};
}
