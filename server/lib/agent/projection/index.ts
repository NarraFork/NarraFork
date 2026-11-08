/**
 * Stored rows → neutral turns: decode, prefetch bytes, first projection stage.
 *
 * Every provider's history builder starts here and only formats the result, so all of
 * them see the same visible content in the same order (§7.2).
 */

import { decodeLegacyContent } from "@shared/narrator-blocks/decode";
import { historyInputMessageIds } from "@shared/native-injection";
import type { DbMessage } from "../provider";
import { toolLoadingChangeOf } from "../tool-loading";
import { resolveProjectionAssets } from "./assets";
import { type NeutralHistory, type ProjectionTarget, toTurns } from "./turns";

export * from "./turns";

export interface ProjectedHistory extends NeutralHistory {
	/** Persisted input rows the projection carries, for delivery receipts. */
	replayedInjectionMessageIds: string[];
}

/** Project the rows a history builder receives, in order, for one target. */
export async function projectHistory(
	rows: readonly DbMessage[],
	target: ProjectionTarget,
	narratorId?: string,
): Promise<ProjectedHistory> {
	const phaseStarted = performance.now();
	const envelopes = rows.map((row) =>
		decodeLegacyContent(row, {
			toolChangeOf: (message) => toolLoadingChangeOf(message as DbMessage),
		}),
	);
	// Asset resolution can complete entirely in microtasks when there are no files.
	// Release the event loop after a wide decode before walking the neutral blocks again.
	if (performance.now() - phaseStarted >= 8)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	const assets = await resolveProjectionAssets(envelopes, narratorId);
	const projected = toTurns(envelopes, target, assets);
	const emitted = new Set(projected.emittedInputIds);
	return {
		...projected,
		replayedInjectionMessageIds: historyInputMessageIds(rows.filter((row) => emitted.has(row.id))),
	};
}
