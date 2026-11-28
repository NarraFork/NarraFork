import { eventBus } from "@server/lib/event-bus";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import type { PersistedCredentialCache } from "@server/lib/persisted-credential-cache";
import { registerKeyQuotaProbe } from "@server/lib/provider-key-quota";
import { ProviderQuotaError, quotaAbortable } from "@server/lib/provider-quota-async";
import {
	type CustomApiQuotaTarget,
	type ProviderQuotaPage,
	type ProviderQuotaSnapshot,
	type ProviderQuotaSourceDeclaration,
	QUOTA_MAX_QUERY_MS,
	QUOTA_MAX_SNAPSHOT_BYTES,
	type QuotaQueryResult,
	quotaQueryResultSchema,
} from "@shared/provider-quota";
import { epochOf, type QuotaSnapshot, type QuotaWindow } from "@shared/quota-snapshot";
import {
	createProviderQuotaPersistence,
	type PersistedProviderQuota,
	type ProviderQuotaPersistence,
	type ProviderQuotaPersistenceContext,
} from "./provider-quota-persistence";
import {
	type CustomApiQuotaConnection,
	type CustomApiQuotaTargetDirectory,
	customApiQuotaTargets,
} from "./provider-quota-targets";

/** Read-only bridge into the shared snapshot UI; scheduling and identity stay with this service. */
export function toQuotaSnapshot(
	snapshot: ProviderQuotaSnapshot | null | undefined,
): QuotaSnapshot | undefined {
	if (
		!snapshot ||
		snapshot.status === "unsupported" ||
		(!snapshot.data && !snapshot.error && snapshot.fetchedAt === 0)
	)
		return undefined;
	const data = snapshot.status === "unavailable" ? null : snapshot.data;
	const kind = (name: string | undefined, durationMs?: number): QuotaWindow["kind"] =>
		name === "fiveHour" || name === "rolling" || name === "5h" || durationMs === 5 * 3_600_000
			? "5h"
			: name === "weekly" || name === "7d" || durationMs === 7 * 86_400_000
				? "weekly"
				: name === "monthly"
					? "monthly"
					: "other";
	const ratio = (
		used: number | null | undefined,
		total: number | null | undefined,
		remaining: number | null,
	): number | null => {
		if (total == null || total <= 0) return null;
		const value = used != null ? used / total : remaining != null ? 1 - remaining / total : null;
		return value !== null && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
	};
	const windows: QuotaWindow[] = (data?.windows ?? []).map((window) => ({
		kind: kind(window.id, window.durationMs),
		...(window.label || kind(window.id, window.durationMs) === "other"
			? { label: window.label ?? window.id }
			: {}),
		usedRatio:
			window.status === "rate-limited" || window.remaining === 0
				? 1
				: window.usedPercent != null
					? Math.max(0, Math.min(1, window.usedPercent / 100))
					: ratio(window.used, window.limit, window.remaining),
		resetsAt: epochOf(window.resetAt),
		...(window.status ? { status: window.status } : {}),
		...(window.used != null ? { used: window.used } : {}),
		...(window.limit != null ? { total: window.limit } : {}),
		...(window.remaining != null ? { remaining: window.remaining } : {}),
		...(window.unit ? { unit: window.unit } : {}),
	}));
	for (const amount of data?.amounts ?? []) {
		if (!amount.window || amount.quota === "none" || amount.quota === "alternative") continue;
		if (data?.unlimited && amount.total === 0) continue;
		windows.push({
			kind: kind(amount.window),
			label: amount.label ?? amount.window,
			usedRatio: ratio(amount.used, amount.total, amount.remaining),
			// A window start or plan expiry is not a promised refill time.
			resetsAt: null,
			...(amount.used != null ? { used: amount.used } : {}),
			...(amount.total != null ? { total: amount.total } : {}),
			...(amount.remaining != null ? { remaining: amount.remaining } : {}),
			unit: amount.unit,
		});
	}
	const balances: QuotaSnapshot["balances"] = (data?.amounts ?? []).map((amount) => ({
		id: amount.id,
		...(amount.label ? { label: amount.label } : {}),
		...(amount.display ? { display: amount.display } : {}),
		unit: amount.unit,
		remaining: amount.remaining,
		quota: amount.quota ?? "required",
		...(amount.remainingText !== undefined ? { remainingText: amount.remainingText } : {}),
		...(amount.used != null ? { used: amount.used } : {}),
		...(amount.total != null ? { total: amount.total } : {}),
		...(amount.window ? { window: amount.window } : {}),
		...(epochOf(amount.windowStart) !== null ? { windowStart: epochOf(amount.windowStart)! } : {}),
		...(amount.unlimited !== undefined || data?.unlimited
			? { unlimited: amount.unlimited ?? data?.unlimited }
			: {}),
	}));
	if (data?.unlimited && !balances.length && !windows.length)
		balances.push({ unit: "", remaining: null, unlimited: true });
	const expiresAt = epochOf(data?.expiresAt);
	const error = snapshot.status === "unavailable" ? "plugin_not_enabled" : snapshot.error;
	return {
		fetchedAt: snapshot.fetchedAt,
		scope:
			data?.scope === "account" || data?.scope === "wallet" || data?.scope === "subscription"
				? data.scope
				: "key",
		windows,
		balances,
		...(error ? { error } : {}),
		...(typeof data?.available === "boolean" ? { available: data.available } : {}),
		...(data?.details ? { details: data.details } : {}),
		...(data?.planName ? { plan: data.planName } : {}),
		...(expiresAt !== null ? { expiresAt } : {}),
	};
}

