import { createHmac } from "node:crypto";
import { hotSafe } from "./hot-safe";
import { settings } from "./settings";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const ESCALATION_RESET_MS = 24 * HOUR;
const DEFAULT_MAX_ENTRIES_PER_BUCKET = 5_000;
const AUTH_HASH_CONCURRENCY = 4;
const OVERFLOW_BUCKET_KEY = "\0overflow";

interface BucketPolicy {
	maxFailures: number;
	windowMs: number;
	baseLockMs: number;
	maxLockMs: number;
	maxInFlight: number;
}

const PASSWORD_PAIR_POLICY: BucketPolicy = {
	maxFailures: 5,
	windowMs: 5 * MINUTE,
	baseLockMs: 30 * SECOND,
	maxLockMs: 15 * MINUTE,
	maxInFlight: 1,
};

const PASSWORD_ACCOUNT_POLICY: BucketPolicy = {
	maxFailures: 10,
	windowMs: 15 * MINUTE,
	baseLockMs: MINUTE,
	maxLockMs: 15 * MINUTE,
	maxInFlight: 1,
};

const PASSWORD_SOURCE_POLICY: BucketPolicy = {
	maxFailures: 30,
	windowMs: 5 * MINUTE,
	baseLockMs: MINUTE,
	maxLockMs: 15 * MINUTE,
	maxInFlight: 4,
};

const MFA_USER_POLICY: BucketPolicy = {
	maxFailures: 5,
	windowMs: 10 * MINUTE,
	baseLockMs: MINUTE,
	maxLockMs: 30 * MINUTE,
	maxInFlight: 1,
};

const MFA_SOURCE_POLICY: BucketPolicy = {
	maxFailures: 15,
	windowMs: 5 * MINUTE,
	baseLockMs: MINUTE,
	maxLockMs: 15 * MINUTE,
	maxInFlight: 4,
};

interface AttemptState {
	failures: number[];
	lockedUntil: number;
	lockLevel: number;
	inFlight: number;
	lastSeenAt: number;
	lastFailureAt: number;
}

interface LimiterStore {
	passwordAccounts: Map<string, AttemptState>;
	passwordPairs: Map<string, AttemptState>;
	passwordSources: Map<string, AttemptState>;
	mfaUsers: Map<string, AttemptState>;
	mfaSources: Map<string, AttemptState>;
	hashInFlight: number;
}

function createStore(): LimiterStore {
	return {
		passwordAccounts: new Map(),
		passwordPairs: new Map(),
		passwordSources: new Map(),
		mfaUsers: new Map(),
		mfaSources: new Map(),
		hashInFlight: 0,
	};
}

interface BucketReservation {
	key: string;
	state: AttemptState;
}

interface BucketStatus {
	blocked: boolean;
	busy: boolean;
	retryAfterMs: number;
	remaining: number;
}

class FailureBucket {
	constructor(
		private readonly states: Map<string, AttemptState>,
		private readonly policy: BucketPolicy,
		private readonly now: () => number,
		private readonly maxEntries: number,
	) {}

	private refresh(state: AttemptState, now: number): void {
		if (state.lastFailureAt > 0 && now - state.lastFailureAt >= ESCALATION_RESET_MS) {
			state.failures = [];
			state.lockLevel = 0;
			state.lockedUntil = 0;
		}
		if (state.lockedUntil <= now) state.lockedUntil = 0;
		const windowStart = now - this.policy.windowMs;
		state.failures = state.failures.filter((failureAt) => failureAt > windowStart);
	}

	private status(state: AttemptState, now: number, includeInFlight: boolean): BucketStatus {
		this.refresh(state, now);
		if (state.lockedUntil > now) {
			return {
				blocked: true,
				busy: false,
				retryAfterMs: state.lockedUntil - now,
				remaining: 0,
			};
		}
		if (
			includeInFlight &&
			(state.inFlight >= this.policy.maxInFlight ||
				state.failures.length + state.inFlight >= this.policy.maxFailures)
		) {
			return { blocked: true, busy: true, retryAfterMs: SECOND, remaining: 0 };
		}
		return {
			blocked: false,
			busy: false,
			retryAfterMs: 0,
			remaining: Math.max(
				0,
				this.policy.maxFailures - state.failures.length - (includeInFlight ? state.inFlight : 0),
			),
		};
	}

	private touch(key: string, state: AttemptState): void {
		this.states.delete(key);
		this.states.set(key, state);
	}

	private pruneInactive(now: number): void {
		for (const [key, state] of this.states) {
			this.refresh(state, now);
			if (
				state.inFlight === 0 &&
				state.failures.length === 0 &&
				state.lockedUntil === 0 &&
				state.lockLevel === 0
			) {
				this.states.delete(key);
			}
		}
	}

