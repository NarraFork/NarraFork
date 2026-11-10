/**
 * vlist-jump-target.ts — Resolve a jump target to a top-level seq coordinate.
 *
 * A jump arrives as opaque ids: `msg-<messageId>`, a bare message id, or a tool
 * use id (a tool-only assistant turn has no `msg-` node of its own). When the
 * target is inside the loaded window the layout index answers directly and no
 * network call is needed. This module covers the other case — a target in history
 * the exact list has not loaded yet — where the window has to be extended upward
 * before anything can be revealed, and extending it requires knowing WHERE the
 * target sits in the narrator's seq space.
 *
 * Mirrors the chunked path's `resolveTargetSeq`, with the fetchers injected so the
 * resolution order (message first, tool call second, next candidate on failure) is
 * testable without a server.
 */

import type { PretextLayoutIndex } from "@shared/pretext-layout/index";
import type { MessageJumpOptions } from "../message/message-list-handle";

/**
 * Rows that annotate a message rather than carry its prose: thinking, tool calls,
 * activity folds, usage. One assistant message renders as several rows that all
 * resolve to its id (and an activity fold can also carry the NEXT message's id),
 * so the first row of a message is usually its thinking or a tool card. A jump
 * to the message means its text, so these only win when nothing else matches.
 */
const ANCILLARY_JUMP_ROW_KINDS: ReadonlySet<string> = new Set([
	"reasoning",
	"reasoning-steps",
	"reasoning-count",
	"tool-call",
	"auxiliary-content",
	"tool-call-group",
	"tool-run-count",
	"activity-trace",
	"turn-usage",
	"inline-permission",
	"ask-user-question",
]);

function isAncillaryJumpRowKind(kind: string | null | undefined): boolean {
	return !!kind && ANCILLARY_JUMP_ROW_KINDS.has(kind);
}

/** Whitespace-free form, so block boundaries and selection line breaks do not matter. */
function compactText(text: string): string {
	return text.replace(/\s+/gu, "");
}

const NEEDLE_PROBE_CHARS = 32;

/** The row whose text shows `needle`, else the first prose row, else the first row. */
export function pickJumpRow(rows: readonly HTMLElement[], needle?: string): HTMLElement | null {
	if (rows.length <= 1) return rows[0] ?? null;
	const probe = needle ? compactText(needle).slice(0, NEEDLE_PROBE_CHARS) : "";
	if (probe.length >= 2) {
		const hit = rows.find((row) => compactText(row.textContent ?? "").includes(probe));
		if (hit) return hit;
	}
	return (
		rows.find((row) => !isAncillaryJumpRowKind(row.getAttribute("data-nf-row-kind"))) ?? rows[0]
	);
}

/**
 * Prefer an exact tool row; otherwise the message's first prose row, not the
 * thinking / tool rows that precede it.
 */
export function jumpTargetItemIndex(index: PretextLayoutIndex, target: string): number | undefined {
	const id = jumpTargetMessageId(target);
	const tool = index.itemByKey(`tool-${id}`);
	if (tool) return tool.index;
	const indices = index.itemIndicesForSourceMessageId(id);
	const items = index.manifest.items;
	return indices.find((at) => !isAncillaryJumpRowKind(items[at]?.kind)) ?? indices[0];
}

/** Center inside this viewport only; native scrollIntoView also moves ancestors. */
export function jumpTargetScrollTop(viewport: HTMLElement, target: HTMLElement): number {
	const viewportRect = viewport.getBoundingClientRect();
	const targetRect = target.getBoundingClientRect();
	// Rects are visual pixels under classic graph zoom; scroll metrics are layout
	// pixels. offsetHeight includes borders (and scrollbars), just like the rect.
	const measuredScale = viewport.offsetHeight ? viewportRect.height / viewport.offsetHeight : 1;
	const scale = Number.isFinite(measuredScale) && measuredScale > 0 ? measuredScale : 1;
	return Math.max(
		0,
		Math.min(
			viewport.scrollHeight - viewport.clientHeight,
			viewport.scrollTop +
				(targetRect.top - viewportRect.top) / scale -
				viewport.clientTop -
				(viewport.clientHeight - targetRect.height / scale) / 2,
		),
	);
}

