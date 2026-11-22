import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { GitLineStats } from "../../shared/git-line-stats";
import {
	GIT_STATUS_FILTER_CHARS,
	GIT_STATUS_PAGE_DEFAULT_LIMIT,
	GIT_STATUS_PAGE_MAX_BYTES,
	GIT_STATUS_PAGE_MAX_LIMIT,
	type GitStatusFilterChar,
	type GitStatusPage,
	type GitStatusPageCacheState,
	type GitStatusPageCounts,
	type GitStatusPageErrorCode,
	type GitStatusPageFile,
	type GitStatusPageResult,
	type GitStatusPageStatsResponse,
	type GitStatusPageStatsResult,
	type GitStatusPageValidation,
	gitStatusBadgeChar,
	gitStatusInSection,
	gitStatusMatchesSection,
	isGitStatusFilterChar,
	normalizeGitStatusFilter,
} from "../../shared/git-status-page";
import {
	type GitStatusPageScan,
	parseGitStatusPageRaw,
	scanGitStatusPage,
} from "./git-status-page-parser";
import {
	GitStatusPageError,
	type GitStatusPageRawResult,
	type GitStatusPageRequest,
	gitStatusPageScopesOverlap,
	gitStatusPageSourceIdentity,
} from "./git-status-page-protocol";
import {
	buildGitStatusPageStatsIndex,
	type GitStatusPageStatsIndex,
	projectGitStatusPageStats,
	validateGitStatusPageStatsQuery,
} from "./git-status-page-stats";

export const GIT_STATUS_PAGE_CACHE_SNAPSHOTS = 8;
export const GIT_STATUS_PAGE_CACHE_BYTES = 64 * 1024 * 1024;
export const GIT_STATUS_PAGE_CACHE_IDLE_MS = 120_000;
const GIT_STATUS_PAGE_ON_DEMAND_TTL_MS = 5000;

interface StatsLoad {
	controller: AbortController;
	promise: Promise<GitStatusPageStatsIndex>;
	users: number;
}

interface MemberProjection {
	matches: Uint32Array;
	counts: GitStatusPageCounts;
}
interface Observation {
	queryKey: string;
	sourceIdentity: string;
	generation: number;
	references: number;
	memberVersion: number;
	statsVersion: number;
	fingerprint: string;
	files: GitStatusPageFile[];
	projections: Map<string, MemberProjection>;
	complete: boolean;
	limitReason: GitStatusPageScan["limitReason"];
	statsIndex?: GitStatusPageStatsIndex;
	bytes: number;
	lastUsed: number;
	updating: boolean;
	errorCode?: string;
	statsErrorCode?: string;
	onDemand?: boolean;
	onDemandLoadedAt?: number;
	statsEpoch?: number;
	statsLoadedAt?: number;
	statsLoad?: StatsLoad;
}
interface Snapshot {
	id: string;
	key: string;
	queryKey: string;
	identity: string;
	sourceIdentity: string;
	filter: GitStatusFilterChar[];
	fingerprint: string;
	files: GitStatusPageFile[];
	matches: Uint32Array;
	counts: GitStatusPageCounts;
	complete: boolean;
	limitReason: GitStatusPageScan["limitReason"];
	observation: Observation;
	references: number;
	memberVersion: number;
	bytes: number;
	lastUsed: number;
}
interface ScanMarker {
	queryKey: string;
	sourceIdentity: string;
	invalidated: boolean;
	producer?: boolean;
	onDemand?: boolean;
	observation?: Observation;
	snapshot?: Snapshot;
}
interface Cursor {
	v: 1;
	s: string;
	o: number;
	k: string;
}

/** Shared source observations and bounded actor projections live only in this Worker. */
export class GitStatusPageEngine {
	private readonly secret = randomBytes(32);
	private readonly workerEpoch = randomBytes(16).toString("base64url");
	private readonly snapshots = new Map<string, Snapshot>();
	private readonly observations = new Map<string, Observation>();
	private readonly retiredObservations = new Set<Observation>();
	private readonly leases = new Set<string>();
	private readonly scans = new Set<ScanMarker>();
	private memberSequence = 0;
	private statsSequence = 0;
	private bytes = 0;
	private closed = false;

	constructor(
		private readonly limits = {
			snapshots: GIT_STATUS_PAGE_CACHE_SNAPSHOTS,
			bytes: GIT_STATUS_PAGE_CACHE_BYTES,
			idleMs: GIT_STATUS_PAGE_CACHE_IDLE_MS,
		},
		private readonly now: () => number = Date.now,
		private readonly scanLocal = scanGitStatusPage,
	) {}

