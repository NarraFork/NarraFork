/**
 * Reader summaries of a `context_update` row that say what CHANGED.
 *
 * A context part supplies a reader summary of its current value (`ContextPart.display`). A part
 * may also register a refiner here: when a row that changes the part is written, the refiner gets
 * the summary the session's previous row of the same epoch stored for the part and the current
 * one, and returns the summary to store (the outline current-tasks view names the tasks that
 * were finished or started in between).
 *
 * The baseline is what the session was last SHOWN, never a read cache: its previous row of the
 * epoch, or, for the epoch's first row, the summary stored on the epoch marker beside the prefix
 * baseline that held the part ({@link baselineContextDisplays}).
 * A refiner only shapes the reader's `display`: the model-facing update is rendered before it
 * runs and never reads it.
 *
 * Refiners must be bounded (they run while a request's prefix is prepared) and never throw for
 * the row's sake: a failure stores the unrefined summary.
 */

import { hotSafe } from "@server/lib/hot-safe";
import type { DbMessage } from "@shared/agent-protocol/types";
import {
	boundContextUpdateDisplay,
	type ContextUpdateBlockLike,
	contextUpdateKeys,
	contextUpdateOf,
} from "@shared/prefix-context";
import { logger } from "../lib/logger";

export interface ContextDisplayRefineInput {
	narratorId: string;
	/**
	 * What the session was last shown of the part in this epoch: the summary its previous row that
	 * changed the part stored, or else the one the epoch's baseline stored. `null` when the part
	 * was absent then (removed, or not in the baseline); `undefined` when that is not known (a row
	 * or an epoch written before summaries existed).
	 */
	previous: unknown;
	/** The part's summary now; `null` when this row removes the part. */
	current: unknown;
	signal?: AbortSignal;
}

export type ContextDisplayRefiner = (input: ContextDisplayRefineInput) => Promise<unknown>;

const refiners = hotSafe(
	"narrafork.contextDisplayRefiners",
	() => new Map<string, ContextDisplayRefiner>(),
);

/** Register (or replace) the refiner of a context part's reader summary. */
export function registerContextDisplayRefiner(key: string, refiner: ContextDisplayRefiner): void {
	refiners.set(key, refiner);
}

/**
 * The reader summaries an epoch marker stores beside its prefix baseline: for each part that has
 * a refiner, its summary when the baseline holds the part, `null` when the baseline goes without
 * it. A part that could not be read (`keepParts`) or that supplied no summary is left out: what
 * the session saw of it is not known. Undefined when there is nothing to store, or it would
 * exceed {@link CONTEXT_UPDATE_DISPLAY_MAX_BYTES}.
 */
export function baselineContextDisplays(input: {
	parts: readonly { key: string }[];
	keepParts?: readonly string[];
	displays?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {};
	const present = new Set(input.parts.map((part) => part.key));
	for (const key of refiners.keys()) {
		if (!present.has(key)) {
			if (!input.keepParts?.includes(key)) out[key] = null;
		} else if (input.displays?.[key] !== undefined) out[key] = input.displays[key];
	}
	return boundContextUpdateDisplay(out);
}

/**
 * What the session was last shown of `key` in the epoch `epochId` (see
 * {@link ContextDisplayRefineInput.previous}): the summary of the last row that changed it, or,
 * when no row of the epoch did, the one the epoch's baseline stored (`baseline`). One backward
 * pass over history already in memory, stopping at the first row that names the key.
 */
export function previousContextDisplay(
	messages: readonly DbMessage[],
	epochId: string | undefined,
	key: string,
	baseline?: Readonly<Record<string, unknown>>,
	/**
	 * The session the row is written for. A fork inherits its parent's history, epoch included:
	 * a row or a marker the parent wrote says what the PARENT was shown (its own tasks), so it is
	 * no baseline for the fork, whose first row then lists instead of comparing.
	 */
	narratorId?: string,
): unknown {
	if (!epochId) return undefined;
	const foreign = (message: DbMessage): boolean =>
		narratorId !== undefined &&
		((message.narratorId !== undefined && message.narratorId !== narratorId) ||
			(message.authorNarratorId != null && message.authorNarratorId !== narratorId));
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "sys" || !Array.isArray(message.contentJson)) continue;
		const blocks = message.contentJson as ContextUpdateBlockLike[];
		const update = blocks.map((block) => contextUpdateOf(block)).find((found) => found);
		if (!update || update.epochId !== epochId) continue;
		// The notice names the keys the row changed (the changes themselves live in its snapshot).
		const keys =
			contextUpdateKeys(blocks) ??
			contextUpdateKeys([{ type: "text", text: message.contentText }, ...blocks]);
		if (!keys?.includes(key)) continue;
		if (foreign(message)) return undefined;
		const display = update.display;
		return display && typeof display === "object" && key in display ? display[key] : undefined;
	}
	// The epoch's own baseline: not when the marker in this history is another session's. (A marker
	// opened by the request being prepared is not in `messages` yet, and is this session's.)
	const marker = messages.find((message) => message.id === epochId);
	if (marker && foreign(marker)) return undefined;
	return baseline && key in baseline ? baseline[key] : undefined;
}

/**
 * `display` with each registered part's summary refined against the session's previous row.
 * Parts without a refiner, and summaries whose refiner fails, are kept as they are.
 */
export async function refineContextDisplay(input: {
	narratorId: string;
	display: Record<string, unknown>;
	messages: readonly DbMessage[];
	epochId: string | undefined;
	/** The summaries the epoch's marker stored beside its prefix baseline, when it has them. */
	baseline?: Readonly<Record<string, unknown>>;
	signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
	let out = input.display;
	for (const key of Object.keys(input.display)) {
		const refiner = refiners.get(key);
		if (!refiner) continue;
		try {
			const refined = await refiner({
				narratorId: input.narratorId,
				previous: previousContextDisplay(
					input.messages,
					input.epochId,
					key,
					input.baseline,
					input.narratorId,
				),
				current: input.display[key],
				...(input.signal ? { signal: input.signal } : {}),
			});
			if (refined !== undefined) out = { ...out, [key]: refined };
		} catch (error) {
			if (input.signal?.aborted) throw error;
			logger.warn("Context display could not be refined; storing it as it is", {
				narratorId: input.narratorId,
				key,
				error: String(error),
			});
		}
	}
	return out;
}
