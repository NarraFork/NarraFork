import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { GitLineStats } from "../../shared/git-line-stats";
import {
	GIT_STATUS_PAGE_DEFAULT_LIMIT,
	GIT_STATUS_PAGE_MAX_BYTES,
	GIT_STATUS_PAGE_MAX_LIMIT,
	type GitStatusFilterChar,
	type GitStatusPage,
	type GitStatusPageCounts,
	type GitStatusPageFile,
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
// Same lifetime as the existing getGitWorkspaceLineStats source cache.
const GIT_STATUS_PAGE_STATS_TTL_MS = 5000;

interface StatsLoad {
	controller: AbortController;
	promise: Promise<GitStatusPageStatsIndex>;
	users: number;
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
	bytes: number;
	lastUsed: number;
	statsEpoch: number;
	statsIndex?: GitStatusPageStatsIndex;
	statsLoadedAt?: number;
	statsLoad?: StatsLoad;
}
interface ScanMarker {
	queryKey: string;
	sourceIdentity: string;
	invalidated: boolean;
	read: boolean;
	validationSequence: number;
	validating?: boolean;
	superseded?: boolean;
	expectedFingerprint?: string;
}
interface Cursor {
	v: 1;
	s: string;
	o: number;
	k: string;
}

/** Lives only inside the paging Worker. Parent messages contain at most one bounded page. */
export class GitStatusPageEngine {
	private readonly secret = randomBytes(32);
	private readonly snapshots = new Map<string, Snapshot>();
	private readonly scans = new Set<ScanMarker>();
	private validationSequence = 0;
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

	async read(
		request: GitStatusPageRequest,
		signal: AbortSignal,
		readRemote: () => Promise<GitStatusPageRawResult>,
	): Promise<GitStatusPage> {
		if (this.closed) throw new GitStatusPageError("GIT_STATUS_PAGE_CLOSED");
		signal.throwIfAborted();
		const { limit, filter, key } = this.validate(request);
		this.prune();
		if (request.query.cursor) {
			const cursor = this.decodeCursor(request.query.cursor, key);
			const snapshot = this.snapshots.get(cursor.s);
			if (!snapshot) throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
			if (snapshot.key !== key || cursor.o > snapshot.matches.length)
				throw new GitStatusPageError("GIT_STATUS_PAGE_INVALID_CURSOR");
			return this.page(snapshot, cursor.o, limit);
		}
		const marker: ScanMarker = {
			queryKey: request.scope.queryKey,
			sourceIdentity: this.sourceIdentity(request),
			invalidated: false,
			read: true,
			validationSequence: 0,
		};
		this.scans.add(marker);
		try {
			const scan = await this.scan(request, signal, readRemote);
			const fingerprint = this.fingerprint(scan.files);
			if (
				marker.invalidated ||
				this.closed ||
				(marker.expectedFingerprint !== undefined && marker.expectedFingerprint !== fingerprint)
			)
				throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
			const counts: GitStatusPageCounts = {
				totalFiles: scan.files.length,
				staged: 0,
				unstaged: 0,
				untracked: 0,
				filteredFiles: 0,
				filteredStaged: 0,
				filteredUnstaged: 0,
				badgeCounts: { A: 0, M: 0, D: 0, R: 0, C: 0, U: 0 },
				exact: scan.complete,
			};
			const indices: number[] = [];
			for (const [index, file] of scan.files.entries()) {
				if (file.status === "??") counts.untracked++;
				else if (gitStatusInSection(file.status, "unstaged")) counts.unstaged++;
				if (gitStatusInSection(file.status, "staged")) counts.staged++;
				for (const section of ["staged", "unstaged"] as const) {
					if (gitStatusInSection(file.status, section))
						counts.badgeCounts[gitStatusBadgeChar(file.status, section)]++;
				}
				const staged = gitStatusMatchesSection(file.status, "staged", filter);
				const unstaged = gitStatusMatchesSection(file.status, "unstaged", filter);
				if (staged) counts.filteredStaged++;
				if (unstaged) counts.filteredUnstaged++;
				if (staged || unstaged) indices.push(index);
			}
			counts.filteredFiles = indices.length;
			const matches = new Uint32Array(indices);
			const bytes =
				Buffer.byteLength(JSON.stringify(scan.files)) * 2 +
				scan.files.length * 256 +
				matches.byteLength +
				request.scope.queryKey.length * 2 +
				4096;
			if (bytes > this.limits.bytes)
				throw new GitStatusPageError(
					"GIT_STATUS_PAGE_BUSY",
					"Git status snapshot exceeds cache budget",
				);
			this.prune();
			while (
				this.snapshots.size >= this.limits.snapshots ||
				this.bytes + bytes > this.limits.bytes
			) {
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
				fingerprint,
				files: scan.files,
				matches,
				counts,
				complete: scan.complete,
				limitReason: scan.limitReason,
				bytes,
				lastUsed: this.now(),
				statsEpoch: 0,
			};
			// Check page serializability before publishing a cache entry.
			const page = this.page(snapshot, 0, limit);
			this.snapshots.set(snapshot.id, snapshot);
			this.bytes += bytes;
			return page;
		} finally {
			this.scans.delete(marker);
		}
	}

	async readStats(
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
			snapshot.identity !== this.identity(request) ||
			JSON.stringify(snapshot.filter) !== JSON.stringify(filter) ||
			JSON.stringify(filter) !== JSON.stringify(normalizeGitStatusFilter(query.filter))
		)
			throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
		const epoch = snapshot.statsEpoch;
		const current = () => {
			signal.throwIfAborted();
			this.prune();
			if (
				this.closed ||
				this.snapshots.get(snapshot.id) !== snapshot ||
				snapshot.statsEpoch !== epoch
			)
				throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
		};
		if (
			snapshot.statsIndex &&
			this.now() - (snapshot.statsLoadedAt ?? 0) >= GIT_STATUS_PAGE_STATS_TTL_MS
		)
			this.clearStats(snapshot);
		let index = snapshot.statsIndex;
		if (!index) {
			let load = snapshot.statsLoad;
			if (!load) {
				const controller = new AbortController();
				load = { controller, users: 0, promise: Promise.resolve({} as GitStatusPageStatsIndex) };
				snapshot.statsLoad = load;
				const owner = load;
				load.promise = (async () => {
					let stats: GitLineStats;
					try {
						stats = await readStats(controller.signal);
					} catch {
						controller.signal.throwIfAborted();
						// Unsupported/failed measurements remain unknown; never run a fallback source.
						stats = { files: [], linesAdded: 0, linesRemoved: 0, complete: false };
					}
					controller.signal.throwIfAborted();
					this.prune();
					if (
						this.closed ||
						this.snapshots.get(snapshot.id) !== snapshot ||
						snapshot.statsEpoch !== epoch
					)
						throw new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED");
					const built = buildGitStatusPageStatsIndex(
						snapshot.files,
						snapshot.filter,
						snapshot.complete,
						stats,
						this.limits.bytes - snapshot.bytes,
					);
					while (this.bytes + built.bytes > this.limits.bytes) {
						const oldest = [...this.snapshots.keys()].find((id) => id !== snapshot.id);
						if (!oldest) throw new GitStatusPageError("GIT_STATUS_PAGE_BUSY");
						this.drop(oldest);
					}
					snapshot.statsIndex = built;
					snapshot.statsLoadedAt = this.now();
					snapshot.bytes += built.bytes;
					this.bytes += built.bytes;
					return built;
				})().finally(() => {
					if (snapshot.statsLoad === owner) snapshot.statsLoad = undefined;
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
				if (load.users === 0 && snapshot.statsLoad === load) {
					snapshot.statsLoad = undefined;
					load.controller.abort(new GitStatusPageError("GIT_STATUS_PAGE_CANCELLED"));
				}
			}
		}
		current();
		const result = projectGitStatusPageStats(query, index);
		snapshot.lastUsed = this.now();
		this.snapshots.delete(snapshot.id);
		this.snapshots.set(snapshot.id, snapshot);
		return result;
	}

	invalidateStats(queryKey: string): void {
		for (const snapshot of this.snapshots.values()) {
			if (!gitStatusPageScopesOverlap(snapshot.queryKey, queryKey)) continue;
			snapshot.statsEpoch++;
			this.clearStats(snapshot);
			snapshot.statsLoad?.controller.abort(new GitStatusPageError("GIT_STATUS_PAGE_EXPIRED"));
			snapshot.statsLoad = undefined;
		}
	}

	private clearStats(snapshot: Snapshot): void {
		if (snapshot.statsIndex) {
			snapshot.bytes -= snapshot.statsIndex.bytes;
			this.bytes -= snapshot.statsIndex.bytes;
		}
		snapshot.statsIndex = undefined;
		snapshot.statsLoadedAt = undefined;
	}

	async validateSnapshots(
		request: GitStatusPageRequest,
		signal: AbortSignal,
		readRemote: () => Promise<GitStatusPageRawResult>,
	): Promise<GitStatusPageValidation> {
		if (this.closed) throw new GitStatusPageError("GIT_STATUS_PAGE_CLOSED");
		this.validate(request);
		signal.throwIfAborted();
		this.prune();
		const sourceIdentity = this.sourceIdentity(request);
		const matchesTarget = (queryKey: string, identity: string) =>
			queryKey === request.scope.queryKey && identity === sourceIdentity;
		const currentSnapshots = () =>
			[...this.snapshots.values()].filter((snapshot) =>
				matchesTarget(snapshot.queryKey, snapshot.sourceIdentity),
			);
		const reads = [...this.scans].filter(
			(scan) => scan.read && matchesTarget(scan.queryKey, scan.sourceIdentity),
		);
		if (currentSnapshots().length === 0 && reads.length === 0)
			return { changed: false, reliable: false };
		const marker: ScanMarker = {
			queryKey: request.scope.queryKey,
			sourceIdentity,
			invalidated: false,
			read: false,
			validating: true,
			validationSequence: ++this.validationSequence,
		};
		this.scans.add(marker);
		try {
			const fresh = await this.scan(request, signal, readRemote);
			if (marker.superseded) return { changed: false, reliable: false };
			if (marker.invalidated || this.closed) return { changed: true, reliable: false };
			if (!fresh.complete) return { changed: false, reliable: false };
			const fingerprint = this.fingerprint(fresh.files);
			// Only active jobs retain ordering metadata, so it stays bounded by the worker queue.
			for (const other of this.scans) {
				if (
					other.validating &&
					matchesTarget(other.queryKey, other.sourceIdentity) &&
					other.validationSequence < marker.validationSequence
				)
					other.superseded = true;
			}
			for (const read of reads) {
				if (this.scans.has(read) && read.validationSequence < marker.validationSequence) {
					read.expectedFingerprint = fingerprint;
					read.validationSequence = marker.validationSequence;
				}
			}
			// Include reads which published while the fresh scan was awaiting I/O.
			const snapshots = currentSnapshots();
			const changed = snapshots.some(
				(snapshot) => !snapshot.complete || snapshot.fingerprint !== fingerprint,
			);
			if (changed) {
				for (const snapshot of this.snapshots.values())
					if (gitStatusPageScopesOverlap(snapshot.queryKey, request.scope.queryKey))
						this.drop(snapshot.id);
			}
			return { changed, reliable: snapshots.length > 0 };
		} catch {
			signal.throwIfAborted();
			return { changed: false, reliable: false };
		} finally {
			this.scans.delete(marker);
		}
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
		const submitted = new Set(files);
		if (
			submitted.size !== files.length ||
			submitted.size !== expected.size ||
			files.some((file) => !expected.has(file))
		)
			throw expired();
		const marker: ScanMarker = {
			queryKey: request.scope.queryKey,
			sourceIdentity: this.sourceIdentity(request),
			invalidated: false,
			read: false,
			validationSequence: 0,
		};
		this.scans.add(marker);
		try {
			const fresh = await this.scan(request, signal, readRemote);
			if (
				!fresh.complete ||
				marker.invalidated ||
				this.closed ||
				this.snapshots.get(snapshot.id) !== snapshot ||
				snapshot.fingerprint !== this.fingerprint(fresh.files)
			) {
				this.invalidate(request.scope.queryKey);
				throw expired();
			}
			return true;
		} catch {
			signal.throwIfAborted();
			throw expired();
		} finally {
			this.scans.delete(marker);
		}
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
		return createHash("sha256").update(JSON.stringify(request.source)).digest("base64url");
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

	invalidate(queryKey: string): void {
		for (const snapshot of this.snapshots.values())
			if (gitStatusPageScopesOverlap(snapshot.queryKey, queryKey)) this.drop(snapshot.id);
		for (const scan of this.scans)
			if (gitStatusPageScopesOverlap(scan.queryKey, queryKey)) scan.invalidated = true;
	}

	prune(): void {
		for (const snapshot of this.snapshots.values())
			if (this.now() - snapshot.lastUsed >= this.limits.idleMs) this.drop(snapshot.id);
	}

	close(): void {
		this.closed = true;
		for (const scan of this.scans) scan.invalidated = true;
		for (const id of this.snapshots.keys()) this.drop(id);
		this.bytes = 0;
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
		for (const snapshot of this.snapshots.values()) {
			statisticsBytes += snapshot.statsIndex?.bytes ?? 0;
			statisticsEntries +=
				(snapshot.statsIndex?.files.size ?? 0) + (snapshot.statsIndex?.directories.size ?? 0);
		}
		return {
			snapshots: this.snapshots.size,
			bytes: this.bytes,
			statisticsBytes,
			statisticsEntries,
		};
	}

	private drop(id: string): void {
		const snapshot = this.snapshots.get(id);
		if (snapshot) {
			snapshot.statsEpoch++;
			snapshot.statsLoad?.controller.abort(
				new GitStatusPageError(this.closed ? "GIT_STATUS_PAGE_CLOSED" : "GIT_STATUS_PAGE_EXPIRED"),
			);
			snapshot.statsLoad = undefined;
			this.bytes -= snapshot.bytes;
			snapshot.statsIndex = undefined;
			snapshot.statsLoadedAt = undefined;
			this.snapshots.delete(id);
		}
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

	private page(snapshot: Snapshot, offset: number, limit: number): GitStatusPage {
		const files: GitStatusPageFile[] = [];
		let bytes = 2048; // Fixed DTO, counters, and signed cursor fit within this reserve.
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
		const hasMore = end < snapshot.matches.length;
		snapshot.lastUsed = this.now();
		const page: GitStatusPage = {
			snapshotId: snapshot.id,
			expiresAt: snapshot.lastUsed + this.limits.idleMs,
			files,
			nextCursor: hasMore ? this.cursor(snapshot, end) : null,
			hasMore,
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