/**
 * Look only inside this list: docked sessions can render the same message ids.
 *
 * Every row of a message carries its `msg-` id (and a fold spanning messages
 * carries the later ones as zero-size aliases), so the FIRST match in document
 * order is often the thinking / tool row above the text. All matching rows are
 * collected and ranked by `pickJumpRow` instead.
 */
export function mountedJumpTarget(
	root: HTMLElement,
	domIds: readonly string[],
	targetIds: readonly string[],
	options: MessageJumpOptions = {},
): HTMLElement | null {
	for (const target of targetIds) {
		const key = `tool-${jumpTargetMessageId(target)}`;
		const row = root.querySelector<HTMLElement>(`[data-nf-row-key="${CSS.escape(key)}"]`);
		if (row) return row;
	}
	const candidates = [
		...domIds,
		...targetIds.flatMap((target) => [target, `msg-${jumpTargetMessageId(target)}`]),
	];
	for (const id of candidates) {
		const rows: HTMLElement[] = [];
		for (const element of root.querySelectorAll<HTMLElement>(`[id="${CSS.escape(id)}"]`)) {
			const row = element.closest<HTMLElement>("[data-nf-row-key]") ?? element;
			if (!rows.includes(row)) rows.push(row);
		}
		if (rows.length) return pickJumpRow(rows, options.needle);
	}
	return null;
}

/** Resolve a message id to its top-level ref seq (`getMessageLocation`). */
export type JumpMessageLocationFetcher = (messageId: string) => Promise<{
	seq: number;
	topLevelMessageId?: string;
}>;

/** Resolve a tool use id to the message that owns it (`getToolCallDetail`). */
export type JumpToolMessageFetcher = (toolUseId: string) => Promise<{ messageId?: string }>;

export interface ResolvedJumpTarget {
	/** Top-level ref seq the loaded window must cover for this target. */
	seq: number;
	/**
	 * The TOP-LEVEL message that renders the target. For a message nested in a
	 * subagent tree this is an ancestor, not the target itself, which is why it is
	 * reported separately: it is the id the layout index can actually locate.
	 */
	topLevelMessageId?: string;
}

/** Strip the `msg-` DOM-id prefix a caller may have passed instead of a raw id. */
export function jumpTargetMessageId(target: string): string {
	return target.startsWith("msg-") ? target.slice(4) : target;
}

/**
 * Try each candidate id in order, first as a message id and then as a tool use id,
 * returning the first that resolves. Rejections are swallowed per attempt on
 * purpose: an unknown id is the NORMAL case here (a tool use id is not a message
 * id, and vice versa), so a failure only means "try the next interpretation".
 * Returns null when nothing resolved.
 */
export async function resolveJumpTargetSeq(
	targetIds: readonly string[],
	fetchers: {
		fetchMessageLocation: JumpMessageLocationFetcher;
		fetchToolMessage: JumpToolMessageFetcher;
	},
): Promise<ResolvedJumpTarget | null> {
	for (const target of targetIds) {
		const messageId = jumpTargetMessageId(target);
		if (!messageId) continue;
		const direct = await locate(messageId, fetchers.fetchMessageLocation);
		if (direct) return direct;
		let ownerMessageId: string | undefined;
		try {
			ownerMessageId = (await fetchers.fetchToolMessage(messageId)).messageId;
		} catch {
			// Not a tool use id either; fall through to the next candidate.
		}
		if (!ownerMessageId || ownerMessageId === messageId) continue;
		const viaTool = await locate(ownerMessageId, fetchers.fetchMessageLocation);
		if (viaTool) return viaTool;
	}
	return null;
}

async function locate(
	messageId: string,
	fetchMessageLocation: JumpMessageLocationFetcher,
): Promise<ResolvedJumpTarget | null> {
	try {
		const location = await fetchMessageLocation(messageId);
		if (!Number.isFinite(location.seq)) return null;
		return { seq: location.seq, topLevelMessageId: location.topLevelMessageId };
	} catch {
		return null;
	}
}
