import { hotSafe } from "../lib/hot-safe";
import type { NarratorRecoveryTarget } from "./update-coordinator";

export type RecoverySource = {
	updateEpoch: string;
	kind: "planned" | "ordinary";
	capturedAt: string;
	narrators: NarratorRecoveryTarget[];
	pendingNarratorIds: string[];
	logicalRuns?: Array<{ narratorId: string; logicalRunId: string | null }>;
	unstartedTools?: Array<{ toolCallId: string; executionAttempt: number }>;
};
export const MAX_RECOVERY_SOURCES = 64;
export const MAX_RECOVERY_TARGETS = 10_000;
export const MAX_RECOVERY_MANIFEST_BYTES = 4 * 1024 * 1024;
export interface RecoverySourceHandle {
	update(source: RecoverySource): void;
	retire(): void;
	withAdvance<T>(fn: () => T | Promise<T>): Promise<T>;
}
declare const ticketBrand: unique symbol;
export type RecoveryHandoffTicket = { readonly [ticketBrand]: true };
type Entry = {
	source: RecoverySource;
	original: RecoverySource;
	handle: RecoverySourceHandle;
	active: number;
	manifestIdentity?: string;
	validateManifest?: () => void;
};
type Reservation = {
	ticket: RecoveryHandoffTicket;
	epochs: string[];
	entries: Entry[];
	rootEpoch?: string;
};
const registry = hotSafe("recovery-handoff-v1", () => ({
	discovering: false,
	entries: new Map<string, Entry>(),
	reservation: undefined as Reservation | undefined,
	changed: new Set<() => void>(),
	invalidated: new Set<string>(),
}));
function notify(): void {
	for (const fn of [...registry.changed]) fn();
}
function assertTicket(ticket: RecoveryHandoffTicket): Reservation {
	if (!registry.reservation || registry.reservation.ticket !== ticket)
		throw new Error("Invalid recovery handoff ticket");
	return registry.reservation;
}
/** Strict, bounded metadata validation. Sources never carry independent authorization. */
export function normalizeRecoverySources(value: unknown): RecoverySource[] {
	if (!Array.isArray(value) || value.length > MAX_RECOVERY_SOURCES)
		throw new Error("Recovery source limit or shape invalid");
	const result = new Map<string, RecoverySource>();
	let targets = 0;
	for (const raw of value) {
		if (!raw || typeof raw !== "object") throw new Error("Invalid recovery source");
		const s = raw as RecoverySource;
		if (
			Object.keys(raw).some(
				(key) =>
					![
						"updateEpoch",
						"kind",
						"capturedAt",
						"narrators",
						"pendingNarratorIds",
						"logicalRuns",
						"unstartedTools",
					].includes(key),
			)
		)
			throw new Error("Recovery source contains unauthorized fields");
		if (
			typeof s.updateEpoch !== "string" ||
			!s.updateEpoch ||
			!["planned", "ordinary"].includes(s.kind) ||
			typeof s.capturedAt !== "string" ||
			!Array.isArray(s.narrators) ||
			!Array.isArray(s.pendingNarratorIds)
		)
			throw new Error("Invalid recovery source identity");
		if (s.narrators.length > MAX_RECOVERY_TARGETS)
			throw new Error("Recovery target limit exceeded");
		const ids = new Set<string>();
		for (const target of s.narrators) {
			if (
				!target ||
				typeof target.narratorId !== "string" ||
				!target.narratorId ||
				typeof target.locale !== "string" ||
				ids.has(target.narratorId)
			)
				throw new Error("Invalid or duplicate recovery target");
			if (
				target.userId !== undefined &&
				target.userId !== null &&
				typeof target.userId !== "string"
			)
				throw new Error("Invalid recovery target user");
			if (
				target.replyInUserLanguage !== undefined &&
				typeof target.replyInUserLanguage !== "boolean"
			)
				throw new Error("Invalid recovery target language");
			ids.add(target.narratorId);
		}
		if (
			s.pendingNarratorIds.some((id) => typeof id !== "string" || !ids.has(id)) ||
			new Set(s.pendingNarratorIds).size !== s.pendingNarratorIds.length
		)
			throw new Error("Invalid pending recovery targets");
		if (
			s.logicalRuns !== undefined &&
			(!Array.isArray(s.logicalRuns) ||
				s.logicalRuns.length > MAX_RECOVERY_TARGETS ||
				s.logicalRuns.some(
					(run) =>
						!run ||
						!ids.has(run.narratorId) ||
						(run.logicalRunId !== null && typeof run.logicalRunId !== "string"),
				) ||
				new Set(s.logicalRuns.map((run) => run.narratorId)).size !== s.logicalRuns.length)
		)
			throw new Error("Invalid recovery logical runs");
		if (
			s.unstartedTools !== undefined &&
			(!Array.isArray(s.unstartedTools) ||
				s.unstartedTools.length > MAX_RECOVERY_TARGETS ||
				s.unstartedTools.some(
					(tool) =>
						!tool ||
						typeof tool.toolCallId !== "string" ||
						!tool.toolCallId ||
						!Number.isSafeInteger(tool.executionAttempt) ||
						tool.executionAttempt < 0,
				) ||
				new Set(s.unstartedTools.map((tool) => tool.toolCallId)).size !== s.unstartedTools.length)
		)
			throw new Error("Invalid recovery tool evidence");
		const normalized: RecoverySource = {
			updateEpoch: s.updateEpoch,
			kind: s.kind,
			capturedAt: s.capturedAt,
			narrators: s.narrators.map((target) => ({
				narratorId: target.narratorId,
				locale: target.locale,
				...(target.userId !== undefined ? { userId: target.userId } : {}),
				...(target.replyInUserLanguage !== undefined
					? { replyInUserLanguage: target.replyInUserLanguage }
					: {}),
			})),
			pendingNarratorIds: [...s.pendingNarratorIds],
			...(s.logicalRuns
				? {
						logicalRuns: s.logicalRuns.map((run) => ({
							narratorId: run.narratorId,
							logicalRunId: run.logicalRunId,
						})),
					}
				: {}),
			...(s.unstartedTools
				? {
						unstartedTools: s.unstartedTools.map((tool) => ({
							toolCallId: tool.toolCallId,
							executionAttempt: tool.executionAttempt,
						})),
					}
				: {}),
		};
		const prior = result.get(s.updateEpoch);
		if (prior && JSON.stringify(prior) !== JSON.stringify(normalized))
			throw new Error("Conflicting recovery source identity");
		if (!prior) targets += s.narrators.length;
		if (targets > MAX_RECOVERY_TARGETS) throw new Error("Recovery target limit exceeded");
		result.set(s.updateEpoch, normalized);
	}
	const normalized = [...result.values()];
	if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_RECOVERY_MANIFEST_BYTES)
		throw new Error("Recovery metadata exceeds 4 MiB limit");
	return normalized;
}
/** Cold adoption authority ends before any recovery queue is mounted. */
export function isRecoveryDiscoveryActive(): boolean {
	return registry.discovering;
}
export function beginRecoveryDiscovery(): void {
	if (registry.reservation) throw new Error("Recovery handoff already reserved");
	registry.discovering = true;
}
function pruneInvalidatedTargets(): void {
	if (registry.discovering) return;
	const targets = new Set(
		[...registry.entries.values()].flatMap((entry) =>
			entry.original.narrators.map((target) => target.narratorId),
		),
	);
	for (const id of registry.invalidated) if (!targets.has(id)) registry.invalidated.delete(id);
}
export function finishRecoveryDiscovery(): void {
	registry.discovering = false;
	pruneInvalidatedTargets();
	notify();
}
export function registerRecoverySource(
	source: RecoverySource,
	options: { manifestIdentity?: string; validateManifest?: () => void } = {},
): RecoverySourceHandle {
	if (
		options.manifestIdentity !== undefined &&
		(source.kind !== "planned" ||
			Buffer.byteLength(options.manifestIdentity, "utf8") > MAX_RECOVERY_MANIFEST_BYTES)
	)
		throw new Error("Invalid claimed recovery manifest identity");
	const normalized = normalizeRecoverySources([source])[0];
	if (!normalized) throw new Error("Missing recovery source");
	const epoch = normalized.updateEpoch;
	const prior = registry.entries.get(epoch);
	if (prior) {
		if (
			JSON.stringify(prior.original) !== JSON.stringify(normalized) ||
			(options.manifestIdentity !== undefined &&
				prior.manifestIdentity !== options.manifestIdentity)
		)
			throw new Error("Conflicting registered recovery source");
		return prior.handle;
	}
	if (registry.reservation) throw new Error("Cannot register a source during recovery handoff");
	if (
		registry.entries.size >= MAX_RECOVERY_SOURCES + 1 ||
		[...registry.entries.values()].reduce(
			(total, entry) => total + entry.source.narrators.length,
			normalized.narrators.length,
		) > MAX_RECOVERY_TARGETS
	)
		throw new Error("Recovery registry capacity exceeded");
	const entry: Entry = {
		source: {
			...normalized,
			pendingNarratorIds: normalized.pendingNarratorIds.filter(
				(id) => !registry.invalidated.has(id),
			),
		},
		original: structuredClone(normalized),
		active: 0,
		manifestIdentity: options.manifestIdentity,
		validateManifest: options.validateManifest,
		handle: {
			update(next) {
				if (registry.entries.get(epoch) !== entry) throw new Error("Recovery source retired");
				if (registry.reservation && entry.active === 0)
					throw new Error("Recovery source is reserved");
				if (
					next.updateEpoch !== epoch ||
					next.kind !== normalized.kind ||
					next.capturedAt !== normalized.capturedAt
				)
					throw new Error("Recovery source identity changed");
				const replacement = normalizeRecoverySources([next])[0];
				if (!replacement) throw new Error("Missing recovery source");
				if (
					[...registry.entries.values()].reduce(
						(total, candidate) =>
							total + (candidate === entry ? 0 : candidate.source.narrators.length),
						replacement.narrators.length,
					) > MAX_RECOVERY_TARGETS
				)
					throw new Error("Recovery target limit exceeded");
				entry.source = replacement;
				entry.source.pendingNarratorIds = entry.source.pendingNarratorIds.filter(
					(id) => !registry.invalidated.has(id),
				);
			},
			retire() {
				if (registry.reservation && entry.active === 0)
					throw new Error("Recovery source is reserved");
				if (registry.entries.get(epoch) === entry) registry.entries.delete(epoch);
				pruneInvalidatedTargets();
				notify();
			},
			withAdvance: (fn) => withRecoveryAdvance(epoch, fn),
		},
	};
	registry.entries.set(epoch, entry);
	return entry.handle;
}
export function getRegisteredRecoveryManifestIdentity(epoch: string): string | undefined {
	return registry.entries.get(epoch)?.manifestIdentity;
}
/** Current pending targets only; original manifests remain evidence after a target settles. */
export function isRecoveryTargetPending(narratorId: string): boolean {
	// Registration/update already enforce MAX_RECOVERY_TARGETS across all sources.
	for (const entry of registry.entries.values()) {
		if (entry.source.pendingNarratorIds.includes(narratorId)) return true;
	}
	return false;
}
export function getRecoverySource(epoch: string): RecoverySource | undefined {
	const entry = registry.entries.get(epoch);
	return entry ? structuredClone(entry.source) : undefined;
}
export function getRegisteredRecoverySource(epoch: string): RecoverySource | undefined {
	const entry = registry.entries.get(epoch);
	return entry ? structuredClone(entry.original) : undefined;
}
export async function withRecoveryAdvance<T>(
	epoch: string | readonly string[],
	fn: () => T | Promise<T>,
): Promise<T> {
	const epochs = [...new Set(typeof epoch === "string" ? [epoch] : epoch)];
	while (epochs.some((id) => registry.reservation?.epochs.includes(id))) {
		await new Promise<void>((resolve) => {
			const wake = () => {
				registry.changed.delete(wake);
				resolve();
			};
			registry.changed.add(wake);
		});
	}
	const entries = epochs.flatMap((id) => {
		const entry = registry.entries.get(id);
		return entry ? [entry] : [];
	});
	for (const entry of entries) entry.active++;
	try {
		return await fn();
	} finally {
		for (const entry of entries) entry.active--;
		notify();
	}
}
export function reserveRecoveryHandoff(): RecoveryHandoffTicket {
	if (registry.discovering) throw new Error("Recovery discovery is not finished");
	if (registry.reservation) throw new Error("Recovery handoff already reserved");
	normalizeRecoverySources([...registry.entries.values()].map((entry) => entry.source));
	// Validators are synchronous, bounded file-identity checks supplied by the original source
	// owner. They must finish before pause/epoch/gate changes; inherited sources need no file.
	for (const entry of registry.entries.values()) entry.validateManifest?.();
	const ticket = Object.freeze({}) as RecoveryHandoffTicket;
	registry.reservation = {
		ticket,
		epochs: [...registry.entries.keys()],
		entries: [...registry.entries.values()],
	};
	return ticket;
}
export function bindRecoveryHandoffEpoch(ticket: RecoveryHandoffTicket, epoch: string): void {
	const reservation = assertTicket(ticket);
	if (reservation.rootEpoch && reservation.rootEpoch !== epoch)
		throw new Error("Recovery handoff epoch already bound");
	reservation.rootEpoch = epoch;
}
export function getRecoveryHandoffSources(ticket: RecoveryHandoffTicket): RecoverySource[] {
	const reservation = assertTicket(ticket);
	return normalizeRecoverySources(
		reservation.epochs.flatMap((epoch) => {
			const entry = registry.entries.get(epoch);
			entry?.validateManifest?.();
			return entry ? [entry.source] : [];
		}),
	);
}
export function getReservedRecoverySourceEpochs(rootEpoch?: string): readonly string[] {
	const reservation = registry.reservation;
	return reservation && (rootEpoch === undefined || reservation.rootEpoch === rootEpoch)
		? [...reservation.epochs]
		: [];
}
export function isRecoveryAdvanceActive(epoch: string): boolean {
	return (registry.entries.get(epoch)?.active ?? 0) > 0;
}
export function hasReservedRecoverySourceEpoch(epoch: string): boolean {
	return getReservedRecoverySourceEpochs().includes(epoch);
}
export async function waitForRecoveryHandoffReady(
	ticket: RecoveryHandoffTicket,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
	const reservation = assertTicket(ticket);
	const ready = () => reservation.entries.every((entry) => entry.active === 0);
	if (options.signal?.aborted) {
		releaseRecoveryHandoff(ticket);
		throw new Error("Recovery handoff cancelled");
	}
	if (ready()) return;
	await new Promise<void>((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timer);
			registry.changed.delete(check);
			options.signal?.removeEventListener("abort", abort);
			if (error) {
				if (registry.reservation?.ticket === ticket) releaseRecoveryHandoff(ticket);
				reject(error);
			} else resolve();
		};
		const check = () => {
			if (registry.reservation?.ticket !== ticket) finish(new Error("Recovery handoff released"));
			else if (ready()) finish();
		};
		const abort = () => finish(new Error("Recovery handoff cancelled"));
		const timer = setTimeout(
			() => finish(new Error("Recovery handoff short barrier timed out")),
			Math.min(5000, Math.max(0, options.timeoutMs ?? 5000)),
		);
		registry.changed.add(check);
		options.signal?.addEventListener("abort", abort, { once: true });
		check();
	});
}
export function releaseRecoveryHandoff(ticket: RecoveryHandoffTicket): void {
	assertTicket(ticket);
	registry.reservation = undefined;
	notify();
}
export function invalidateRecoveryTarget(narratorId: string): void {
	if (
		!registry.discovering &&
		![...registry.entries.values()].some((entry) =>
			entry.original.narrators.some((target) => target.narratorId === narratorId),
		)
	)
		return;
	registry.invalidated.add(narratorId);
	for (const entry of registry.entries.values())
		entry.source.pendingNarratorIds = entry.source.pendingNarratorIds.filter(
			(id) => id !== narratorId,
		);
}
export function resetRecoveryHandoffForTests(): void {
	registry.reservation = undefined;
	registry.entries.clear();
	registry.invalidated.clear();
	registry.discovering = false;
	notify();
}