export interface ProviderQuotaSource {
	id: string;
	pluginId: string;
	contributionId: string;
	installationId?: string;
	revision: string;
	declaration: ProviderQuotaSourceDeclaration;
}
export interface ProviderQuotaQueryOptions {
	mode: "probe" | "refresh";
	cursor?: string;
	deadlineAt: number;
	signal: AbortSignal;
}
export interface ProviderQuotaDriver {
	listSources(): ProviderQuotaSource[];
	isReady?(): boolean;
	query(
		source: ProviderQuotaSource,
		target: CustomApiQuotaTarget,
		options: ProviderQuotaQueryOptions,
	): Promise<QuotaQueryResult>;
	onChanged?(listener: () => void): () => void;
}
export interface ProviderQuotaServiceOptions {
	directory?: CustomApiQuotaTargetDirectory;
	driver?: ProviderQuotaDriver;
	persistence?: PersistedCredentialCache<PersistedProviderQuota> &
		Partial<Pick<ProviderQuotaPersistence, "load">>;
	now?: () => number;
	roundTimeoutMs?: number;
	maxConcurrent?: number;
	maxQueued?: number;
	onChanged?: (providerIds: string[], version: number) => void;
}

interface Entry {
	connection: CustomApiQuotaConnection;
	snapshot: ProviderQuotaSnapshot;
	task?: Task;
	cursor?: string;
	sourceRevision?: string;
	failures: number;
	nextAllowedAt: number;
	nextManualAt: number;
	needsWarmup: boolean;
	interestedUntil: number;
	activityDue?: number;
	lastActivityAt: number;
	lastResetAttemptAt: number;
}
interface Task {
	entry: Entry;
	mode: "probe" | "refresh";
	epoch: number;
	controller: AbortController;
	promise: Promise<ProviderQuotaSnapshot | null>;
	providerPromise?: Promise<ProviderQuotaSnapshot | null>;
	resolve: (value: ProviderQuotaSnapshot | null) => void;
}

export const PROVIDER_QUOTA_MANUAL_THROTTLE_MS = 10_000;
const MAX_LIST_BYTES = 256 * 1024;
const MAX_SNAPSHOT_CACHE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_CACHE_ENTRIES = 256;
export const PROVIDER_QUOTA_KEEP_LAST_GOOD_MS = 10 * 60_000;
function connectionId(connection: CustomApiQuotaConnection): string {
	return connection.cacheId ?? connection.target.providerId;
}
function deterministicError(code: ProviderQuotaSnapshot["error"]): boolean {
	return (
		code === "auth_failed" ||
		code === "invalid_response" ||
		code === "invalid_configuration" ||
		code === "permission_denied" ||
		code === "unavailable"
	);
}

function sourceScore(source: ProviderQuotaSource, target: CustomApiQuotaTarget): number | null {
	if (
		target.siteQuota &&
		!source.declaration.settingsContribution &&
		!source.declaration.requests.some((request) => request.auth === "site-token")
	)
		return null;
	let url: URL;
	try {
		url = new URL(target.siteQuota?.root ?? target.baseUrl);
	} catch {
		return null;
	}
	const { hosts, pathPrefixes, fallback } = source.declaration.match;
	let score = 0;
	if (hosts.length) {
		const hostname = url.hostname.toLowerCase();
		const matches = hosts
			.map((host) => host.toLowerCase())
			.filter((host) =>
				host.startsWith("*.") ? hostname.endsWith(host.slice(1)) : hostname === host,
			);
		if (!matches.length) return null;
		score += matches.some((host) => !host.startsWith("*.")) ? 10_000 : 1_000;
	}
	if (pathPrefixes.length) {
		const paths = pathPrefixes.filter((path) => url.pathname.startsWith(path));
		if (!paths.length) return null;
		score += Math.max(...paths.map((path) => path.length));
	}
	if (!fallback && !hosts.length && !pathPrefixes.length) return null;
	return fallback ? score - 100_000 : score;
}

/** Deterministic explicit matching before generic probes, with a finite candidate budget. */
export function selectQuotaSources(
	sources: ProviderQuotaSource[],
	target: CustomApiQuotaTarget,
): ProviderQuotaSource[] {
	return sources
		.map((source) => ({ source, score: sourceScore(source, target) }))
		.filter(
			(entry): entry is { source: ProviderQuotaSource; score: number } => entry.score !== null,
		)
		.sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id))
		.slice(0, 8)
		.map((entry) => entry.source);
}

/**
 * One bounded queue for plugin-backed Custom API quota work. No platform manager depends on it.
 * Reads use SWR; generation checks and abort races discard changed-account and revoked results.
 */
export class ProviderQuotaService {
	private readonly directory: CustomApiQuotaTargetDirectory;
	private readonly now: () => number;
	private driver?: ProviderQuotaDriver;
	private unwatchDriver?: () => void;
	private entries = new Map<string, Entry>();
	private queue: Task[] = [];
	private active = 0;
	private epoch = 0;
	private revision = 0;
	private sourceSignature = "";
	private readonly providerSubjects = new Map<string, string>();
	private running = false;
	private wakeTimer?: ReturnType<typeof setTimeout>;
	private changeTimer?: ReturnType<typeof setTimeout>;
	private changed = new Set<string>();

	constructor(private readonly options: ProviderQuotaServiceOptions = {}) {
		this.directory = options.directory ?? customApiQuotaTargets;
		this.now = options.now ?? Date.now;
		if (options.driver) this.configureDriver(options.driver);
	}

