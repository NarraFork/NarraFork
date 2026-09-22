import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import type { ReasoningEffort } from "../../lib/agent";
import type { ActiveNarrator } from "../narrator-session-state";

export interface InheritedModelNarrator {
	model?: string | null;
	parentNarratorId?: string | null;
	subagentType?: string | null;
	reasoningEffort?: ReasoningEffort | null;
}

export interface InheritedModelResolution {
	model: string;
	modelRef: string;
	reasoningEffort?: ReasoningEffort;
	/** Revision captured before the asynchronous policy resolution, not after it. */
	settingsRevision?: number;
}

interface InheritedModelDependencies {
	getActive(id: string): ActiveNarrator | undefined;
	activeValues(): Iterable<ActiveNarrator>;
	readNarrator(id: string): Promise<InheritedModelNarrator | undefined>;
	resolve(
		narrator: InheritedModelNarrator,
		actingUserId?: string | null,
		stickyProvider?: string,
	): Promise<InheritedModelResolution>;
	apply(active: ActiveNarrator, result: InheritedModelResolution): void;
	reportError(active: ActiveNarrator, error: unknown): void;
}

/**
 * All asynchronous writes use a per-active generation, never a persisted model write.
 * The request boundary awaits the current generation; an obsolete resolution cannot
 * restore inheritance after a manual selection, revive a dead session, or win a race
 * against a newer parent change. Dependencies keep DB/provider work out of this state
 * machine and make out-of-order completions directly testable.
 */
export function createInheritedModelRuntime(deps: InheritedModelDependencies) {
	function invalidate(active: ActiveNarrator): number {
		active._modelRefreshVersion = (active._modelRefreshVersion ?? 0) + 1;
		active._modelRefreshPending = undefined;
		active._modelRefreshError = undefined;
		return active._modelRefreshVersion;
	}

	function select(active: ActiveNarrator, modelRef: string, parentNarratorId?: string | null) {
		invalidate(active);
		active._modelSelectionRef = modelRef;
		active._followParentNarratorId =
			modelRef === FOLLOW_PARENT_MODEL ? parentNarratorId : undefined;
		if (modelRef !== FOLLOW_PARENT_MODEL) active._inheritedReasoningEffort = undefined;
	}

	function refresh(active: ActiveNarrator): void {
		const version = invalidate(active);
		const isCurrent = () =>
			active.alive &&
			deps.getActive(active.narratorId) === active &&
			active._modelRefreshVersion === version &&
			active._modelSelectionRef === FOLLOW_PARENT_MODEL;
		const pending = (async () => {
			try {
				const narrator = await deps.readNarrator(active.narratorId);
				if (!isCurrent()) return;
				if (!narrator || narrator.model !== FOLLOW_PARENT_MODEL) {
					throw new Error("Inherited model selection changed before resolution");
				}
				active._followParentNarratorId = narrator.parentNarratorId;
				const resolved = await deps.resolve(
					narrator,
					active._currentUserId ?? null,
					active.provider,
				);
				if (!isCurrent()) return;
				// Also guard writes that reached the DB but whose synchronous notification
				// has not arrived yet. These are indexed, single-row projection reads.
				const latest = await deps.readNarrator(active.narratorId);
				if (!isCurrent()) return;
				if (
					!latest ||
					latest.model !== FOLLOW_PARENT_MODEL ||
					latest.parentNarratorId !== narrator.parentNarratorId ||
					latest.subagentType !== narrator.subagentType
				) {
					throw new Error("Inherited model selection changed during resolution");
				}
				if (resolved.model === FOLLOW_PARENT_MODEL || resolved.modelRef === FOLLOW_PARENT_MODEL) {
					throw new Error("Inherited model resolver returned an unresolved parent reference");
				}
				deps.apply(active, resolved);
				active._modelUnavailableWaitCancel?.();
			} catch (error) {
				if (!isCurrent()) return;
				// Fail closed at the next boundary; do not abort an in-flight request.
				active._modelRefreshError = error;
				deps.reportError(active, error);
				active._modelUnavailableWaitCancel?.();
			} finally {
				if (active._modelRefreshVersion === version) active._modelRefreshPending = undefined;
			}
		})();
		active._modelRefreshPending = pending;
	}

	async function settle(active: ActiveNarrator): Promise<void> {
		// A second change can replace the promise while the first is awaited.
		while (active._modelRefreshPending) await active._modelRefreshPending;
		// Fail closed once, then clear: a sticky error would block every later
		// request boundary even when a subsequent refresh (settings revision
		// change, parent update, manual reselect) could recover.
		if (active._modelRefreshError) {
			const error = active._modelRefreshError;
			active._modelRefreshError = undefined;
			throw error;
		}
	}

	function parentChanged(parentNarratorId: string): void {
		// No historical-descendant query: work is bounded by the live runtime map.
		// Include nested followers, using a visited set to tolerate malformed cycles.
		const changed = new Set([parentNarratorId]);
		const followers = [...deps.activeValues()].filter(
			(active) => active.alive && active._modelSelectionRef === FOLLOW_PARENT_MODEL,
		);
		for (const parentId of changed) {
			for (const active of followers) {
				if (
					changed.has(active.narratorId) ||
					(active._followParentNarratorId && active._followParentNarratorId !== parentId)
				) {
					continue;
				}
				changed.add(active.narratorId);
				refresh(active);
			}
		}
	}

	return { select, refresh, settle, parentChanged };
}