	private resolveKey(key: string): string {
		if (this.states.has(key) || key === OVERFLOW_BUCKET_KEY) return key;
		if (this.states.size < this.maxEntries) return key;
		this.pruneInactive(this.now());
		if (this.states.size < this.maxEntries) return key;
		// Never evict an active failure/lock record: doing so would let an attacker
		// flush a target account by spraying random identifiers. New keys share one
		// bounded overflow bucket until old state naturally expires.
		return OVERFLOW_BUCKET_KEY;
	}

	peek(key: string, includeInFlight = true): BucketStatus {
		const resolvedKey = this.resolveKey(key);
		const state = this.states.get(resolvedKey);
		if (!state) {
			return {
				blocked: false,
				busy: false,
				retryAfterMs: 0,
				remaining: this.policy.maxFailures,
			};
		}
		const now = this.now();
		const result = this.status(state, now, includeInFlight);
		state.lastSeenAt = now;
		if (
			state.inFlight === 0 &&
			state.failures.length === 0 &&
			state.lockedUntil === 0 &&
			state.lockLevel === 0
		) {
			this.states.delete(resolvedKey);
		} else {
			this.touch(resolvedKey, state);
		}
		return result;
	}

	reserve(key: string): BucketReservation | BucketStatus {
		const resolvedKey = this.resolveKey(key);
		const now = this.now();
		let state = this.states.get(resolvedKey);
		if (!state) {
			state = {
				failures: [],
				lockedUntil: 0,
				lockLevel: 0,
				inFlight: 0,
				lastSeenAt: now,
				lastFailureAt: 0,
			};
		}
		const status = this.status(state, now, true);
		if (status.blocked) {
			state.lastSeenAt = now;
			this.touch(resolvedKey, state);
			return status;
		}
		state.inFlight += 1;
		state.lastSeenAt = now;
		this.touch(resolvedKey, state);
		return { key: resolvedKey, state };
	}

	finishFailure(reservation: BucketReservation): BucketStatus {
		const now = this.now();
		const state = this.states.get(reservation.key) ?? reservation.state;
		state.inFlight = Math.max(0, state.inFlight - 1);
		this.refresh(state, now);
		state.failures.push(now);
		state.lastFailureAt = now;
		state.lastSeenAt = now;
		if (state.failures.length >= this.policy.maxFailures) {
			state.lockLevel += 1;
			const lockMs = Math.min(
				this.policy.baseLockMs * 2 ** Math.max(0, state.lockLevel - 1),
				this.policy.maxLockMs,
			);
			state.lockedUntil = now + lockMs;
			state.failures = [];
		}
		this.touch(reservation.key, state);
		return this.status(state, now, false);
	}

	finishSuccess(reservation: BucketReservation, clearFailures: boolean): void {
		const state = this.states.get(reservation.key) ?? reservation.state;
		state.inFlight = Math.max(0, state.inFlight - 1);
		state.lastSeenAt = this.now();
		// The overflow bucket represents many unrelated subjects. A success for
		// one of them must not erase the shared attack history for all the others.
		if (clearFailures && reservation.key !== OVERFLOW_BUCKET_KEY) {
			state.failures = [];
			state.lockedUntil = 0;
			state.lockLevel = 0;
			state.lastFailureAt = 0;
		}
		if (
			state.inFlight === 0 &&
			state.failures.length === 0 &&
			state.lockedUntil === 0 &&
			state.lockLevel === 0
		) {
			this.states.delete(reservation.key);
		} else {
			this.touch(reservation.key, state);
		}
	}

	cancel(reservation: BucketReservation): void {
		this.finishSuccess(reservation, false);
	}

	clear(): void {
		this.states.clear();
	}
}

export interface AuthAttemptBlocked {
	allowed: false;
	retryAfterMs: number;
	reason: "locked" | "busy";
	subjectLocked: boolean;
	sourceLocked: boolean;
}

export interface AuthAttemptFailure {
	locked: boolean;
	subjectLocked: boolean;
	sourceLocked: boolean;
	retryAfterMs: number;
	remaining: number;
}

export interface AuthAttemptLease {
	allowed: true;
	failure(): AuthAttemptFailure;
	success(): void;
	cancel(): void;
}

export type AuthAttemptDecision = AuthAttemptBlocked | AuthAttemptLease;

function blockedFrom(
	status: BucketStatus,
	scope: "subject" | "source" | "none",
): AuthAttemptBlocked {
	const locked = !status.busy;
	return {
		allowed: false,
		retryAfterMs: Math.max(SECOND, status.retryAfterMs),
		reason: status.busy ? "busy" : "locked",
		subjectLocked: locked && scope === "subject",
		sourceLocked: locked && scope === "source",
	};
}