	configureDriver(driver: ProviderQuotaDriver): void {
		this.unwatchDriver?.();
		this.driver = driver;
		this.unwatchDriver = driver.onChanged?.(() => this.invalidateSources());
		this.invalidateSources();
	}

	/** Called only after plugin initialization and the initial contribution scan have completed. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.invalidateSources();
		this.armTimer();
	}

	stop(): void {
		this.running = false;
		this.epoch++;
		clearTimeout(this.wakeTimer);
		this.wakeTimer = undefined;
		for (const entry of this.entries.values()) {
			this.cancel(entry);
			this.replace(entry, { status: "unavailable", stale: true, error: "unavailable" });
		}
	}

	dispose(): void {
		this.stop();
		this.unwatchDriver?.();
		clearTimeout(this.changeTimer);
		this.changeTimer = undefined;
		this.changed.clear();
	}

	private get discoveryReady(): boolean {
		try {
			return this.running && (this.driver?.isReady?.() ?? true);
		} catch {
			return false;
		}
	}

	private sources(): ProviderQuotaSource[] {
		try {
			return this.driver?.listSources() ?? [];
		} catch {
			return [];
		}
	}

	private discardRetiredSource(entry: Entry, sources: ProviderQuotaSource[]): void {
		if (
			!entry.snapshot.data ||
			sources.some(
				(source) =>
					source.id === entry.snapshot.sourceId && source.revision === entry.sourceRevision,
			)
		)
			return;
		entry.cursor = undefined;
		entry.sourceRevision = undefined;
		this.replace(entry, { data: null, sourceId: null, fetchedAt: 0, stale: true });
	}

	private persistenceContext(
		entry: Entry,
		source: ProviderQuotaSource,
	): ProviderQuotaPersistenceContext | undefined {
		if (!source.installationId) return undefined;
		return {
			pluginId: source.pluginId,
			installationId: source.installationId,
			sourceId: source.id,
			sourceRevision: source.revision,
			providerId: entry.connection.target.providerId,
			credentialId: entry.connection.target.keyId,
			isCurrent: () =>
				this.entries.get(connectionId(entry.connection)) === entry &&
				this.directory.getTarget(entry.connection.target)?.identity === entry.connection.identity &&
				this.sources().some(
					(candidate) =>
						candidate.id === source.id &&
						candidate.revision === source.revision &&
						candidate.installationId === source.installationId,
				),
		};
	}
	private warmPersistence(entry: Entry, sources: ProviderQuotaSource[]): void {
		const cache = this.options.persistence;
		if (!cache?.load) return;
		const version = entry.snapshot.version;
		void (async () => {
			for (const source of sources) {
				const context = this.persistenceContext(entry, source);
				if (!context) continue;
				const cached = await cache.load?.(
					connectionId(entry.connection),
					entry.connection.identity,
					context,
				);
				if (
					this.entries.get(connectionId(entry.connection)) !== entry ||
					entry.snapshot.version !== version ||
					entry.task
				)
					return;
				if (!cached || !context.isCurrent?.()) continue;
				entry.cursor = cached.cursor;
				entry.sourceRevision = cached.sourceRevision;
				entry.nextAllowedAt = 0;
				entry.needsWarmup = true;
				this.replace(entry, {
					sourceId: cached.sourceId,
					status: cached.status,
					data: cached.data,
					fetchedAt: cached.fetchedAt,
					attemptedAt: cached.attemptedAt,
					stale: true,
				});
				return;
			}
		})().catch(() => {});
	}
	async flushPersistence(): Promise<void> {
		await this.options.persistence?.flush();
	}
	sync(): void {
		const connections = this.directory.list();
		const ids = new Set(connections.map(connectionId));
		const aliases = new Map(
			this.directory.primaryEntries().map(({ providerId, cacheId }) => [providerId, cacheId]),
		);
		for (const [providerId, cacheId] of aliases)
			if (this.providerSubjects.get(providerId) !== cacheId) this.markChanged(providerId);
		for (const providerId of this.providerSubjects.keys())
			if (!aliases.has(providerId)) this.markChanged(providerId);
		this.providerSubjects.clear();
		for (const [providerId, cacheId] of aliases) this.providerSubjects.set(providerId, cacheId);
		for (const [id, entry] of this.entries) {
			if (ids.has(id)) continue;
			this.cancel(entry);
			this.entries.delete(id);
			this.options.persistence?.remove(id);
			this.markChanged(entry.snapshot.providerId);
		}
		const sources = this.sources();
		const signature = JSON.stringify(sources.map((source) => [source.id, source.revision]));
		const sourcesChanged = signature !== this.sourceSignature;
		this.sourceSignature = signature;
		if (sourcesChanged) {
			clearTimeout(this.wakeTimer);
			this.wakeTimer = undefined;
		}
		let added = false;
		for (const connection of connections) {
			const id = connectionId(connection);
			const existing = this.entries.get(id);
			if (existing?.connection.target.generation === connection.target.generation) {
				if (sourcesChanged) {
					this.cancel(existing);
					const available = selectQuotaSources(sources, connection.target).length > 0;
					this.discardRetiredSource(existing, sources);
					existing.cursor = undefined;
					existing.activityDue = undefined;
					existing.nextAllowedAt = 0;
					existing.needsWarmup = available;
					const absent = this.discoveryReady && sources.length === 0;
					this.replace(existing, {
						status: absent
							? "unavailable"
							: !connection.valid
								? "error"
								: !this.discoveryReady
									? "pending"
									: available
										? "pending"
										: "unavailable",
						error: absent
							? "unavailable"
							: !connection.valid
								? "invalid_configuration"
								: this.discoveryReady && !available
									? "unavailable"
									: null,
						...(!available ? { data: null } : {}),
						stale: true,
					});
				}
				continue;
			}
			if (existing) this.cancel(existing);
			const restored = connection.valid
				? this.options.persistence?.restore(id, connection.identity)
				: undefined;
			const selected = selectQuotaSources(sources, connection.target);
			const available = this.discoveryReady && selected.length > 0;
			const restoredSource =
				restored &&
				selected.find(
					(source) =>
						source.id === restored.sourceId && source.revision === restored.sourceRevision,
				);
			const absent = this.discoveryReady && sources.length === 0;
			const entry: Entry = {
				connection,
				snapshot: {
					providerId: connection.target.providerId,
					targetId: connection.target.id,
					...(connection.target.keyId ? { keyId: connection.target.keyId } : {}),
					...(connection.target.siteQuota ? { pushCompatible: false } : {}),
					generation: connection.target.generation,
					sourceId: restoredSource ? restored.sourceId : null,
					status: absent
						? "unavailable"
						: !connection.valid
							? "error"
							: !this.discoveryReady
								? "pending"
								: !available
									? "unavailable"
									: restoredSource
										? restored.status
										: "pending",
					data: restoredSource ? restored.data : null,
					fetchedAt: restoredSource ? restored.fetchedAt : 0,
					attemptedAt: restoredSource ? restored.attemptedAt : 0,
					stale: true,
					error: absent
						? "unavailable"
						: !connection.valid
							? "invalid_configuration"
							: this.discoveryReady && !available
								? "unavailable"
								: null,
					version: ++this.revision,
				},
				...(restoredSource && restored
					? {
							sourceRevision: restored.sourceRevision,
							...(restored.cursor ? { cursor: restored.cursor } : {}),
						}
					: {}),
				failures: 0,
				nextAllowedAt:
					restoredSource && restored
						? restored.attemptedAt +
							(restored.status === "unsupported"
								? restoredSource.declaration.refresh.unsupportedMs
								: restoredSource.declaration.refresh.staleMs)
						: 0,
				nextManualAt: 0,
				needsWarmup: true,
				interestedUntil: 0,
				lastActivityAt: 0,
				lastResetAttemptAt: 0,
			};
			this.entries.set(id, entry);
			if (available && !restoredSource) this.warmPersistence(entry, selected);
			added = true;
			this.markChanged(entry.snapshot.providerId);
		}
		if (added) this.trimSnapshots();
	}

	invalidateSources(): void {
		this.epoch++;
		clearTimeout(this.wakeTimer);
		this.wakeTimer = undefined;
		this.sync();
		const sources = this.sources();
		for (const entry of this.entries.values()) {
			this.cancel(entry);
			this.discardRetiredSource(entry, sources);
			entry.cursor = undefined;
			entry.failures = 0;
			entry.nextAllowedAt = 0;
			entry.needsWarmup = true;
			entry.activityDue = undefined;
			if (!entry.connection.valid) continue;
			const available = selectQuotaSources(sources, entry.connection.target).length > 0;
			this.replace(entry, {
				status: !this.discoveryReady ? "pending" : available ? "pending" : "unavailable",
				error: this.discoveryReady && !available ? "unavailable" : null,
				stale: true,
			});
		}
		this.fillPending();
	}

	generations(): Record<string, string> {
		this.sync();
		return Object.fromEntries(
			[...this.providerSubjects].flatMap(([providerId, id]) => {
				const entry = this.entries.get(id);
				return entry ? [[providerId, entry.snapshot.generation]] : [];
			}),
		);
	}
	private providerEntry(providerId: string): Entry | undefined {
		const id = this.providerSubjects.get(providerId);
		return id === undefined ? undefined : this.entries.get(id);
	}
	capabilityEnabled(): boolean {
		return this.discoveryReady && this.sources().length > 0;
	}

	/** Hot model-runtime reads must not reconcile, restore persistence or schedule probes. */
	peekGeneration(providerId: string): string | undefined {
		const entry = this.providerEntry(providerId);
		return entry && this.directory.isProviderIdentityCurrent(entry.connection)
			? entry.snapshot.generation
			: undefined;
	}