	cacheState(request: GitStatusPageRequest, statistics = false): GitStatusPageCacheState {
		const observation = this.observations.get(this.observationKey(request));
		const available = !!observation?.memberVersion && (!statistics || !!observation.statsIndex);
		return {
			status: available
				? "ready"
				: observation?.errorCode || (statistics && observation?.statsErrorCode)
					? "error"
					: "pending",
			workerEpoch: this.workerEpoch,
			memberVersion: observation?.memberVersion ?? 0,
			statsVersion: observation?.statsVersion ?? 0,
			updating:
				observation?.updating ??
				[...this.scans].some(
					(scan) =>
						scan.producer &&
						!scan.invalidated &&
						scan.queryKey === request.scope.queryKey &&
						scan.sourceIdentity === this.sourceIdentity(request),
				),
			...(observation?.errorCode ? { errorCode: observation.errorCode } : {}),
			...(observation?.statsErrorCode ? { statsErrorCode: observation.statsErrorCode } : {}),
		};
	}

	/** Produce one source observation, independently of actor/filter projections. */
	async observe(
		request: GitStatusPageRequest,
		signal: AbortSignal,
		readRemote: () => Promise<GitStatusPageRawResult>,
		readStats?: (signal: AbortSignal) => Promise<GitLineStats>,
		onPublished?: (cache: GitStatusPageCacheState) => void,
	): Promise<GitStatusPageCacheState> {
		if (this.closed) throw new GitStatusPageError("GIT_STATUS_PAGE_CLOSED");
		this.validate(request);
		signal.throwIfAborted();
		const key = this.observationKey(request);
		let observation = this.observations.get(key);
		const marker: ScanMarker = {
			queryKey: request.scope.queryKey,
			sourceIdentity: this.sourceIdentity(request),
			invalidated: false,
			producer: true,
			onDemand: request.operation === "read-on-demand",
		};
		for (const older of this.scans)
			if (
				older.producer &&
				older.queryKey === marker.queryKey &&
				older.sourceIdentity === marker.sourceIdentity
			)
				older.invalidated = true;
		this.scans.add(marker);
		if (observation) {
			observation.updating = true;
			observation.references++;
			marker.observation = observation;
		}
		const current = () => {
			signal.throwIfAborted();
			if (marker.invalidated || this.closed)
				throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
		};
		let statisticsPhase = false;
		try {
			if (!this.canAdmitObservation(observation))
				throw new GitStatusPageError("GIT_STATUS_PAGE_BUSY");
			const fresh = await this.scan(request, signal, readRemote);
			current();
			const fingerprint = this.fingerprint(fresh.files);
			if (
				!observation ||
				observation.fingerprint !== fingerprint ||
				observation.complete !== fresh.complete ||
				observation.limitReason !== fresh.limitReason
			) {
				const baseBytes =
					Buffer.byteLength(JSON.stringify(fresh.files)) * 2 +
					fresh.files.length * 256 +
					request.scope.queryKey.length * 2 +
					4096;
				this.reserve(baseBytes, observation);
				const projected = this.buildMemberProjections(
					fresh.files,
					fresh.complete,
					this.limits.bytes - this.bytes - baseBytes,
				);
				const bytes = baseBytes + projected.bytes;
				if (observation) {
					this.dropObservation(key, marker);
					this.releaseObservation(marker);
				}
				observation = {
					queryKey: request.scope.queryKey,
					sourceIdentity: marker.sourceIdentity,
					generation: 0,
					references: 0,
					memberVersion: ++this.memberSequence,
					statsVersion: 0,
					fingerprint,
					files: fresh.files,
					projections: projected.projections,
					complete: fresh.complete,
					limitReason: fresh.limitReason,
					bytes,
					lastUsed: this.now(),
					updating: true,
				};
				this.observations.set(key, observation);
				observation.references++;
				marker.observation = observation;
				this.bytes += bytes;
			}
			observation.lastUsed = this.now();
			observation.errorCode = undefined;
			onPublished?.(this.cacheState(request));
			if (readStats) {
				statisticsPhase = true;
				const stats = await readStats(signal);
				current();
				// Retain last-good while building; both old and new indices count against the budget.
				const built = buildGitStatusPageStatsIndex(
					observation.files,
					[],
					observation.complete,
					stats,
					this.limits.bytes - this.bytes,
				);
				current();
				const oldBytes = observation.statsIndex?.bytes ?? 0;
				observation.statsIndex = built;
				observation.statsErrorCode = undefined;
				observation.statsVersion = ++this.statsSequence;
				observation.bytes += built.bytes - oldBytes;
				this.bytes += built.bytes - oldBytes;
			}
			observation.updating = false;
			return this.cacheState(request);
		} catch (error) {
			if (!marker.invalidated && !this.closed) {
				if (!observation) {
					const bytes = 4096 + request.scope.queryKey.length * 2;
					this.reserve(bytes, undefined, true);
					observation = {
						queryKey: request.scope.queryKey,
						sourceIdentity: marker.sourceIdentity,
						generation: 0,
						references: 0,
						memberVersion: 0,
						statsVersion: 0,
						fingerprint: "",
						files: [],
						projections: new Map(),
						complete: false,
						limitReason: undefined,
						bytes,
						lastUsed: this.now(),
						updating: false,
					};
					this.observations.set(key, observation);
					this.bytes += observation.bytes;
				}
				observation.updating = false;
				const code =
					error instanceof GitStatusPageError ? error.code : "GIT_STATUS_PAGE_SOURCE_FAILED";
				if (statisticsPhase) observation.statsErrorCode = code;
				else observation.errorCode = code;
				return this.cacheState(request);
			}
			throw error;
		} finally {
			this.scans.delete(marker);
			this.releaseObservation(marker);
		}
	}

