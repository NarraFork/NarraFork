import { generateId } from "../lib/id";

// === Manual override state ===
// A suspended foreground runner remains alive while the user prepares a resume,
// finish, or detach action, with no automatic timeout. Actions use a claim-and-settle
// protocol so parent-abort callbacks cannot delete or resolve a newer runtime entry.

export type ManualOverrideResult =
	| {
			action: "finish";
			finalText: string;
			hasError: boolean;
			interrupted?: boolean;
	  }
	| {
			action: "resume";
			prompt: string;
			history: unknown[];
			trailingToolResults: unknown[];
			userId?: string | null;
	  };

export type ManualOverrideClaimPhase = "resume" | "finish" | "detach" | "interrupt" | "abandon";

export interface ManualOverrideEntry {
	entryId: string;
	claimId: string | null;
	phase: "waiting" | "claimed" | "settled";
	claimPhase: ManualOverrideClaimPhase | null;
	pendingTerminal: ManualOverrideResult | null;
	resolve: (result: ManualOverrideResult) => void;
	parentSignal: AbortSignal;
	parentNarratorId: string;
	toolUseId: string;
	/** The subagent ID that was active when manual override started. */
	subagentId: string;
	createdAt: number;
	claimedAt: number | null;
	onParentAbort: () => void;
}

export interface ManualOverrideClaim {
	subagentId: string;
	entryId: string;
	claimId: string;
	phase: ManualOverrideClaimPhase;
}

let _manualOverrides: Map<string, ManualOverrideEntry> | undefined;
export function getManualOverrideMap() {
	if (!_manualOverrides) _manualOverrides = new Map();
	return _manualOverrides;
}

/** Check if a subagent is in manual override (including an in-flight claim). */
export function isManualOverride(subagentId: string): boolean {
	return getManualOverrideMap().has(subagentId);
}

function cleanupEntryResources(entry: ManualOverrideEntry): void {
	entry.parentSignal.removeEventListener("abort", entry.onParentAbort);
}

function deleteCurrentEntry(entry: ManualOverrideEntry): boolean {
	if (getManualOverrideMap().get(entry.subagentId) !== entry) return false;
	getManualOverrideMap().delete(entry.subagentId);
	return true;
}

function settleEntry(entry: ManualOverrideEntry, result: ManualOverrideResult): boolean {
	if (entry.phase === "settled" || !deleteCurrentEntry(entry)) return false;
	entry.phase = "settled";
	cleanupEntryResources(entry);
	entry.resolve(result);
	return true;
}

/**
 * Record a terminal event from parent abort. If an action currently owns
 * the entry, defer terminal settlement until that claim finishes. This prevents
 * an old abort callback from deleting a replacement entry and makes terminal events win
 * over a resume/detach that was still preparing asynchronously.
 */
function recordTerminal(entry: ManualOverrideEntry, result: ManualOverrideResult): boolean {
	if (getManualOverrideMap().get(entry.subagentId) !== entry || entry.phase === "settled") {
		return false;
	}
	if (entry.phase === "claimed") {
		entry.pendingTerminal ??= result;
		return true;
	}
	return settleEntry(entry, result);
}

/** Claim one manual-override action. Only one resume/finish/detach may consume it. */
export function claimManualOverride(
	subagentId: string,
	phase: ManualOverrideClaimPhase,
): ManualOverrideClaim | null {
	const entry = getManualOverrideMap().get(subagentId);
	if (!entry || entry.phase !== "waiting") return null;
	const claimId = generateId();
	entry.phase = "claimed";
	entry.claimId = claimId;
	entry.claimPhase = phase;
	entry.claimedAt = Date.now();
	return { subagentId, entryId: entry.entryId, claimId, phase };
}

function getClaimedEntry(claim: ManualOverrideClaim): ManualOverrideEntry | null {
	const entry = getManualOverrideMap().get(claim.subagentId);
	if (
		!entry ||
		entry.entryId !== claim.entryId ||
		entry.claimId !== claim.claimId ||
		entry.phase !== "claimed" ||
		entry.claimPhase !== claim.phase
	) {
		return null;
	}
	return entry;
}

/** Settle a claimed action. A terminal event recorded during the claim takes precedence. */
export function settleManualOverrideClaim(
	claim: ManualOverrideClaim,
	result: ManualOverrideResult,
): boolean {
	const entry = getClaimedEntry(claim);
	if (!entry) return false;
	return settleEntry(entry, entry.pendingTerminal ?? result);
}

/** Release a failed preparation back to waiting, unless parent abort already became terminal. */
export function releaseManualOverrideClaim(claim: ManualOverrideClaim): boolean {
	const entry = getClaimedEntry(claim);
	if (!entry) return false;
	if (entry.pendingTerminal) return settleEntry(entry, entry.pendingTerminal);
	entry.phase = "waiting";
	entry.claimId = null;
	entry.claimPhase = null;
	entry.claimedAt = null;
	return true;
}

/** Runtime snapshot for stale-entry diagnostics and tests. */
export function getManualOverrideRuntime(
	subagentId: string,
):
	| Pick<
			ManualOverrideEntry,
			"entryId" | "claimId" | "phase" | "claimPhase" | "pendingTerminal" | "createdAt" | "claimedAt"
	  >
	| undefined {
	const entry = getManualOverrideMap().get(subagentId);
	if (!entry) return undefined;
	return {
		entryId: entry.entryId,
		claimId: entry.claimId,
		phase: entry.phase,
		claimPhase: entry.claimPhase,
		pendingTerminal: entry.pendingTerminal,
		createdAt: entry.createdAt,
		claimedAt: entry.claimedAt,
	};
}