	peek(providerId: string): ProviderQuotaSnapshot | null {
		this.sync();
		const entry = this.providerEntry(providerId);
		return entry ? this.publicSnapshot(entry, true) : null;
	}
	peekKey(keyId: string): ProviderQuotaSnapshot | null {
		this.sync();
		const connection = this.directory.getKey(keyId);
		const entry = connection && this.entries.get(connectionId(connection));
		return entry ? this.publicSnapshot(entry) : null;
	}

	list(
		options: {
			providerId?: string;
			cursor?: string;
			limit?: number;
			visible?: (id: string) => boolean;
		} = {},
	): ProviderQuotaPage {
		this.sync();
		const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 100)));
		const selected = [...this.providerSubjects]
			.flatMap(([providerId, cacheId]): Array<[string, Entry]> => {
				const entry = this.entries.get(cacheId);
				return entry ? [[providerId, entry]] : [];
			})
			.filter(
				([id]) =>
					(!options.providerId || id === options.providerId) &&
					(!options.cursor || id > options.cursor) &&
					(!options.visible || options.visible(id)),
			)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const snapshots: ProviderQuotaSnapshot[] = [];
		let bytes = 1024;
		let nextCursor: string | null = null;
		for (const [id, entry] of selected) {
			if (snapshots.length >= limit) {
				nextCursor = snapshots.at(-1)?.providerId ?? null;
				break;
			}
			const snapshot = this.publicSnapshot(entry, true);
			const size = Buffer.byteLength(JSON.stringify(snapshot)) + 1;
			if (bytes + size > MAX_LIST_BYTES) {
				nextCursor = snapshots.at(-1)?.providerId ?? null;
				break;
			}
			snapshots.push(snapshot);
			bytes += size;
			entry.interestedUntil = this.now() + 120_000;
			if (this.due(entry)) void this.schedule(entry, entry.cursor ? "refresh" : "probe");
			if (id === options.providerId) break;
		}
		this.armTimer();
		return { snapshots, nextCursor };
	}

	manualRetryAfterMs(providerId: string, keyId?: string): number {
		this.sync();
		const connection = keyId ? this.directory.getKey(keyId) : undefined;
		const entry = keyId
			? connection?.target.providerId === providerId
				? this.entries.get(connectionId(connection))
				: undefined
			: this.providerEntry(providerId);
		return !entry || entry.task || !entry.connection.valid
			? 0
			: Math.max(0, entry.nextManualAt - this.now());
	}

	refresh(
		providerId: string,
		options: { mode?: "probe" | "refresh"; manual?: boolean; signal?: AbortSignal } = {},
	): Promise<ProviderQuotaSnapshot | null> {
		this.sync();
		const entry = this.providerEntry(providerId);
		const pending = this.refreshEntry(entry, options);
		if (!entry?.connection.target.keyId) return pending;
		const project = (snapshot: ProviderQuotaSnapshot | null) => {
			if (!snapshot) return null;
			const current = this.directory.get(providerId);
			if (!current || connectionId(current) !== connectionId(entry.connection)) {
				this.sync();
				return null;
			}
			return this.publicSnapshot(entry, true);
		};
		if (!options.signal && entry.task) {
			entry.task.providerPromise ??= pending.then(project);
			return entry.task.providerPromise;
		}
		return pending.then(project);
	}
	refreshKey(
		keyId: string,
		options: { mode?: "probe" | "refresh"; manual?: boolean; signal?: AbortSignal } = {},
	): Promise<ProviderQuotaSnapshot | null> {
		this.sync();
		const connection = this.directory.getKey(keyId);
		return this.refreshEntry(connection && this.entries.get(connectionId(connection)), options);
	}
	private refreshEntry(
		entry: Entry | undefined,
		options: { mode?: "probe" | "refresh"; manual?: boolean; signal?: AbortSignal },
	): Promise<ProviderQuotaSnapshot | null> {
		if (!entry) return Promise.resolve(null);
		if (
			!entry.connection.valid ||
			!this.discoveryReady ||
			(!entry.task && this.now() < entry.nextManualAt)
		)
			return Promise.resolve(this.publicSnapshot(entry));
		// Admission is synchronous, before any provider projection adds Promise turns.
		// Shared in-flight work stays joinable even when the waiting queue is full.
		if (
			options.manual &&
			!entry.task &&
			this.candidates(entry).length > 0 &&
			this.queue.length >= this.maxQueued
		)
			throw new ProviderQuotaError("queue_full");
		const promise = this.schedule(entry, options.mode ?? (entry.cursor ? "refresh" : "probe"));
		return options.signal ? quotaAbortable(promise, options.signal) : promise;
	}
	/** One reconciliation for a key list, not a full directory scan for each row. */
	keySnapshots(): Record<string, ProviderQuotaSnapshot> {
		this.sync();
		return Object.fromEntries(
			[...this.entries.values()]
				.filter((entry) => !entry.connection.target.siteQuota)
				.map((entry) => [
					entry.connection.target.keyId ?? entry.snapshot.providerId,
					this.publicSnapshot(entry),
				]),
		);
	}
	/** Stream values have their own cache but must still belong to the current plugin identity. */
	isStreamSnapshotCurrent(keyId: string, generation: unknown): boolean {
		const entry = this.entries.get(`key/${keyId}`) ?? this.entries.get(keyId);
		return (
			!!entry?.connection.valid &&
			this.discoveryReady &&
			this.sources().length > 0 &&
			entry.snapshot.status !== "unavailable" &&
			entry.snapshot.error !== "unavailable" &&
			entry.snapshot.pushCompatible !== false &&
			entry.snapshot.generation === generation &&
			this.directory.isKeyIdentityCurrent(keyId, entry.connection)
		);
	}

	/** Pure selection read: no reconcile, scheduling, key selection, or database audit. */
	peekKeyForSelection(keyId: string): ProviderQuotaSnapshot | null {
		const entry = this.entries.get(`key/${keyId}`) ?? this.entries.get(keyId);
		if (
			!entry?.connection.valid ||
			!entry.snapshot.data ||
			deterministicError(entry.snapshot.error) ||
			entry.snapshot.fetchedAt <= 0 ||
			!this.discoveryReady ||
			!this.directory.isKeyIdentityCurrent(keyId, entry.connection)
		)
			return null;
		const source = this.sources().find(
			(candidate) =>
				candidate.id === entry.snapshot.sourceId && candidate.revision === entry.sourceRevision,
		);
		if (
			!source ||
			this.now() - entry.snapshot.fetchedAt >
				(source.declaration.refresh.keepLastGoodMs ?? Number.POSITIVE_INFINITY)
		)
			return null;
		return structuredClone(entry.snapshot);
	}

	/** Schedules work without awaiting upstream IO. Explicit refresh() is the bounded wait API. */
	async refreshStale(providerIds?: string[]): Promise<void> {
		this.sync();
		const selected = providerIds ? new Set(providerIds) : undefined;
		for (const [id, entry] of this.entries) {
			if (
				selected &&
				!selected.has(entry.snapshot.providerId) &&
				!selected.has(entry.connection.target.keyId ?? id)
			)
				continue;
			if (this.queue.length >= this.maxQueued) break;
			if (this.due(entry)) void this.schedule(entry, entry.cursor ? "refresh" : "probe");
		}
	}

	noteActivity(providerRef: string): void {
		this.sync();
		if (!this.discoveryReady) return;
		for (const entry of this.entries.values()) {
			if (
				entry.snapshot.providerId !== providerRef &&
				entry.connection.target.prefix !== providerRef
			)
				continue;
			if (!this.candidates(entry).length || deterministicError(entry.snapshot.error)) continue;
			const policy = this.candidates(entry)[0]?.declaration.refresh;
			entry.interestedUntil = this.now() + 120_000;
			entry.activityDue ??= Math.max(
				this.now() + 500,
				entry.lastActivityAt + (policy?.activityMs ?? 20_000),
				entry.failures || entry.snapshot.status === "unsupported" ? entry.nextAllowedAt : 0,
			);
		}
		this.armTimer();
	}

	private get maxQueued(): number {
		return Math.min(128, Math.max(1, this.options.maxQueued ?? 128));
	}
	private candidates(entry: Entry): ProviderQuotaSource[] {
		return selectQuotaSources(this.sources(), entry.connection.target);
	}
	private due(entry: Entry): boolean {
		return (
			this.discoveryReady &&
			entry.connection.valid &&
			!entry.task &&
			!deterministicError(entry.snapshot.error) &&
			this.now() >= entry.nextAllowedAt &&
			this.candidates(entry).length > 0
		);
	}

	private publicSnapshot(entry: Entry, providerView = false): ProviderQuotaSnapshot {
		const source = this.sources().find((candidate) => candidate.id === entry.snapshot.sourceId);
		if (
			entry.snapshot.error &&
			entry.snapshot.data &&
			this.now() - entry.snapshot.fetchedAt >
				(source?.declaration.refresh.keepLastGoodMs ?? Number.POSITIVE_INFINITY)
		) {
			this.options.persistence?.remove(connectionId(entry.connection));
			this.replace(entry, { data: null, status: "error", stale: true });
		}
		const stale =
			entry.snapshot.stale ||
			entry.snapshot.error !== null ||
			!source ||
			this.now() - entry.snapshot.fetchedAt >= source.declaration.refresh.staleMs;
		return structuredClone({
			...entry.snapshot,
			...(providerView ? { targetId: `custom-api/${entry.snapshot.providerId}` } : {}),
			stale,
		});
	}

	private fillPending(): void {
		if (!this.discoveryReady) return;
		for (const entry of this.entries.values()) {
			if (this.queue.length >= this.maxQueued) break;
			if (entry.needsWarmup && this.due(entry))
				void this.schedule(entry, entry.cursor ? "refresh" : "probe");
		}
	}

	private schedule(entry: Entry, mode: "probe" | "refresh"): Promise<ProviderQuotaSnapshot | null> {
		if (entry.task) return entry.task.promise;
		if (!this.discoveryReady || !entry.connection.valid)
			return Promise.resolve(this.publicSnapshot(entry));
		if (!this.candidates(entry).length) {
			this.replace(entry, { status: "unavailable", error: "unavailable", stale: true });
			return Promise.resolve(this.publicSnapshot(entry));
		}
		if (this.queue.length >= this.maxQueued) return Promise.resolve(null);
		let resolve!: Task["resolve"];
		const promise = new Promise<ProviderQuotaSnapshot | null>((done) => {
			resolve = done;
		});
		const task: Task = {
			entry,
			mode,
			epoch: this.epoch,
			controller: new AbortController(),
			promise,
			resolve,
		};
		entry.task = task;
		entry.needsWarmup = false;
		entry.activityDue = undefined;
		entry.nextManualAt = this.now() + PROVIDER_QUOTA_MANUAL_THROTTLE_MS;
		this.queue.push(task);
		this.pump();
		return promise;
	}

	private cancel(entry: Entry): void {
		const task = entry.task;
		if (!task) return;
		entry.task = undefined;
		task.controller.abort(new ProviderQuotaError("unavailable"));
		const index = this.queue.indexOf(task);
		if (index !== -1) {
			this.queue.splice(index, 1);
			task.resolve(null);
		}
	}

	private pump(): void {
		const limit = Math.min(4, Math.max(1, this.options.maxConcurrent ?? 4));
		while (this.running && this.active < limit && this.queue.length) {
			const task = this.queue.shift();
			if (!task) break;
			this.active++;
			void this.execute(task).finally(() => {
				this.active--;
				this.pump();
				this.fillPending();
				this.armTimer();
			});
		}
	}

	private current(task: Task): boolean {
		if (
			task.epoch !== this.epoch ||
			this.entries.get(connectionId(task.entry.connection)) !== task.entry ||
			task.entry.task !== task
		)
			return false;
		const connection = this.directory.getTarget(task.entry.connection.target);
		if (!connection || connection.target.generation !== task.entry.snapshot.generation) {
			this.sync();
			return false;
		}
		return (
			!task.controller.signal.aborted ||
			(task.controller.signal.reason instanceof ProviderQuotaError &&
				task.controller.signal.reason.code === "timeout")
		);
	}

	private async execute(task: Task): Promise<void> {
		const { entry, controller } = task;
		const timeout = Math.min(
			QUOTA_MAX_QUERY_MS,
			Math.max(1, this.options.roundTimeoutMs ?? QUOTA_MAX_QUERY_MS),
		);
		const deadlineAt = this.now() + timeout;
		const timer = setTimeout(() => controller.abort(new ProviderQuotaError("timeout")), timeout);
		const startedAt = performance.now();
		let selected: ProviderQuotaSource | undefined;
		try {
			this.replace(entry, { status: "probing", attemptedAt: this.now(), error: null });
			entry.lastResetAttemptAt = this.now();
			entry.lastActivityAt = this.now();
			let result: QuotaQueryResult = { status: "unsupported", data: null, error: null };
			const candidates = this.candidates(entry);
			if (!candidates.length || !this.driver) throw new ProviderQuotaError("unavailable");
			for (const source of candidates) {
				selected = source;
				const reuse =
					task.mode !== "probe" &&
					source.id === entry.snapshot.sourceId &&
					source.revision === entry.sourceRevision;
				result = quotaQueryResultSchema.parse(
					await quotaAbortable(
						this.driver.query(source, structuredClone(entry.connection.target), {
							mode: reuse ? "refresh" : "probe",
							...(reuse && entry.cursor ? { cursor: entry.cursor } : {}),
							deadlineAt,
							signal: controller.signal,
						}),
						controller.signal,
					),
				);
				if (!this.current(task)) return;
				if (
					!this.sources().some(
						(candidate) => candidate.id === source.id && candidate.revision === source.revision,
					)
				)
					throw new ProviderQuotaError("unavailable");
				if (result.status !== "unsupported") break;
			}
			if (!selected || !this.current(task)) return;
			if (result.status === "error") throw new ProviderQuotaError(result.error ?? "request_failed");
			const snapshot = {
				...entry.snapshot,
				sourceId: selected.id,
				status: result.status,
				data: result.data,
				fetchedAt: result.status === "supported" ? this.now() : 0,
				stale: result.status !== "supported",
				error: null,
			};
			if (Buffer.byteLength(JSON.stringify(snapshot)) > QUOTA_MAX_SNAPSHOT_BYTES)
				throw new ProviderQuotaError("invalid_response");
			entry.cursor = result.cursor;
			entry.sourceRevision = selected.revision;
			entry.failures = 0;
			entry.nextAllowedAt =
				this.now() +
				(result.status === "unsupported"
					? selected.declaration.refresh.unsupportedMs
					: selected.declaration.refresh.staleMs);
			this.replace(entry, snapshot);
			const cache = this.options.persistence as ProviderQuotaPersistence | undefined;
			cache?.save(
				connectionId(entry.connection),
				entry.connection.identity,
				{
					sourceId: selected.id,
					sourceRevision: selected.revision,
					status: result.status,
					data: result.data,
					...(result.cursor ? { cursor: result.cursor } : {}),
					fetchedAt: entry.snapshot.fetchedAt,
					attemptedAt: entry.snapshot.attemptedAt,
				},
				this.persistenceContext(entry, selected),
			);
			this.trimSnapshots();
		} catch (error) {
			if (this.current(task)) {
				entry.failures++;
				const policy = selected?.declaration.refresh;
				entry.nextAllowedAt =
					this.now() +
					Math.min(
						policy?.maxRetryMs ?? 600_000,
						(policy?.retryMs ?? 60_000) * 2 ** Math.min(8, entry.failures - 1),
					);
				const code = error instanceof ProviderQuotaError ? error.code : "invalid_response";
				const keep =
					!deterministicError(code) &&
					entry.snapshot.data !== null &&
					entry.snapshot.fetchedAt > 0 &&
					this.now() - entry.snapshot.fetchedAt <=
						(policy?.keepLastGoodMs ?? Number.POSITIVE_INFINITY);
				if (!keep) this.options.persistence?.remove(connectionId(entry.connection));
				if (deterministicError(code)) {
					entry.cursor = undefined;
					entry.activityDue = undefined;
				}
				this.replace(entry, {
					status: code === "unavailable" ? "unavailable" : "error",
					error: code,
					data: keep ? entry.snapshot.data : null,
					stale: true,
				});
			}
		} finally {
			clearTimeout(timer);
			const current = this.current(task);
			if (entry.task === task) entry.task = undefined;
			task.resolve(current ? this.publicSnapshot(entry) : null);
			const durationMs = Math.round(performance.now() - startedAt);
			if (durationMs >= 2000)
				logger.warn("provider quota query slow", {
					targetId: entry.snapshot.targetId,
					sourceId: selected?.id,
					durationMs,
					status: entry.snapshot.status,
				});
		}
	}

	private replace(entry: Entry, patch: Partial<ProviderQuotaSnapshot>): void {
		entry.snapshot = { ...entry.snapshot, ...patch, version: ++this.revision };
		this.markChanged(entry.snapshot.providerId);
	}

	private trimSnapshots(): void {
		const populated = [...this.entries.values()]
			.filter((entry) => entry.snapshot.data !== null)
			.sort(
				(a, b) =>
					b.snapshot.fetchedAt - a.snapshot.fetchedAt || b.snapshot.version - a.snapshot.version,
			);
		let bytes = 0;
		for (let index = 0; index < populated.length; index++) {
			const entry = populated[index];
			if (!entry) continue;
			const size = Buffer.byteLength(JSON.stringify(entry.snapshot));
			if (index < MAX_SNAPSHOT_CACHE_ENTRIES && bytes + size <= MAX_SNAPSHOT_CACHE_BYTES) {
				bytes += size;
				continue;
			}
			// Evict only reconstructible values. Do not immediately warm an evicted entry again.
			entry.needsWarmup = false;
			this.replace(entry, { data: null, fetchedAt: 0, stale: true, status: "pending" });
		}
	}

	private markChanged(id: string): void {
		this.changed.add(id);
		if (this.changeTimer) return;
		this.changeTimer = setTimeout(() => {
			this.changeTimer = undefined;
			const ids = [...this.changed];
			this.changed.clear();
			for (let offset = 0; offset < ids.length; offset += 100)
				this.options.onChanged?.(ids.slice(offset, offset + 100), this.revision);
		}, 100);
		this.changeTimer.unref?.();
	}

	private armTimer(): void {
		clearTimeout(this.wakeTimer);
		this.wakeTimer = undefined;
		if (!this.discoveryReady) return;
		let next = Number.POSITIVE_INFINITY;
		const now = this.now();
		for (const entry of this.entries.values()) {
			if (
				entry.task ||
				!entry.connection.valid ||
				deterministicError(entry.snapshot.error) ||
				!this.candidates(entry).length
			)
				continue;
			if (entry.activityDue !== undefined) next = Math.min(next, entry.activityDue);
			if (entry.interestedUntil <= now) continue;
			next = Math.min(next, entry.nextAllowedAt);
			for (const window of entry.snapshot.status === "supported"
				? (entry.snapshot.data?.windows ?? [])
				: []) {
				const reset = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
				if (Number.isFinite(reset) && reset > entry.lastResetAttemptAt && !entry.failures)
					next = Math.min(next, reset);
			}
		}
		if (!Number.isFinite(next)) return;
		this.wakeTimer = setTimeout(
			() => {
				this.wakeTimer = undefined;
				this.sync();
				for (const entry of this.entries.values()) {
					if (this.queue.length >= this.maxQueued) break;
					const now = this.now();
					const active = entry.interestedUntil > now;
					const resetDue =
						active &&
						entry.snapshot.status === "supported" &&
						!entry.failures &&
						entry.snapshot.data?.windows.some(
							(window) =>
								window.resetAt &&
								Date.parse(window.resetAt) <= now &&
								Date.parse(window.resetAt) > entry.lastResetAttemptAt,
						);
					if (
						(entry.activityDue !== undefined && entry.activityDue <= now) ||
						resetDue ||
						(active && this.due(entry))
					)
						void this.schedule(entry, entry.cursor ? "refresh" : "probe");
				}
				this.armTimer();
			},
			Math.max(50, Math.min(2_147_483_647, next - now)),
		);
		this.wakeTimer.unref?.();
	}

	getDiagnostics(): {
		active: number;
		queued: number;
		entries: number;
		running: boolean;
		hasTimer: boolean;
	} {
		return {
			active: this.active,
			queued: this.queue.length,
			entries: this.entries.size,
			running: this.running,
			hasTimer: this.wakeTimer !== undefined,
		};
	}
}