	/** Preserve the existing HTTP contract until clients own background observations. */
	async readOnDemand(
		request: GitStatusPageRequest,
		signal: AbortSignal,
		readRemote: () => Promise<GitStatusPageRawResult>,
	): Promise<GitStatusPage> {
		this.validate(request);
		signal.throwIfAborted();
		if (!request.query.cursor) {
			let observation = this.observations.get(this.observationKey(request));
			if (
				!observation?.memberVersion ||
				observation.errorCode ||
				observation.updating ||
				this.now() - (observation.onDemandLoadedAt ?? 0) >= GIT_STATUS_PAGE_ON_DEMAND_TTL_MS
			) {
				const cache = await this.observe(
					{ ...request, operation: "read-on-demand" },
					signal,
					readRemote,
				);
				if (cache.errorCode)
					throw new GitStatusPageError(cache.errorCode as GitStatusPageErrorCode);
				observation = this.observations.get(this.observationKey(request));
				if (observation) observation.onDemandLoadedAt = this.now();
			}
			if (observation) observation.onDemand = true;
		}
		const result = await this.read(request, signal);
		if (result.status !== "ready") throw new GitStatusPageError("GIT_STATUS_PAGE_SOURCE_FAILED");
		const { status: _status, cache: _cache, ...page } = result;
		return page;
	}

	async read(
		request: GitStatusPageRequest,
		signal: AbortSignal,
		_readRemote?: () => Promise<GitStatusPageRawResult>,
	): Promise<GitStatusPageResult> {
		if (this.closed) throw new GitStatusPageError("GIT_STATUS_PAGE_CLOSED");
		signal.throwIfAborted();
		const { limit, filter, key } = this.validate(request);
		this.prune();
		if (request.query.cursor) {
			const cursor = this.decodeCursor(request.query.cursor, key);
			const snapshot = this.snapshots.get(cursor.s);
			if (!snapshot || !this.isCurrent(snapshot))
				throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
			if (snapshot.key !== key || cursor.o > snapshot.matches.length)
				throw new GitStatusPageError("GIT_STATUS_PAGE_INVALID_CURSOR");
			return this.page(snapshot, cursor.o, limit);
		}
		const cache = this.cacheState(request);
		const observation = this.observations.get(this.observationKey(request));
		if (!observation?.memberVersion)
			return { status: cache.errorCode ? "error" : "pending", cache };
		const reusable = [...this.snapshots.values()].find(
			(snapshot) => snapshot.key === key && this.isCurrent(snapshot),
		);
		if (reusable) return this.page(reusable, 0, limit);
		const projection = observation.projections.get(filter.join(""));
		if (!projection) throw new GitStatusPageError("GIT_STATUS_PAGE_SOURCE_FAILED");
		const { counts, matches } = projection;
		const bytes = 4096 + request.scope.queryKey.length * 2;
		this.reserve(bytes, observation);
		while (this.snapshots.size >= this.limits.snapshots) {
			const oldest = this.snapshots.keys().next().value;
			if (!oldest) throw new GitStatusPageError("GIT_STATUS_PAGE_BUSY");
			this.drop(oldest);
		}
		const snapshot: Snapshot = {
			id: randomBytes(16).toString("base64url"),
			key,
			queryKey: request.scope.queryKey,
			identity: this.identity(request),
			sourceIdentity: this.sourceIdentity(request),
			filter,
			fingerprint: observation.fingerprint,
			files: observation.files,
			matches,
			counts,
			complete: observation.complete,
			limitReason: observation.limitReason,
			observation,
			references: 0,
			memberVersion: observation.memberVersion,
			bytes,
			lastUsed: this.now(),
		};
		const page = this.page(snapshot, 0, limit);
		this.snapshots.set(snapshot.id, snapshot);
		this.bytes += bytes;
		return page;
	}