export function listStaleManualOverrideRuntimes(
	maxAgeMs: number,
	now = Date.now(),
): Array<{ subagentId: string; entryId: string; phase: ManualOverrideEntry["phase"] }> {
	return [...getManualOverrideMap().values()]
		.filter((entry) => now - (entry.claimedAt ?? entry.createdAt) >= maxAgeMs)
		.map((entry) => ({
			subagentId: entry.subagentId,
			entryId: entry.entryId,
			phase: entry.phase,
		}));
}

/** Safely clean one stale runtime, optionally guarded by its observed entryId. */
export function cleanupManualOverrideRuntime(
	subagentId: string,
	expectedEntryId?: string,
): boolean {
	const entry = getManualOverrideMap().get(subagentId);
	if (!entry || (expectedEntryId && entry.entryId !== expectedEntryId)) return false;
	return settleEntry(entry, {
		action: "finish",
		finalText: "Manual override runtime cleaned up",
		hasError: true,
	});
}

/** Test/process cleanup that also removes abort listeners. */
export function clearManualOverrideRuntimes(): void {
	for (const entry of [...getManualOverrideMap().values()]) {
		settleEntry(entry, {
			action: "finish",
			finalText: "Manual override runtime cleared",
			hasError: true,
		});
	}
}

/**
 * Block until the user resumes/finishes the runner, or the parent is interrupted.
 */
export function waitForManualOverride(
	subagentId: string,
	parentSignal: AbortSignal,
	parentNarratorId: string,
	toolUseId: string,
): Promise<ManualOverrideResult> {
	return new Promise<ManualOverrideResult>((resolve) => {
		const existing = getManualOverrideMap().get(subagentId);
		if (existing) {
			resolve({
				action: "finish",
				finalText: "A manual override runtime is already active",
				hasError: true,
			});
			return;
		}

		const entry = {} as ManualOverrideEntry;
		entry.entryId = generateId();
		entry.claimId = null;
		entry.phase = "waiting";
		entry.claimPhase = null;
		entry.pendingTerminal = null;
		entry.resolve = resolve;
		entry.parentSignal = parentSignal;
		entry.parentNarratorId = parentNarratorId;
		entry.toolUseId = toolUseId;
		entry.subagentId = subagentId;
		entry.createdAt = Date.now();
		entry.claimedAt = null;
		entry.onParentAbort = () => {
			recordTerminal(entry, {
				action: "finish",
				finalText: "Parent narrator interrupted",
				hasError: true,
			});
		};

		getManualOverrideMap().set(subagentId, entry);
		if (parentSignal.aborted) {
			entry.onParentAbort();
		} else {
			parentSignal.addEventListener("abort", entry.onParentAbort, { once: true });
		}
	});
}

function claimAndSettle(
	subagentId: string,
	phase: ManualOverrideClaimPhase,
	result: ManualOverrideResult,
): boolean {
	const claim = claimManualOverride(subagentId, phase);
	return claim ? settleManualOverrideClaim(claim, result) : false;
}

/** Resolve a manual-override subagent's blocked Promise. */
export function resolveManualOverride(
	subagentId: string,
	finalText: string,
	hasError: boolean,
): boolean {
	return claimAndSettle(subagentId, "finish", { action: "finish", finalText, hasError });
}

/** Resume a suspended subagent inside its original foreground runner. */
export function resumeManualOverride(
	subagentId: string,
	input: {
		prompt: string;
		history: unknown[];
		trailingToolResults: unknown[];
		userId?: string | null;
	},
): boolean {
	return claimAndSettle(subagentId, "resume", { action: "resume", ...input });
}

/** Hard-interrupt a manual-override subagent and unblock its parent tool call. */
export function interruptManualOverride(subagentId: string): boolean {
	return claimAndSettle(subagentId, "interrupt", {
		action: "finish",
		finalText: "Subagent interrupted by user",
		hasError: false,
		interrupted: true,
	});
}

/** Abandon a manual-override subagent (e.g. parent interrupted). */
export function abandonManualOverride(subagentId: string): boolean {
	return claimAndSettle(subagentId, "abandon", {
		action: "finish",
		finalText: "Manual override abandoned",
		hasError: true,
	});
}

// === Conclusion watcher public API ===

export interface ConclusionWatcher {
	parentNarratorId: string;
	toolUseId: string;
	/** Original spawning row, preserved even when the parent message is later COW-copied. */
	originToolCallId?: string;
}

let _conclusionWatchers: Map<string, ConclusionWatcher> | undefined;
export function getConclusionWatchersMap() {
	if (!_conclusionWatchers) _conclusionWatchers = new Map();
	return _conclusionWatchers;
}

export function registerConclusionWatcher(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	originToolCallId?: string,
): void {
	getConclusionWatchersMap().set(subagentId, { parentNarratorId, toolUseId, originToolCallId });
}

export function removeConclusionWatcher(subagentId: string): boolean {
	return getConclusionWatchersMap().delete(subagentId);
}

export function getConclusionWatcher(subagentId: string): ConclusionWatcher | undefined {
	return getConclusionWatchersMap().get(subagentId);
}
