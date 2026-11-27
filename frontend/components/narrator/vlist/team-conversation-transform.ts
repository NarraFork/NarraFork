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

import { teamToolActionKey } from "@shared/team-tool-actions";
import {
	IN_FLIGHT_TOOL_ROW_STATUSES,
	resolveToolRowStatusMark,
	TERMINAL_TOOL_ROW_STATUSES,
} from "@shared/tool-row-status";
import type { TeamChipLabels, TeamConversationEvent } from "../team-conversation-mode";
import type { TeamChipData, TeamEventData } from "./measure/measure-team-row";
import type { AdapterRenderUnit, ElementSpec } from "./segment-adapter";

/** The tool whose calls fold into chips. */
export const TEAM_TOOL_NAME = "Team";
const STREAMING_MESSAGE_ID = "__streaming__";

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

/** The suffix team mode adds to the manifest's `documentRevision` (see `measureRevisionOf`). */
export const TEAM_REVISION_MARK = "~team:";

/**
 * The revision measurements are cached under: the manifest's `documentRevision` without team
 * mode's `~team:<rev>` suffix. That suffix moves the manifest identity when a divider arrives (a
 * fold capture must not survive it), but every other row measures exactly as before, so a
 * resize preview or rebuild must reuse their cached heights rather than re-measure the page.
 */
export function measureRevisionOf(revision: string | number): string | number {
	if (typeof revision !== "string") return revision;
	const at = revision.lastIndexOf(TEAM_REVISION_MARK);
	return at < 0 ? revision : revision.slice(0, at);
}

/** Epoch ms of a server time (ISO, or SQLite's `YYYY-MM-DD HH:MM:SS` in UTC); NaN if none. */
export function parseServerTime(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value !== "string" || !value) return Number.NaN;
	const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value);
	return Date.parse(sqlite ? `${value.replace(" ", "T")}Z` : value);
}

/** The chip key of one `Team` call's input (see `@shared/team-tool-actions`). */
export const teamChipActionKey = teamToolActionKey;

/** Whether a tool item may fold into a chip, and under which key (null: keep its card). */
export function chipKeyOf(
	item: ToolItem,
	ctx: Pick<TeamConversationTransformContext, "hasPendingPermission">,
): string | null {
	const { tc } = item;
	if (tc.toolName !== TEAM_TOOL_NAME || !tc.toolUseId) return null;
	if (item.msg?.id === STREAMING_MESSAGE_ID) return null;
	// Only a FINISHED call folds (the compact rows' own terminal set: failed, timeout, denied,
	// aborted and cancelled calls fold too, with their mark); anything still in flight, or a
	// status nobody has interpreted, keeps its card.
	if (!tc.status || IN_FLIGHT_TOOL_ROW_STATUSES.has(tc.status)) return null;
	if (!TERMINAL_TOOL_ROW_STATUSES.has(tc.status)) return null;
	if (ctx.hasPendingPermission?.(tc.toolUseId)) return null;
	return teamChipActionKey(tc.inputJson);
}

/** The chip key minted from one member call's identity (`toolUseId`, plus `#n` for a retry). */
export function teamChipKey(memberIdentity: string): string {
	return `team-chip-${memberIdentity}`;
}

export function teamEventKey(eventId: string): string {
	return `team-event-${eventId}`;
}

function chipData(items: readonly ToolItem[], key: string, labels: TeamChipLabels): TeamChipData {
	// Own keys only: an agent's malformed action (`constructor`, `__proto__`) is never a label.
	const label =
		(Object.hasOwn(labels.actions, key) ? labels.actions[key] : undefined) ?? labels.other;
	const count = items.length;
	const countLabel = count > 1 ? ` ${labels.count(count)}` : "";
	let failed = 0;
	let cancelled = 0;
	for (const item of items) {
		const mark = resolveToolRowStatusMark(item.tc.status);
		if (mark === "failed") failed++;
		else if (mark === "cancelled") cancelled++;
	}
	const failedLabel = failed > 0 ? labels.failed(failed) : "";
	const cancelledLabel = cancelled > 0 ? labels.cancelled(cancelled) : "";
	return {
		label,
		count,
		countLabel,
		failed,
		failedLabel,
		cancelled,
		cancelledLabel,
		status: failed > 0 ? "fail" : cancelled > 0 ? "cancelled" : "success",
		text: `${label}|${countLabel}|${failedLabel}|${cancelledLabel}`,
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
	/** `toolUseId`, plus `#n` for the n-th repeat of one id in the document (a provider retry). */
	identity: string;
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

/**
 * The chip's key and open state.
 *
 * The reader's fold is stored against the chip key it had when they clicked, and the members
 * of a chip change under it: an older page or a live call can join, `trimHead` can drop the
 * head. So the state is looked up on EVERY member's key, and the chip keeps the key of the
 * (last) member that holds an explicit state; that member's own value wins, so folding a chip
 * opened under an older key closes it. With no state anywhere the chip takes its LAST member's
 * key, which an older page or a trimmed head leaves alone.
 */
function chipFold(
	group: readonly RunEntry[],
	ctx: Pick<TeamConversationTransformContext, "isExpanded">,
): { specKey: string; expanded: boolean } {
	for (let index = group.length - 1; index >= 0; index--) {
		const key = teamChipKey((group[index] as RunEntry).identity);
		const state = ctx.isExpanded?.(key);
		if (state !== undefined) return { specKey: key, expanded: state };
	}
	return { specKey: teamChipKey((group.at(-1) as RunEntry).identity), expanded: false };
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
			const { specKey, expanded } = chipFold(group, ctx);
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
	const seen = new Map<string, number>();
	for (const unit of units) {
		if (unit.kind === "segment" && unit.seg.kind === "tool-run") {
			const seg = unit.seg as unknown as ToolRunSeg;
			for (const item of seg.items) {
				const id = item.tc.toolUseId ?? "";
				const repeat = seen.get(id) ?? 0;
				seen.set(id, repeat + 1);
				run.push({ item, unit, seg, identity: repeat > 0 ? `${id}#${repeat}` : id });
			}
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

/**
 * Each unit's placement time: its first source message's `createdAt`. A unit without one
 * carries the previous unit's time (it is somewhere after it), so it neither pulls earlier
 * events below itself nor lets later ones jump above it; only TRAILING timeless units (the
 * live streaming row) count as +∞, so newer events sit before them. Leading timeless units
 * take the first known time.
 */
function unitTimes(
	units: readonly AdapterRenderUnit[],
	sources: ReadonlyMap<string, SourceMessage[]>,
): number[] {
	const raw = units.map((unit) => parseServerTime(unitSources(unit, sources)[0]?.createdAt));
	let lastKnown = -1;
	for (let index = raw.length - 1; index >= 0; index--)
		if (Number.isFinite(raw[index])) {
			lastKnown = index;
			break;
		}
	if (lastKnown < 0) return raw.map(() => Number.POSITIVE_INFINITY);
	const firstKnown = raw.findIndex((time) => Number.isFinite(time));
	let carried = raw[firstKnown] as number;
	return raw.map((time, index) => {
		if (index > lastKnown) return Number.POSITIVE_INFINITY;
		if (Number.isFinite(time)) carried = time;
		return carried;
	});
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
	const times = unitTimes(units, sources);
	const floor = hasPrev ? (times[0] as number) : Number.NEGATIVE_INFINITY;
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
	for (const [index, unit] of units.entries()) {
		const time = times[index] as number;
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