	async readStats(
		request: GitStatusPageRequest,
		signal: AbortSignal,
		_readStats?: (signal: AbortSignal) => Promise<GitLineStats>,
	): Promise<GitStatusPageStatsResponse> {
		if (this.closed) throw new GitStatusPageError("GIT_STATUS_PAGE_CLOSED");
		signal.throwIfAborted();
		const { filter } = this.validate(request);
		const query = request.statsQuery;
		if (!query) throw new GitStatusPageError("GIT_STATUS_PAGE_INVALID_QUERY");
		validateGitStatusPageStatsQuery(query);
		this.prune();
		const snapshot = this.snapshots.get(query.snapshotId);
		if (
			!snapshot ||
			!this.isCurrent(snapshot) ||
			snapshot.identity !== this.identity(request) ||
			JSON.stringify(snapshot.filter) !== JSON.stringify(filter) ||
			JSON.stringify(filter) !== JSON.stringify(normalizeGitStatusFilter(query.filter))
		)
			throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
		const cache = this.cacheState(request, true);
		if (!snapshot.observation.statsIndex)
			return { status: cache.status === "error" ? "error" : "pending", cache };
		snapshot.lastUsed = this.now();
		const result: GitStatusPageStatsResponse = {
			...projectGitStatusPageStats(query, snapshot.observation.statsIndex),
			status: "ready",
			cache,
		};
		if (Buffer.byteLength(JSON.stringify(result)) > GIT_STATUS_PAGE_MAX_BYTES)
			throw new GitStatusPageError("GIT_STATUS_PAGE_RECORD_TOO_LARGE");
		return result;
	}

	async readStatsOnDemand(
		request: GitStatusPageRequest,
		signal: AbortSignal,
		readStats: (signal: AbortSignal) => Promise<GitLineStats>,
	): Promise<GitStatusPageStatsResult> {
		if (this.closed) throw new GitStatusPageError("GIT_STATUS_PAGE_CLOSED");
		signal.throwIfAborted();
		const { filter } = this.validate(request);
		const query = request.statsQuery;
		if (!query) throw new GitStatusPageError("GIT_STATUS_PAGE_INVALID_QUERY");
		validateGitStatusPageStatsQuery(query);
		this.prune();
		const snapshot = this.snapshots.get(query.snapshotId);
		if (
			!snapshot ||
			!this.isCurrent(snapshot) ||
			snapshot.identity !== this.identity(request) ||
			JSON.stringify(snapshot.filter) !== JSON.stringify(filter) ||
			JSON.stringify(filter) !== JSON.stringify(normalizeGitStatusFilter(query.filter))
		)
			throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
		const observation = snapshot.observation;
		const epoch = observation.statsEpoch ?? 0;
		const current = () => {
			signal.throwIfAborted();
			this.prune();
			if (
				this.closed ||
				this.snapshots.get(snapshot.id) !== snapshot ||
				!this.isCurrent(snapshot) ||
				(observation.statsEpoch ?? 0) !== epoch
			)
				throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
		};
		if (
			observation.statsIndex &&
			this.now() - (observation.statsLoadedAt ?? 0) >= GIT_STATUS_PAGE_ON_DEMAND_TTL_MS
		)
			this.clearOnDemandStats(observation);
		let index = observation.statsIndex;
		if (!index) {
			let load = observation.statsLoad;
			if (!load) {
				const controller = new AbortController();
				load = { controller, users: 0, promise: Promise.resolve({} as GitStatusPageStatsIndex) };
				observation.statsLoad = load;
				const owner = load;
				const marker: ScanMarker = {
					queryKey: observation.queryKey,
					sourceIdentity: observation.sourceIdentity,
					invalidated: false,
					observation,
					snapshot,
				};
				observation.references++;
				snapshot.references++;
				load.promise = (async () => {
					let stats: GitLineStats;
					try {
						stats = await readStats(controller.signal);
					} catch {
						controller.signal.throwIfAborted();
						stats = { files: [], linesAdded: 0, linesRemoved: 0, complete: false };
					}
					controller.signal.throwIfAborted();
					this.prune();
					if (this.closed || !this.isCurrent(snapshot) || (observation.statsEpoch ?? 0) !== epoch)
						throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
					const built = buildGitStatusPageStatsIndex(
						observation.files,
						[],
						observation.complete,
						stats,
						this.limits.bytes - this.bytes,
					);
					observation.statsIndex = built;
					observation.statsLoadedAt = this.now();
					observation.statsVersion = ++this.statsSequence;
					observation.bytes += built.bytes;
					this.bytes += built.bytes;
					return built;
				})().finally(() => {
					if (observation.statsLoad === owner) observation.statsLoad = undefined;
					this.releaseObservation(marker);
				});
			}
			load.users++;
			try {
				index = await new Promise<GitStatusPageStatsIndex>((resolve, reject) => {
					const abort = () => reject(signal.reason);
					const invalidated = () => reject(load.controller.signal.reason);
					signal.addEventListener("abort", abort, { once: true });
					load.controller.signal.addEventListener("abort", invalidated, { once: true });
					load.promise.then(resolve, reject).finally(() => {
						signal.removeEventListener("abort", abort);
						load.controller.signal.removeEventListener("abort", invalidated);
					});
					if (signal.aborted) abort();
					else if (load.controller.signal.aborted) invalidated();
				});
			} finally {
				load.users--;
				if (load.users === 0 && observation.statsLoad === load) {
					observation.statsLoad = undefined;
					load.controller.abort(new GitStatusPageError("GIT_STATUS_PAGE_CANCELLED"));
				}
			}
		}
		current();
		snapshot.lastUsed = this.now();
		return projectGitStatusPageStats(query, index);
	}