// The platform's pinned driver and the route/main imports must share the actual service,
// including its timer and in-flight queue. A pre-owner deployment still needs a cold restart.
const quotaOwner = hotSafe("narrafork.providerQuotaService.owner", () => ({
	service: new ProviderQuotaService({
		persistence: createProviderQuotaPersistence(),
		onChanged: (providerIds, version) =>
			eventBus.emit({ type: "provider:quota_changed", providerIds, version }),
	}),
	removeProbe: undefined as (() => void) | undefined,
	removeSettingsListener: undefined as (() => void) | undefined,
}));
export const providerQuotaService = quotaOwner.service;

/** Replace the registration on reload, including when the probe registry was also reloaded. */
quotaOwner.removeProbe?.();
quotaOwner.removeProbe = registerKeyQuotaProbe((keyId, now) => {
	const snapshot = providerQuotaService.peekKeyForSelection(keyId);
	if (!snapshot?.data) return undefined;
	const until = snapshot.data.windows.flatMap((window) => {
		const usedUp =
			window.remaining === 0 ||
			window.status === "rate-limited" ||
			(!(window.remaining != null && window.remaining > 0) &&
				((window.usedPercent ?? 0) >= 100 ||
					(window.limit != null &&
						window.used != null &&
						window.limit > 0 &&
						window.used >= window.limit)));
		const reset = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
		return usedUp && Number.isFinite(reset) && reset > now ? [reset] : [];
	});
	return until.length ? Math.max(...until) : undefined;
});

quotaOwner.removeSettingsListener?.();
const settingsChanged = (event: { targetKind: string; targetId: string }) => {
	if (event.targetKind !== "custom-api") return;
	providerQuotaService.sync();
	if (providerQuotaService.getDiagnostics().running)
		void providerQuotaService.refresh(event.targetId).catch(() => {});
};
eventBus.on("provider:settings_changed", settingsChanged);
quotaOwner.removeSettingsListener = () =>
	eventBus.off("provider:settings_changed", settingsChanged);