function maxBlocked(
	statuses: BucketStatus[],
	subjectStatuses: BucketStatus[],
	sourceStatuses: BucketStatus[],
): AuthAttemptBlocked | null {
	const blocked = statuses.filter((status) => status.blocked);
	if (blocked.length === 0) return null;
	const longest = blocked.reduce((best, status) =>
		status.retryAfterMs > best.retryAfterMs ? status : best,
	);
	const result = blockedFrom(longest, "none");
	result.subjectLocked = subjectStatuses.some((status) => status.blocked && !status.busy);
	result.sourceLocked = sourceStatuses.some((status) => status.blocked && !status.busy);
	return result;
}

function emptyAttemptFailure(): AuthAttemptFailure {
	return {
		locked: false,
		subjectLocked: false,
		sourceLocked: false,
		retryAfterMs: 0,
		remaining: 0,
	};
}

function aggregateFailures(
	statuses: BucketStatus[],
	subjectStatuses: BucketStatus[],
	sourceStatuses: BucketStatus[],
): AuthAttemptFailure {
	const locked = statuses.filter((status) => status.blocked && !status.busy);
	return {
		locked: locked.length > 0,
		subjectLocked: subjectStatuses.some((status) => status.blocked && !status.busy),
		sourceLocked: sourceStatuses.some((status) => status.blocked && !status.busy),
		retryAfterMs: locked.reduce((max, status) => Math.max(max, status.retryAfterMs), 0),
		remaining: statuses.reduce((min, status) => Math.min(min, status.remaining), Infinity),
	};
}

export function fingerprintAuthIdentifier(identifier: string): string {
	return createHmac("sha256", settings.auth.jwtSecret)
		.update(identifier, "utf8")
		.digest("base64url")
		.slice(0, 24);
}

export class AuthAttemptLimiter {
	private readonly passwordAccounts: FailureBucket;
	private readonly passwordPairs: FailureBucket;
	private readonly passwordSources: FailureBucket;
	private readonly mfaUsers: FailureBucket;
	private readonly mfaSources: FailureBucket;

	constructor(
		now: () => number = Date.now,
		maxEntriesPerBucket = DEFAULT_MAX_ENTRIES_PER_BUCKET,
		private readonly store: LimiterStore = createStore(),
	) {
		this.passwordAccounts = new FailureBucket(
			store.passwordAccounts,
			PASSWORD_ACCOUNT_POLICY,
			now,
			maxEntriesPerBucket,
		);
		this.passwordPairs = new FailureBucket(
			store.passwordPairs,
			PASSWORD_PAIR_POLICY,
			now,
			maxEntriesPerBucket,
		);
		this.passwordSources = new FailureBucket(
			store.passwordSources,
			PASSWORD_SOURCE_POLICY,
			now,
			maxEntriesPerBucket,
		);
		this.mfaUsers = new FailureBucket(store.mfaUsers, MFA_USER_POLICY, now, maxEntriesPerBucket);
		this.mfaSources = new FailureBucket(
			store.mfaSources,
			MFA_SOURCE_POLICY,
			now,
			maxEntriesPerBucket,
		);
	}