	private clearOnDemandStats(observation: Observation): void {
		if (observation.statsIndex) {
			observation.bytes -= observation.statsIndex.bytes;
			this.bytes -= observation.statsIndex.bytes;
		}
		observation.statsIndex = undefined;
		observation.statsLoadedAt = undefined;
	}

	invalidateStats(queryKey: string): void {
		for (const observation of this.observations.values()) {
			if (!gitStatusPageScopesOverlap(observation.queryKey, queryKey)) continue;
			if (observation.onDemand) {
				observation.statsEpoch = (observation.statsEpoch ?? 0) + 1;
				this.clearOnDemandStats(observation);
				observation.statsLoad?.controller.abort(new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED"));
				observation.statsLoad = undefined;
			} else {
				observation.generation++;
				observation.updating = true;
				observation.errorCode = undefined;
			}
		}
		for (const scan of this.scans)
			if (scan.producer && !scan.onDemand && gitStatusPageScopesOverlap(scan.queryKey, queryKey))
				scan.invalidated = true;
	}

	/** Dirty cache stays readable; writes still perform a complete fresh scan below. */
	invalidate(queryKey: string): void {
		for (const [key, observation] of this.observations)
			if (observation.onDemand && gitStatusPageScopesOverlap(observation.queryKey, queryKey))
				this.dropObservation(key);
		for (const observation of this.observations.values()) {
			if (!gitStatusPageScopesOverlap(observation.queryKey, queryKey)) continue;
			observation.generation++;
			observation.updating = true;
			observation.errorCode = undefined;
		}
		for (const scan of this.scans)
			if (gitStatusPageScopesOverlap(scan.queryKey, queryKey)) scan.invalidated = true;
	}

	async validateSnapshots(
		request: GitStatusPageRequest,
		signal: AbortSignal,
		readRemote: () => Promise<GitStatusPageRawResult>,
	): Promise<GitStatusPageValidation> {
		const old = this.cacheState(request).memberVersion;
		let cache: GitStatusPageCacheState;
		try {
			cache = await this.observe(request, signal, readRemote);
		} catch {
			signal.throwIfAborted();
			return { changed: false, reliable: false };
		}
		const observation = this.observations.get(this.observationKey(request));
		return {
			changed: old !== cache.memberVersion,
			reliable: !!observation?.complete && !cache.errorCode,
		};
	}

	async assertScope(
		request: GitStatusPageRequest,
		signal: AbortSignal,
		readRemote: () => Promise<GitStatusPageRawResult>,
	): Promise<true> {
		if (this.closed) throw new GitStatusPageError("GIT_STATUS_PAGE_CLOSED");
		signal.throwIfAborted();
		this.prune();
		const expired = () =>
			new GitStatusPageError(
				"GIT_STATUS_PAGE_EXPIRED",
				"Git status range changed; refresh before retrying",
			);
		const proof = request.proof;
		const files = request.files;
		if (
			!proof ||
			!Array.isArray(proof.filter) ||
			proof.filter.length > 6 ||
			!proof.filter.every(isGitStatusFilterChar) ||
			(proof.section !== "staged" && proof.section !== "unstaged") ||
			!Array.isArray(files) ||
			files.length === 0 ||
			files.length > 10_000 ||
			!files.every((file) => typeof file === "string")
		)
			throw expired();
		const snapshot = this.snapshots.get(proof.snapshotId);
		if (
			!snapshot?.complete ||
			!this.isCurrent(snapshot) ||
			snapshot.identity !== this.identity(request) ||
			JSON.stringify(snapshot.filter) !== JSON.stringify(normalizeGitStatusFilter(proof.filter))
		)
			throw expired();
		let directory = proof.directory;
		if (directory !== undefined) {
			if (
				typeof directory !== "string" ||
				directory.length > 16_384 ||
				directory.includes("\0") ||
				directory.startsWith("/") ||
				directory.split("/").some((part) => part === "." || part === "..")
			)
				throw expired();
			directory = directory.replace(/\/+$/, "");
		}
		const expected = new Set(
			snapshot.files
				.filter(
					(file) =>
						gitStatusMatchesSection(file.status, proof.section, snapshot.filter) &&
						(!directory || file.path.startsWith(`${directory}/`)),
				)
				.map((file) => file.path),
		);
		if (
			new Set(files).size !== files.length ||
			files.length !== expected.size ||
			files.some((file) => !expected.has(file))
		)
			throw expired();
		const marker: ScanMarker = {
			queryKey: request.scope.queryKey,
			sourceIdentity: this.sourceIdentity(request),
			invalidated: false,
			observation: snapshot.observation,
			snapshot,
		};
		snapshot.references++;
		snapshot.observation.references++;
		this.scans.add(marker);
		try {
			const fresh = await this.scan(request, signal, readRemote);
			if (
				!fresh.complete ||
				marker.invalidated ||
				this.closed ||
				this.snapshots.get(snapshot.id) !== snapshot ||
				!this.isCurrent(snapshot) ||
				snapshot.fingerprint !== this.fingerprint(fresh.files)
			)
				throw expired();
			return true;
		} catch {
			signal.throwIfAborted();
			throw expired();
		} finally {
			this.scans.delete(marker);
			this.releaseObservation(marker);
		}
	}

	private isCurrent(snapshot: Snapshot): boolean {
		return (
			snapshot.observation.memberVersion === snapshot.memberVersion &&
			[...this.observations.values()].includes(snapshot.observation)
		);
	}
	private observationKey(request: GitStatusPageRequest): string {
		return JSON.stringify([request.scope.queryKey, this.sourceIdentity(request)]);
	}
	private async scan(
		request: GitStatusPageRequest,
		signal: AbortSignal,
		readRemote: () => Promise<GitStatusPageRawResult>,
	): Promise<GitStatusPageScan> {
		const scan =
			request.source.kind === "local"
				? await this.scanLocal(request.source.cwd, signal)
				: parseGitStatusPageRaw(await readRemote());
		signal.throwIfAborted();
		scan.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		return scan;
	}
	private fingerprint(files: readonly GitStatusPageFile[]): string {
		const hash = createHash("sha256");
		for (const file of files)
			hash
				.update(file.status)
				.update("\0")
				.update(file.path)
				.update("\0")
				.update(file.oldPath ?? "")
				.update("\0");
		return hash.digest("base64url");
	}
	private sourceIdentity(request: GitStatusPageRequest): string {
		return gitStatusPageSourceIdentity(request.source);
	}
	private identity(request: GitStatusPageRequest): string {
		return createHash("sha256")
			.update(
				JSON.stringify([
					request.scope.actorId,
					request.scope.workspaceKey,
					request.scope.queryKey,
					this.sourceIdentity(request),
				]),
			)
			.digest("base64url");
	}
	/** All 64 filter combinations are source-owned and charged once, never rebuilt by GET. */
	private buildMemberProjections(
		files: readonly GitStatusPageFile[],
		complete: boolean,
		maxBytes: number,
	): { projections: Map<string, MemberProjection>; bytes: number } {
		const projections = new Map<string, MemberProjection>();
		let bytes = 0;
		for (let mask = 0; mask < 64; mask++) {
			const filter = GIT_STATUS_FILTER_CHARS.filter((_, bit) => (mask & (1 << bit)) !== 0);
			const counts: GitStatusPageCounts = {
				totalFiles: files.length,
				staged: 0,
				unstaged: 0,
				untracked: 0,
				filteredFiles: 0,
				filteredStaged: 0,
				filteredUnstaged: 0,
				badgeCounts: { A: 0, M: 0, D: 0, R: 0, C: 0, U: 0 },
				exact: complete,
			};
			const indices: number[] = [];
			for (const [index, file] of files.entries()) {
				if (file.status === "??") counts.untracked++;
				else if (gitStatusInSection(file.status, "unstaged")) counts.unstaged++;
				if (gitStatusInSection(file.status, "staged")) counts.staged++;
				for (const section of ["staged", "unstaged"] as const)
					if (gitStatusInSection(file.status, section))
						counts.badgeCounts[gitStatusBadgeChar(file.status, section)]++;
				const staged = gitStatusMatchesSection(file.status, "staged", filter);
				const unstaged = gitStatusMatchesSection(file.status, "unstaged", filter);
				if (staged) counts.filteredStaged++;
				if (unstaged) counts.filteredUnstaged++;
				if (staged || unstaged) indices.push(index);
			}
			counts.filteredFiles = indices.length;
			const matches = new Uint32Array(indices);
			bytes += matches.byteLength + 512;
			if (bytes > maxBytes) throw new GitStatusPageError("GIT_STATUS_PAGE_BUSY");
			projections.set(filter.join(""), { matches, counts });
		}
		return { projections, bytes };
	}

	private canAdmitObservation(observation?: Observation): boolean {
		return (
			!!observation?.memberVersion ||
			[...this.observations.values()].filter((value) => value.memberVersion > 0).length <
				this.limits.snapshots ||
			[...this.observations.values()].some(
				(value) => value.memberVersion > 0 && !this.isLeased(value),
			)
		);
	}
	private reserve(bytes: number, protectedObservation?: Observation, metadataOnly = false): void {
		if (bytes > this.limits.bytes) throw new GitStatusPageError("GIT_STATUS_PAGE_BUSY");
		this.prune();
		while (this.bytes + bytes > this.limits.bytes) {
			const snapshot = this.snapshots.keys().next().value;
			if (snapshot) {
				this.drop(snapshot);
				continue;
			}
			const oldest = [...this.observations].find(
				([, observation]) => observation !== protectedObservation && !this.isLeased(observation),
			);
			if (!oldest) throw new GitStatusPageError("GIT_STATUS_PAGE_BUSY");
			this.dropObservation(oldest[0]);
		}
		if (
			!metadataOnly &&
			!protectedObservation?.memberVersion &&
			[...this.observations.values()].filter((value) => value.memberVersion > 0).length >=
				this.limits.snapshots
		) {
			const oldest = [...this.observations].find(
				([, value]) => value.memberVersion > 0 && !this.isLeased(value),
			);
			if (!oldest) throw new GitStatusPageError("GIT_STATUS_PAGE_BUSY");
			this.dropObservation(oldest[0]);
		}
		if (metadataOnly && this.observations.size >= 128) {
			const oldest = [...this.observations].find(
				([, value]) => !value.memberVersion && !this.isLeased(value),
			);
			if (!oldest) throw new GitStatusPageError("GIT_STATUS_PAGE_BUSY");
			this.dropObservation(oldest[0]);
		}
	}
	prune(): void {
		for (const snapshot of this.snapshots.values())
			if (this.now() - snapshot.lastUsed >= this.limits.idleMs) this.drop(snapshot.id);
	}
	private leaseKey(queryKey: string, sourceIdentity?: string): string {
		return JSON.stringify([queryKey, sourceIdentity ?? null]);
	}
	private isLeased(observation: Observation): boolean {
		return (
			this.leases.has(this.leaseKey(observation.queryKey, observation.sourceIdentity)) ||
			this.leases.has(this.leaseKey(observation.queryKey))
		);
	}
	retain(queryKey: string, sourceIdentity?: string): void {
		this.leases.add(this.leaseKey(queryKey, sourceIdentity));
	}
	release(queryKey: string, sourceIdentity?: string): void {
		this.leases.delete(this.leaseKey(queryKey, sourceIdentity));
		for (const scan of this.scans)
			if (
				scan.queryKey === queryKey &&
				(sourceIdentity === undefined || scan.sourceIdentity === sourceIdentity)
			)
				scan.invalidated = true;
		for (const [key, observation] of this.observations)
			if (
				observation.queryKey === queryKey &&
				(sourceIdentity === undefined || observation.sourceIdentity === sourceIdentity)
			)
				this.dropObservation(key);
		// Capacity release is the only automatic wake-up for admission failures.
		for (const observation of this.observations.values()) {
			if (observation.errorCode === "GIT_STATUS_PAGE_BUSY" && this.canAdmitObservation(observation))
				observation.errorCode = undefined;
			if (observation.statsErrorCode === "GIT_STATUS_PAGE_BUSY") {
				observation.statsErrorCode = undefined;
				observation.updating = true;
			}
		}
	}
	close(): void {
		this.closed = true;
		for (const scan of this.scans) scan.invalidated = true;
		for (const key of this.observations.keys()) this.dropObservation(key);
	}
	releaseSnapshot(snapshotId: string): void {
		this.drop(snapshotId);
	}
	get stats(): {
		snapshots: number;
		bytes: number;
		statisticsBytes: number;
		statisticsEntries: number;
	} {
		let statisticsBytes = 0;
		let statisticsEntries = 0;
		for (const observation of [...this.observations.values(), ...this.retiredObservations]) {
			statisticsBytes += observation.statsIndex?.bytes ?? 0;
			statisticsEntries +=
				(observation.statsIndex?.files.size ?? 0) +
				(observation.statsIndex?.directories.size ?? 0) +
				(observation.statsIndex?.buckets.size ?? 0);
		}
		return {
			snapshots: this.snapshots.size,
			bytes: this.bytes,
			statisticsBytes,
			statisticsEntries,
		};
	}
	private dropObservation(key: string, preserve?: ScanMarker): void {
		const observation = this.observations.get(key);
		if (!observation) return;
		observation.statsLoad?.controller.abort(new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED"));
		for (const snapshot of this.snapshots.values())
			if (snapshot.observation === observation) this.drop(snapshot.id);
		for (const scan of this.scans)
			if (
				scan !== preserve &&
				scan.queryKey === observation.queryKey &&
				scan.sourceIdentity === observation.sourceIdentity
			)
				scan.invalidated = true;
		// Native jobs still hold their old observation until cancellation/validation settles.
		if (observation.references) this.retiredObservations.add(observation);
		else this.bytes -= observation.bytes;
		this.observations.delete(key);
	}
	private releaseObservation(marker: ScanMarker): void {
		const snapshot = marker.snapshot;
		if (snapshot) {
			marker.snapshot = undefined;
			snapshot.references--;
			if (snapshot.references === 0 && !this.snapshots.has(snapshot.id))
				this.bytes -= snapshot.bytes;
		}
		const observation = marker.observation;
		if (!observation) return;
		marker.observation = undefined;
		observation.references--;
		if (observation.references === 0 && this.retiredObservations.delete(observation))
			this.bytes -= observation.bytes;
	}
	private drop(id: string): void {
		const snapshot = this.snapshots.get(id);
		if (!snapshot) return;
		if (snapshot.references === 0) this.bytes -= snapshot.bytes;
		this.snapshots.delete(id);
	}
	private validate(request: GitStatusPageRequest): {
		limit: number;
		filter: GitStatusFilterChar[];
		key: string;
	} {
		const limit = request.query.limit ?? GIT_STATUS_PAGE_DEFAULT_LIMIT;
		const rawFilter = request.query.filter ?? [];
		if (
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > GIT_STATUS_PAGE_MAX_LIMIT ||
			!Array.isArray(rawFilter) ||
			rawFilter.length > 6 ||
			!rawFilter.every(isGitStatusFilterChar) ||
			(request.query.cursor !== undefined &&
				(typeof request.query.cursor !== "string" ||
					request.query.cursor.length === 0 ||
					request.query.cursor.length > 2048))
		)
			throw new GitStatusPageError("GIT_STATUS_PAGE_INVALID_QUERY");
		for (const value of [
			request.scope.actorId,
			request.scope.workspaceKey,
			request.scope.queryKey,
			request.source.kind === "local" ? request.source.cwd : request.source.identity,
		])
			if (typeof value !== "string" || value.length === 0 || value.length > 16_384)
				throw new GitStatusPageError("GIT_STATUS_PAGE_INVALID_QUERY");
		const filter = normalizeGitStatusFilter(rawFilter);
		const key = createHash("sha256")
			.update(
				JSON.stringify([
					request.scope.actorId,
					request.scope.workspaceKey,
					request.scope.queryKey,
					request.source,
					filter,
					limit,
				]),
			)
			.digest("base64url");
		return { limit, filter, key };
	}
	private cursor(snapshot: Snapshot, offset: number): string {
		const payload = Buffer.from(
			JSON.stringify({ v: 1, s: snapshot.id, o: offset, k: snapshot.key }),
		).toString("base64url");
		return `${payload}.${createHmac("sha256", this.secret).update(payload).digest("base64url")}`;
	}
	private decodeCursor(value: string, key: string): Cursor {
		try {
			const parts = value.split(".");
			if (parts.length !== 2 || !parts.every((part) => /^[\w-]+$/.test(part))) throw new Error();
			const expected = createHmac("sha256", this.secret).update(parts[0]).digest();
			const actual = Buffer.from(parts[1], "base64url");
			if (actual.length !== expected.length || !timingSafeEqual(expected, actual))
				throw new Error();
			const cursor = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Cursor;
			if (
				cursor.v !== 1 ||
				typeof cursor.s !== "string" ||
				cursor.k !== key ||
				!Number.isSafeInteger(cursor.o) ||
				cursor.o <= 0
			)
				throw new Error();
			return cursor;
		} catch {
			throw new GitStatusPageError("GIT_STATUS_PAGE_INVALID_CURSOR");
		}
	}
	private page(
		snapshot: Snapshot,
		offset: number,
		limit: number,
	): Extract<GitStatusPageResult, { status: "ready" }> {
		const files: GitStatusPageFile[] = [];
		let bytes = 2048;
		let end = offset;
		while (end < snapshot.matches.length && files.length < limit) {
			const file = snapshot.files[snapshot.matches[end]];
			const size = Buffer.byteLength(JSON.stringify(file)) + 1;
			if (bytes + size > GIT_STATUS_PAGE_MAX_BYTES) {
				if (files.length === 0) throw new GitStatusPageError("GIT_STATUS_PAGE_RECORD_TOO_LARGE");
				break;
			}
			files.push(file);
			bytes += size;
			end++;
		}
		snapshot.lastUsed = this.now();
		const observation = snapshot.observation;
		const page: Extract<GitStatusPageResult, { status: "ready" }> = {
			status: "ready",
			cache: {
				status: "ready",
				workerEpoch: this.workerEpoch,
				memberVersion: observation.memberVersion,
				statsVersion: observation.statsVersion,
				updating: observation.updating,
				...(observation.errorCode ? { errorCode: observation.errorCode } : {}),
				...(observation.statsErrorCode ? { statsErrorCode: observation.statsErrorCode } : {}),
			},
			snapshotId: snapshot.id,
			expiresAt: snapshot.lastUsed + this.limits.idleMs,
			files,
			nextCursor: end < snapshot.matches.length ? this.cursor(snapshot, end) : null,
			hasMore: end < snapshot.matches.length,
			complete: snapshot.complete,
			limitReason: snapshot.limitReason,
			counts: snapshot.counts,
		};
		if (Buffer.byteLength(JSON.stringify(page)) > GIT_STATUS_PAGE_MAX_BYTES)
			throw new GitStatusPageError("GIT_STATUS_PAGE_RECORD_TOO_LARGE");
		if (this.snapshots.has(snapshot.id)) {
			this.snapshots.delete(snapshot.id);
			this.snapshots.set(snapshot.id, snapshot);
		}
		return page;
	}
}
