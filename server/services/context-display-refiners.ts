/**
 * Reader summaries of a `context_update` row that say what CHANGED.
 *
 * A context part supplies a reader summary of its current value (`ContextPart.display`). A part
 * may also register a refiner here: when a row that changes the part is written, the refiner gets
 * the summary the session's previous row of the same epoch stored for the part and the current
 * one, and returns the summary to store (the outline current-tasks view names the tasks that
 * were finished or started in between).
 *
 * The baseline is what the session was last SHOWN (its own stored rows), never a read cache.
 * A refiner only shapes the reader's `display`: the model-facing update is rendered before it
 * runs and never reads it.
 *
 * Refiners must be bounded (they run while a request's prefix is prepared) and never throw for
 * the row's sake: a failure stores the unrefined summary.
 */

import { hotSafe } from "@server/lib/hot-safe";
import type { DbMessage } from "@shared/agent-protocol/types";
import {
	type ContextUpdateBlockLike,
	contextUpdateKeys,
	contextUpdateOf,
} from "@shared/prefix-context";
import { logger } from "../lib/logger";

export interface ContextDisplayRefineInput {
	narratorId: string;
	/**
	 * What the previous row of this epoch that changed the part stored for it: `null` when that
	 * row removed the part, `undefined` when there is no such row or it stored no summary (the
	 * epoch's baseline, a row written before summaries existed).
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
 * What the last row of `epochId` that changed `key` stored as the part's summary (see
 * {@link ContextDisplayRefineInput.previous}). One backward pass over history already in memory,
 * stopping at the first row that names the key.
 */
export function previousContextDisplay(
	messages: readonly DbMessage[],
	epochId: string | undefined,
	key: string,
): unknown {
	if (!epochId) return undefined;
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
		const display = update.display;
		return display && typeof display === "object" && key in display ? display[key] : undefined;
	}
	return undefined;
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
	signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
	let out = input.display;
	for (const key of Object.keys(input.display)) {
		const refiner = refiners.get(key);
		if (!refiner) continue;
		try {
			const refined = await refiner({
				narratorId: input.narratorId,
				previous: previousContextDisplay(input.messages, input.epochId, key),
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
