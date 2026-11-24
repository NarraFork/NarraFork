import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "../lib/errors";
import { hotSafe, hotTimer } from "../lib/hot-safe";
import { logger } from "../lib/logger";

export const BUFFER_EDIT_LEASE_MS = 120_000;
export interface BufferEditIdentity {
	messageId: string;
	userId: string;
	token: string;
}
interface Lease extends BufferEditIdentity {
	expiresAt: number;
	contentRevision: number;
}
interface MutationScope {
	narratorId: string;
	messageId?: string;
	active: boolean;
	signal?: AbortSignal;
	contentRevision?: number;
}
const conflict = () => new AppError("Buffered input is being edited", 409, "BUFFER_EDIT_CONFLICT");
export const staleBufferEdit = () =>
	new AppError("Buffered message changed since this edit started", 409, "BUFFER_EDIT_STALE");

/** Single-process admission only: never retains a database transaction or execution owner. */
export function createBufferEditHolds(now = Date.now, leaseMs = BUFFER_EDIT_LEASE_MS) {
	const leases = new Map<string, Lease>();
	const mutations = new Set<string>();
	const operations = new Map<
		string,
		{ abort: AbortController; done: Promise<void>; finish: () => void }
	>();
	const maintenance = new Map<string, Promise<void>>();
	const authorizationBarriers = new Set<string>();
	const deferred = new Set<string>();
	const locks = new Map<string, Promise<void>>();
	const scope = new AsyncLocalStorage<MutationScope>();
	let listener: ((narratorId: string) => void | Promise<void>) | undefined;
	const changed = (id: string) => {
		try {
			Promise.resolve(listener?.(id)).catch((error) =>
				logger.warn("Buffer edit hold control deferred", { narratorId: id, error: String(error) }),
			);
		} catch (error) {
			logger.warn("Buffer edit hold control deferred", { narratorId: id, error: String(error) });
		}
	};
	const held = (id: string) => {
		if (mutations.has(id)) deferred.add(id);
		return leases.has(id) || mutations.has(id) || authorizationBarriers.has(id);
	};
	const expire = () => {
		for (const [id, lease] of leases) {
			if (lease.expiresAt <= now() && !mutations.has(id) && !authorizationBarriers.has(id)) {
				leases.delete(id);
				changed(id);
			}
		}
	};
	const exclusive = async <T>(id: string, work: () => T | Promise<T>): Promise<T> => {
		const previous = locks.get(id) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		locks.set(id, next);
		await previous;
		try {
			return await work();
		} finally {
			release();
			if (locks.get(id) === next) locks.delete(id);
		}
	};
	const matches = (lease: Lease, identity: BufferEditIdentity) =>
		lease.messageId === identity.messageId &&
		lease.userId === identity.userId &&
		lease.token === identity.token;
	const response = (lease: Lease) => ({
		ok: true as const,
		token: lease.token,
		expiresAt: lease.expiresAt,
		leaseMs,
		contentRevision: lease.contentRevision,
	});
	return {
		held,
		expire,
		exclusive,
		mutationSignal: () => scope.getStore()?.signal,
		assertMutationRevision(contentRevision: number) {
			const current = scope.getStore();
			if (
				current?.active &&
				current.contentRevision !== undefined &&
				current.contentRevision !== contentRevision
			)
				throw staleBufferEdit();
		},
		/** Internal authorization-loss cleanup only; no release event may wake a revoked runtime. */
		quiesceForAuthorizationLoss(
			id: string,
			stop: () => void | Promise<void>,
			clear: () => Promise<void>,
		): Promise<void> {
			const pending = maintenance.get(id);
			if (pending) return pending;
			authorizationBarriers.add(id);
			const task = exclusive(id, () => {
				leases.delete(id);
				deferred.delete(id);
				const operation = operations.get(id);
				operation?.abort.abort(
					new AppError("Narrator authorization revoked", 403, "AUTHORIZATION_REVOKED"),
				);
				return operation;
			})
				.then(async (operation) => {
					let failure: unknown;
					try {
						await stop();
					} catch (error) {
						failure = error;
					}
					await operation?.done;
					const current: MutationScope = { narratorId: id, active: true };
					try {
						await scope.run(current, clear);
					} finally {
						current.active = false;
					}
					if (failure) throw failure;
					authorizationBarriers.delete(id);
				})
				.finally(() => {
					maintenance.delete(id);
				});
			maintenance.set(id, task);
			return task;
		},
		setListener(next: typeof listener) {
			const previous = listener;
			listener = next;
			return previous;
		},
		async begin(
			id: string,
			identity: BufferEditIdentity,
			readRevision: () => Promise<number | undefined>,
			expectedRevision?: number,
		) {
			return exclusive(id, async () => {
				expire();
				if (authorizationBarriers.has(id)) throw conflict();
				const existing = leases.get(id);
				if (existing ? !matches(existing, identity) : mutations.has(id)) throw conflict();
				const contentRevision = await readRevision();
				// Revocation can install its barrier synchronously while this lock awaits the read.
				if (authorizationBarriers.has(id) || contentRevision === undefined) throw conflict();
				// A retried begin is not permission to replace an editor's original snapshot.
				if (
					(expectedRevision !== undefined && expectedRevision !== contentRevision) ||
					(existing && existing.contentRevision !== contentRevision)
				)
					throw staleBufferEdit();
				if (existing) {
					const registered = leases.get(id);
					if (registered && registered !== existing) throw conflict();
					existing.expiresAt = now() + leaseMs;
					// The unlocked expiry sweep may have removed this lease during the read.
					// Restore it before success/claim admission, retaining its validated baseline.
					leases.set(id, existing);
					if (!registered) changed(id);
					return response(existing);
				}
				const lease = { ...identity, expiresAt: now() + leaseMs, contentRevision };
				leases.set(id, lease);
				changed(id);
				return response(lease);
			});
		},
		async renew(id: string, identity: BufferEditIdentity, expectedRevision?: number) {
			return exclusive(id, () => {
				expire();
				const lease = leases.get(id);
				if (!lease || !matches(lease, identity)) throw conflict();
				if (expectedRevision !== undefined && expectedRevision !== lease.contentRevision)
					throw staleBufferEdit();
				lease.expiresAt = now() + leaseMs;
				return response(lease);
			});
		},
		async release(id: string, identity: BufferEditIdentity) {
			await exclusive(id, () => {
				const lease = leases.get(id);
				// A stale cancellation is idempotent and cannot release a replacement lease.
				if (!lease || !matches(lease, identity)) return;
				if (mutations.has(id)) throw conflict();
				leases.delete(id);
				changed(id);
			});
		},
		async mutate<T>(
			id: string,
			messageId: string | undefined,
			work: () => Promise<T>,
			identity?: BufferEditIdentity,
		): Promise<T> {
			const parent = scope.getStore();
			if (
				parent?.active &&
				parent.narratorId === id &&
				(!parent.messageId || parent.messageId === messageId)
			) {
				parent.signal?.throwIfAborted();
				return work();
			}
			let lease: Lease | undefined;
			let finish!: () => void;
			const operation = {
				abort: new AbortController(),
				done: new Promise<void>((resolve) => {
					finish = resolve;
				}),
				finish: () => finish(),
			};
			await exclusive(id, () => {
				expire();
				lease = leases.get(id);
				if (
					authorizationBarriers.has(id) ||
					mutations.has(id) ||
					(lease
						? !identity || identity.messageId !== messageId || !matches(lease, identity)
						: identity !== undefined)
				)
					throw conflict();
				mutations.add(id);
				operations.set(id, operation);
			});
			const current = {
				narratorId: id,
				messageId,
				active: true,
				signal: operation.abort.signal,
				contentRevision: lease?.contentRevision,
			};
			try {
				return await scope.run(current, work);
			} finally {
				current.active = false;
				mutations.delete(id);
				operations.delete(id);
				operation.finish();
				// Save failures retain their hold and give the editor a full retry window.
				const needsWake = deferred.delete(id);
				if (lease && leases.get(id) === lease) lease.expiresAt = now() + leaseMs;
				else if (needsWake && !authorizationBarriers.has(id)) changed(id);
			}
		},
	};
}

export const bufferEditHolds = hotSafe("nf:buffer-edit-holds:v1", () => createBufferEditHolds());
hotTimer("nf:buffer-edit-expiration:v1", () => {
	const timer = setInterval(() => bufferEditHolds.expire(), 1_000);
	timer.unref();
	return timer;
});
export const isBufferConsumptionHeld = (narratorId: string): boolean =>
	bufferEditHolds.held(narratorId);