	private reserveHashSlot(): (() => void) | AuthAttemptBlocked {
		if (this.store.hashInFlight >= AUTH_HASH_CONCURRENCY) {
			return {
				allowed: false,
				retryAfterMs: SECOND,
				reason: "busy",
				subjectLocked: false,
				sourceLocked: false,
			};
		}
		this.store.hashInFlight += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.store.hashInFlight = Math.max(0, this.store.hashInFlight - 1);
		};
	}

	beginPassword(identifier: string, sourceIp: string): AuthAttemptDecision {
		const account = fingerprintAuthIdentifier(identifier);
		const pair = `${account}:${sourceIp}`;
		const accountStatus = this.passwordAccounts.peek(account);
		const pairStatus = this.passwordPairs.peek(pair);
		const sourceStatus = this.passwordSources.peek(sourceIp);
		const precheck = maxBlocked(
			[accountStatus, pairStatus, sourceStatus],
			[accountStatus, pairStatus],
			[sourceStatus],
		);
		if (precheck) return precheck;

		const releaseHash = this.reserveHashSlot();
		if (typeof releaseHash !== "function") return releaseHash;

		const accountReservation = this.passwordAccounts.reserve(account);
		if (!("key" in accountReservation)) {
			releaseHash();
			return blockedFrom(accountReservation, "subject");
		}
		const pairReservation = this.passwordPairs.reserve(pair);
		if (!("key" in pairReservation)) {
			this.passwordAccounts.cancel(accountReservation);
			releaseHash();
			return blockedFrom(pairReservation, "subject");
		}
		const sourceReservation = this.passwordSources.reserve(sourceIp);
		if (!("key" in sourceReservation)) {
			this.passwordPairs.cancel(pairReservation);
			this.passwordAccounts.cancel(accountReservation);
			releaseHash();
			return blockedFrom(sourceReservation, "source");
		}

		let completed = false;
		const finish = (outcome: "failure" | "success" | "cancel"): AuthAttemptFailure => {
			if (completed) return emptyAttemptFailure();
			completed = true;
			releaseHash();
			if (outcome === "failure") {
				const accountStatus = this.passwordAccounts.finishFailure(accountReservation);
				const pairStatus = this.passwordPairs.finishFailure(pairReservation);
				const sourceStatus = this.passwordSources.finishFailure(sourceReservation);
				return aggregateFailures(
					[accountStatus, pairStatus, sourceStatus],
					[accountStatus, pairStatus],
					[sourceStatus],
				);
			}
			if (outcome === "success") {
				this.passwordAccounts.finishSuccess(accountReservation, true);
				this.passwordPairs.finishSuccess(pairReservation, true);
				this.passwordSources.finishSuccess(sourceReservation, false);
			} else {
				this.passwordAccounts.cancel(accountReservation);
				this.passwordPairs.cancel(pairReservation);
				this.passwordSources.cancel(sourceReservation);
			}
			return emptyAttemptFailure();
		};
		return {
			allowed: true,
			failure: () => finish("failure"),
			success: () => {
				finish("success");
			},
			cancel: () => {
				finish("cancel");
			},
		};
	}

	beginMfaSource(sourceIp: string): AuthAttemptDecision {
		return this.beginMfaInternal(null, sourceIp, false);
	}

	beginMfa(userId: string, sourceIp: string, requiresHashSlot: boolean): AuthAttemptDecision {
		return this.beginMfaInternal(userId, sourceIp, requiresHashSlot);
	}

	private beginMfaInternal(
		userId: string | null,
		sourceIp: string,
		requiresHashSlot: boolean,
	): AuthAttemptDecision {
		const userStatus = userId ? this.mfaUsers.peek(userId) : null;
		const sourceStatus = this.mfaSources.peek(sourceIp);
		const precheck = maxBlocked(
			userStatus ? [userStatus, sourceStatus] : [sourceStatus],
			userStatus ? [userStatus] : [],
			[sourceStatus],
		);
		if (precheck) return precheck;

		const releaseHash = requiresHashSlot ? this.reserveHashSlot() : () => {};
		if (typeof releaseHash !== "function") return releaseHash;

		const userReservation = userId ? this.mfaUsers.reserve(userId) : null;
		if (userReservation && !("key" in userReservation)) {
			releaseHash();
			return blockedFrom(userReservation, "subject");
		}
		const sourceReservation = this.mfaSources.reserve(sourceIp);
		if (!("key" in sourceReservation)) {
			if (userReservation && "key" in userReservation) this.mfaUsers.cancel(userReservation);
			releaseHash();
			return blockedFrom(sourceReservation, "source");
		}

		let completed = false;
		const finish = (outcome: "failure" | "success" | "cancel"): AuthAttemptFailure => {
			if (completed) return emptyAttemptFailure();
			completed = true;
			releaseHash();
			if (outcome === "failure") {
				const userStatus =
					userReservation && "key" in userReservation
						? this.mfaUsers.finishFailure(userReservation)
						: null;
				const sourceStatus = this.mfaSources.finishFailure(sourceReservation);
				return aggregateFailures(
					userStatus ? [userStatus, sourceStatus] : [sourceStatus],
					userStatus ? [userStatus] : [],
					[sourceStatus],
				);
			}
			if (userReservation && "key" in userReservation) {
				if (outcome === "success") this.mfaUsers.finishSuccess(userReservation, true);
				else this.mfaUsers.cancel(userReservation);
			}
			if (outcome === "success") this.mfaSources.finishSuccess(sourceReservation, false);
			else this.mfaSources.cancel(sourceReservation);
			return emptyAttemptFailure();
		};
		return {
			allowed: true,
			failure: () => finish("failure"),
			success: () => {
				finish("success");
			},
			cancel: () => {
				finish("cancel");
			},
		};
	}

	checkMfa(userId: string, sourceIp: string): AuthAttemptBlocked | null {
		const userStatus = this.mfaUsers.peek(userId, false);
		const sourceStatus = this.mfaSources.peek(sourceIp, false);
		return maxBlocked([userStatus, sourceStatus], [userStatus], [sourceStatus]);
	}

	clearForTests(): void {
		this.passwordAccounts.clear();
		this.passwordPairs.clear();
		this.passwordSources.clear();
		this.mfaUsers.clear();
		this.mfaSources.clear();
		this.store.hashInFlight = 0;
	}
}

const sharedStore = hotSafe("narrafork.authAttemptLimiter.v1", createStore);
export const authAttemptLimiter = new AuthAttemptLimiter(
	Date.now,
	DEFAULT_MAX_ENTRIES_PER_BUCKET,
	sharedStore,
);
