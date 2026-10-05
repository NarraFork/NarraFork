import {
	assertFixtureId,
	checkAbort,
	FIXTURE_DETACH_LIMITS,
	type FixtureEffectContext,
	type FixtureEffectStage,
	type FixtureId,
	type FixturePorts,
	type FixturePreparationStage,
	type FixtureReservation,
	type FixtureScope,
	type NormalizedSnapshot,
	snapshotDigest,
} from "./contract";
import { detachedImage } from "./planner";
import {
	type FixtureBackup,
	type FixtureRecoveryHold,
	type FixtureToken,
	IsolatedFixtureDetachStore,
} from "./store";

type CleanupObservation = "completed" | "unknown" | "failed" | "not-owned" | "unavailable";
/** A void TS callback can still return an async promise. Never assimilate arbitrary thenable getters. */
function observePromise(value: unknown): void {
	try {
		Promise.prototype.then.call(
			value,
			() => {},
			() => {},
		);
	} catch {
		// Not a native promise. In particular, do not read an untrusted then getter.
	}
}
function synchronousPort(run: () => unknown): CleanupObservation {
	try {
		const returned = run();
		if (returned === undefined) return "completed";
		observePromise(returned);
		return "unknown";
	} catch {
		return "failed";
	}
}
export interface FixtureDetachResult {
	status: "rejected" | "committed" | "compensated" | "recovery-required";
	reason?: string;
	/** True only while the store-owned independent fixture quarantine is verifiably held. */
	protectionRetained: boolean;
	fixtureQuarantine?: {
		kind: "fixture-store-recovery-quarantine";
		holdId: FixtureId;
		held: true;
		blocks: "fixture-admission-and-cas";
	};
	cleanupObservation?: {
		release?: CleanupObservation;
		/** Same-receipt retention is never continuous protection when its release is unknown. */
		retain?: CleanupObservation;
		pause?: CleanupObservation;
		quarantine?: CleanupObservation;
	};
	/** None of the fixture ports can restore filesystem, Podman, PTY or OAuth state. */
	rollbackScope: "none" | "database-only";
	/** No authority to retry/undo: these coordinates let fixture recovery prove the same afterimage/lease. */
	uncertainPreparation?: { stage: FixturePreparationStage; casCommitted: boolean };
	uncertainEffect?: {
		stage: FixtureEffectStage;
		afterImageDigest: string;
		reservationId: FixtureId;
		leaseVersion: number;
	};
}
function reason(error: unknown): string {
	return error instanceof Error ? error.message : "FIXTURE_FAILURE";
}
class UncertainFixtureEffect extends Error {
	constructor(
		readonly stage: FixtureEffectStage,
		cause: "TIMEOUT" | "ABORTED",
	) {
		super(`EFFECT_${cause}:${stage}`);
	}
}
class UncertainFixturePreparation extends Error {
	constructor(
		readonly stage: FixturePreparationStage,
		cause: "TIMEOUT" | "ABORTED",
	) {
		super(`PREPARATION_${cause}:${stage}`);
	}
}
/** Bound injected waiters; a late result is cleanup evidence, never authority to continue apply. */
async function boundedPort<T, S extends FixtureEffectStage | FixturePreparationStage>(input: {
	stage: S;
	deadlineAt: number;
	signal?: AbortSignal;
	controller: AbortController;
	uncertain(cause: "TIMEOUT" | "ABORTED"): Error;
	onUncertain?(): void;
	lateResult?(value: T): void;
	deferAbort?(): boolean;
	run(context: { stage: S; deadlineAt: number; signal: AbortSignal }): Promise<T>;
}): Promise<T> {
	checkAbort(input.signal);
	if (performance.now() >= input.deadlineAt) throw new Error("EFFECT_DEADLINE_BEFORE_DISPATCH");
	return await new Promise<T>((resolve, reject) => {
		let pending = true;
		let dispatched = false;
		const cleanup = () => {
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", onAbort);
		};
		const stop = (cause: "TIMEOUT" | "ABORTED") => {
			if (!pending) return;
			pending = false;
			cleanup();
			const error = dispatched ? input.uncertain(cause) : new Error(`PORT_${cause}`);
			input.onUncertain?.();
			input.controller.abort(error);
			reject(error);
		};
		const onAbort = () => {
			if (input.deferAbort?.()) input.controller.abort(new Error("ABORTED"));
			else stop("ABORTED");
		};
		const timer = setTimeout(
			() => stop("TIMEOUT"),
			Math.max(1, input.deadlineAt - performance.now()),
		);
		input.signal?.addEventListener("abort", onAbort, { once: true });
		const late = (succeeded: boolean, value?: unknown) => {
			if (!succeeded) return;
			try {
				input.lateResult?.(value as T);
			} catch {
				/* Keep paused; never resume after failed late cleanup. */
			}
		};
		const settle = (succeeded: boolean, value?: unknown) => {
			if (!pending) {
				late(succeeded, value);
				return;
			}
			if (performance.now() >= input.deadlineAt) {
				stop("TIMEOUT");
				late(succeeded, value);
				return;
			}
			pending = false;
			cleanup();
			if (succeeded) resolve(value as T);
			else reject(value);
		};
		try {
			if (input.signal?.aborted) {
				stop("ABORTED");
				return;
			}
			dispatched = true;
			Promise.resolve(
				input.run({
					stage: input.stage,
					deadlineAt: input.deadlineAt,
					signal: input.controller.signal,
				}),
			).then(
				(value) => settle(true, value),
				(error) => settle(false, error),
			);
		} catch (error) {
			settle(false, error);
		}
	});
}
/** Fixture-only executor. No production DB, lifecycle, narrator-start or filesystem imports. */
export async function applyFixtureDetach(input: {
	store: IsolatedFixtureDetachStore;
	ports: FixturePorts;
	token: FixtureToken;
	actorId: FixtureId;
	signal?: AbortSignal;
	now?: () => number;
	/** Fixture tests may shorten, never extend, the independent hard effect limit. */
	effectMilliseconds?: number;
	preparationMilliseconds?: number;
}): Promise<FixtureDetachResult> {
	const { store, ports, token, actorId, signal } = input;
	const now = input.now ?? Date.now;
	const effectMilliseconds = input.effectMilliseconds ?? FIXTURE_DETACH_LIMITS.effectMilliseconds;
	const preparationMilliseconds =
		input.preparationMilliseconds ?? FIXTURE_DETACH_LIMITS.preparationMilliseconds;
	const preparationController = new AbortController();
	const liveSignal = signal
		? AbortSignal.any([signal, preparationController.signal])
		: preparationController.signal;
	let operationClosed = false;
	let bodyActive = false;
	let bodyStarted = false;
	let bodyOutcome: FixtureDetachResult | undefined;
	let admissionSubmitted = false;
	let reservation: FixtureReservation | undefined;
	let reservationId: FixtureId | undefined;
	let scope: FixtureScope | undefined;
	let committed = false;
	let backup: FixtureBackup | undefined;
	let after: NormalizedSnapshot | undefined;
	let activeEffect: FixtureEffectStage | undefined;
	let retained = false;
	let releaseAttempted = false;
	let protectionReliability: boolean | undefined;
	let recoveryHold: FixtureRecoveryHold | undefined;
	const cleanupObservation: NonNullable<FixtureDetachResult["cleanupObservation"]> = {};
	const quarantine = (): void => {
		if (!recoveryHold) recoveryHold = store.acquireFixtureRecoveryHold();
		if (!store.hasFixtureRecoveryHold(recoveryHold)) throw new Error("FIXTURE_QUARANTINE_LOST");
	};
	const releaseUncertain = (): boolean =>
		releaseAttempted && cleanupObservation.release !== "completed";
	const protectedNow = (): boolean =>
		recoveryHold !== undefined && store.hasFixtureRecoveryHold(recoveryHold);
	const finish = (result: FixtureDetachResult): FixtureDetachResult => {
		const held = protectedNow();
		return {
			...result,
			protectionRetained: held,
			...(held && recoveryHold
				? {
						fixtureQuarantine: {
							kind: "fixture-store-recovery-quarantine" as const,
							holdId: recoveryHold.id,
							held: true as const,
							blocks: "fixture-admission-and-cas" as const,
						},
					}
				: {}),
			...(Object.values(cleanupObservation).some((value) => value !== "completed")
				? { cleanupObservation: { ...cleanupObservation } }
				: {}),
		};
	};
	const closeOperation = (error: unknown): void => {
		operationClosed = true;
		preparationController.abort(error);
	};
	const sameReceipt = (receipt: FixtureReservation, id: FixtureId): boolean =>
		receipt.fixtureAuthority === store.fixtureAuthority &&
		ports.fixtureAuthority === store.fixtureAuthority &&
		receipt.id === id;
	const isOwned = (receipt: FixtureReservation, id: FixtureId): boolean => {
		if (!sameReceipt(receipt, id)) return false;
		const owned: unknown = receipt.owned();
		if (typeof owned !== "boolean") observePromise(owned);
		return owned === true && sameReceipt(receipt, id);
	};
	const pause = (): CleanupObservation => {
		if (cleanupObservation.pause !== undefined) return cleanupObservation.pause;
		cleanupObservation.pause =
			scope && ports.fixtureAuthority === store.fixtureAuthority
				? synchronousPort(() => ports.pause(scope as FixtureScope))
				: "unavailable";
		if (ports.fixtureAuthority !== store.fixtureAuthority) cleanupObservation.pause = "unknown";
		return cleanupObservation.pause;
	};
	const hold = (
		receipt: FixtureReservation | undefined,
		id: FixtureId | undefined,
	): CleanupObservation => {
		try {
			if (!receipt || !id) return "unavailable";
			if (!isOwned(receipt, id)) return "not-owned";
			const observed = synchronousPort(() => receipt.retainProtection());
			if (!isOwned(receipt, id)) return "not-owned";
			return observed === "completed" && releaseUncertain() ? "unknown" : observed;
		} catch {
			return "failed";
		}
	};
	const protect = (): boolean => {
		let quarantineHeld = false;
		try {
			quarantine();
			quarantineHeld = true;
		} catch {
			cleanupObservation.quarantine = "failed";
		}
		if (protectionReliability !== undefined) {
			if (!quarantineHeld) protectionReliability = false;
			if (releaseUncertain() && cleanupObservation.retain === "completed") {
				cleanupObservation.retain = "unknown";
				protectionReliability = false;
			}
			// Memoize side effects, not their evidence: an admission tail can invalidate the receipt.
			try {
				if (
					cleanupObservation.retain === "completed" &&
					(!reservation || !reservationId || !isOwned(reservation, reservationId))
				) {
					cleanupObservation.retain = "not-owned";
					protectionReliability = false;
				}
			} catch {
				cleanupObservation.retain = "unknown";
				protectionReliability = false;
			}
			if (ports.fixtureAuthority !== store.fixtureAuthority) {
				cleanupObservation.pause = "unknown";
				protectionReliability = false;
			}
			return protectionReliability;
		}
		retained = true;
		cleanupObservation.retain = hold(reservation, reservationId);
		const paused = pause();
		protectionReliability =
			quarantineHeld && cleanupObservation.retain === "completed" && paused === "completed";
		return protectionReliability;
	};
	const release = (receipt: FixtureReservation, id: FixtureId, clearQuarantine = false): void => {
		if (releaseAttempted || !isOwned(receipt, id)) throw new Error("RESERVATION_LOST");
		// Acquire independent protection BEFORE dispatch: a returned promise may release much later.
		quarantine();
		releaseAttempted = true;
		cleanupObservation.release = "unknown";
		cleanupObservation.release = synchronousPort(() => receipt.release());
		try {
			if (!sameReceipt(receipt, id)) cleanupObservation.release = "unknown";
			if (cleanupObservation.release === "completed") {
				const owned: unknown = receipt.owned();
				if (typeof owned !== "boolean") observePromise(owned);
				if (owned !== false || !sameReceipt(receipt, id)) cleanupObservation.release = "unknown";
			}
		} catch {
			cleanupObservation.release = "unknown";
		}
		if (cleanupObservation.release !== "completed") throw new Error("RELEASE_UNCERTAIN");
		if (clearQuarantine && recoveryHold) {
			store.releaseFixtureRecoveryHold(recoveryHold);
			recoveryHold = undefined;
		}
	};
	try {
		if (
			!Number.isSafeInteger(effectMilliseconds) ||
			effectMilliseconds < 1 ||
			effectMilliseconds > FIXTURE_DETACH_LIMITS.effectMilliseconds
		)
			throw new Error("FIXTURE_EFFECT_BUDGET_INVALID");
		if (
			!Number.isSafeInteger(preparationMilliseconds) ||
			preparationMilliseconds < 1 ||
			preparationMilliseconds > FIXTURE_DETACH_LIMITS.preparationMilliseconds
		)
			throw new Error("FIXTURE_PREPARATION_BUDGET_INVALID");
		if (
			!(store instanceof IsolatedFixtureDetachStore) ||
			ports.fixtureAuthority !== store.fixtureAuthority
		) {
			throw new Error("FIXTURE_AUTHORITY_REQUIRED");
		}
		backup = store.validate(token, actorId, now(), signal);
		store.assertFixtureWorkAllowed();
		scope = {
			fixtureAuthority: store.fixtureAuthority,
			narratorId: backup.before.narrator.id,
			identity: structuredClone(backup.before.identity),
		};
		const verifiedScope = scope;
		reservation = await boundedPort({
			stage: "reserve",
			deadlineAt: performance.now() + preparationMilliseconds,
			signal,
			controller: preparationController,
			uncertain: (cause) => new UncertainFixturePreparation("reserve", cause),
			onUncertain: () => {
				operationClosed = true;
			},
			run: (context) => ports.reserve(verifiedScope, context.signal, context),
			lateResult: (lateReservation) => {
				if (lateReservation.fixtureAuthority !== store.fixtureAuthority) return;
				assertFixtureId(lateReservation.id);
				const id = lateReservation.id;
				try {
					if (isOwned(lateReservation, id)) release(lateReservation, id);
				} catch {
					// Unknown cleanup never grants authority to retry release or resume admission.
					hold(lateReservation, id);
					pause();
				}
			},
		});
		if (reservation.fixtureAuthority !== store.fixtureAuthority)
			throw new Error("RESERVATION_AUTHORITY");
		assertFixtureId(reservation.id);
		reservationId = reservation.id;
		const ownedScope = scope;
		const ownedReservation = reservation;
		const ownedId = reservationId;
		const admissionDeadline = performance.now() + preparationMilliseconds;
		const assert = (): void => {
			if (operationClosed || performance.now() >= admissionDeadline)
				throw new Error("PREPARATION_GATE_CLOSED");
			if (!isOwned(ownedReservation, ownedId)) throw new Error("RESERVATION_LOST");
			const observation = synchronousPort(() => ports.assertAdmission(ownedScope));
			if (observation !== "completed") throw new Error("ADMISSION_DENIED");
			if (!isOwned(ownedReservation, ownedId)) throw new Error("RESERVATION_LOST");
		};
		const runBody = async (): Promise<FixtureDetachResult> => {
			if (
				bodyStarted ||
				operationClosed ||
				liveSignal.aborted ||
				performance.now() >= admissionDeadline
			) {
				return {
					status: "rejected",
					reason: "PREPARATION_GATE_CLOSED",
					protectionRetained: protectedNow(),
					rollbackScope: "none",
				};
			}
			bodyStarted = true;
			bodyActive = true;
			try {
				checkAbort(liveSignal);
				assert();
				backup = store.validate(token, actorId, now(), liveSignal);
				after = detachedImage(backup.before);
				store.commit(token, actorId, after, assert, now(), liveSignal);
				committed = true;
				const deadlineAt = performance.now() + effectMilliseconds;
				const controller = new AbortController();
				const effect = async (
					stage: FixtureEffectStage,
					run: (context: FixtureEffectContext) => Promise<void>,
				): Promise<void> => {
					activeEffect = stage;
					try {
						await boundedPort({
							stage,
							deadlineAt,
							controller,
							signal: liveSignal,
							run,
							uncertain: (cause) => new UncertainFixtureEffect(stage, cause),
						});
					} finally {
						activeEffect = undefined;
					}
				};
				const checkAfter = (): void => {
					checkAbort(liveSignal);
					assert();
					if (
						snapshotDigest(store.read(), liveSignal) !==
						snapshotDigest(after as NormalizedSnapshot, liveSignal)
					) {
						throw new Error("POST_COMMIT_EVIDENCE_CHANGED");
					}
				};
				checkAfter();
				await effect("install", (context) =>
					ports.installRuntime(ownedScope, structuredClone(after as NormalizedSnapshot), context),
				);
				checkAfter();
				await effect("verify", (context) =>
					ports.verifyRuntime(ownedScope, structuredClone(after as NormalizedSnapshot), context),
				);
				checkAfter();
				await effect("publish", (context) =>
					ports.publish(ownedScope, structuredClone(after as NormalizedSnapshot), context),
				);
				checkAfter();
				return { status: "committed", protectionRetained: false, rollbackScope: "none" };
			} catch (error) {
				if (operationClosed) {
					return {
						status: "recovery-required",
						reason: "PREPARATION_GATE_CLOSED",
						protectionRetained: protectedNow(),
						rollbackScope: "none",
					};
				}
				if (!committed) {
					return {
						status: "rejected",
						reason: reason(error),
						protectionRetained: false,
						rollbackScope: "none",
					};
				}
				const protectionReliable = protect();
				if (error instanceof UncertainFixtureEffect && after) {
					return {
						status: "recovery-required",
						reason: reason(error),
						protectionRetained: protectedNow(),
						rollbackScope: "none",
						uncertainEffect: {
							stage: error.stage,
							afterImageDigest: snapshotDigest(after),
							reservationId: ownedReservation.id,
							leaseVersion: after.runtime.leaseVersion,
						},
					};
				}
				try {
					if (!backup || !after) throw new Error("MISSING_WHOLE_IMAGE");
					store.compensate(backup, after, assert);
					return {
						status: protectionReliable ? "compensated" : "recovery-required",
						reason: protectionReliable ? reason(error) : "PROTECTION_UNCERTAIN",
						protectionRetained: protectedNow(),
						rollbackScope: "database-only",
					};
				} catch (compensationError) {
					return {
						status: "recovery-required",
						reason: reason(compensationError),
						protectionRetained: protectedNow(),
						rollbackScope: "none",
					};
				}
			} finally {
				bodyActive = false;
			}
		};
		const body = (): Promise<FixtureDetachResult> => {
			const first = !bodyStarted && !operationClosed;
			const running = runBody();
			// Admission may detach the submitted body then reject; always own its rejection handler.
			running.then(
				(result) => {
					if (first) bodyOutcome = result;
				},
				() => {},
			);
			return running;
		};
		admissionSubmitted = true;
		const outcome = await boundedPort({
			stage: "admission",
			deadlineAt: admissionDeadline,
			signal,
			controller: preparationController,
			uncertain: (cause) => new UncertainFixturePreparation("admission", cause),
			onUncertain: () => {
				operationClosed = true;
			},
			deferAbort: () => bodyActive,
			run: (context) => ports.withAdmission(ownedScope, body, context),
		});
		// A returned admission must have awaited its sole owned body, not just submitted it.
		if (bodyActive || !bodyOutcome || outcome !== bodyOutcome) {
			throw new Error("ADMISSION_BODY_UNSETTLED");
		}
		if (outcome.status === "committed") {
			checkAbort(liveSignal);
			if (
				!isOwned(ownedReservation, ownedId) ||
				!after ||
				snapshotDigest(store.read()) !== snapshotDigest(after)
			) {
				throw new Error("ADMISSION_COMPLETION_EVIDENCE_CHANGED");
			}
			release(ownedReservation, ownedId, true);
		} else if (outcome.status === "rejected" && !operationClosed) {
			if (!isOwned(ownedReservation, ownedId)) {
				protect();
				return finish({
					status: "recovery-required",
					reason: "RESERVATION_LOST",
					protectionRetained: protectedNow(),
					rollbackScope: "none",
				});
			}
			release(ownedReservation, ownedId, true);
		}
		operationClosed = true;
		if (retained && !protect() && outcome.status === "compensated") {
			return finish({ ...outcome, status: "recovery-required", reason: "PROTECTION_UNCERTAIN" });
		}
		return finish(outcome);
	} catch (error) {
		// EVERY exceptional exit closes both the permanent body gate and cooperative effect signal.
		const uncertainStage = activeEffect;
		closeOperation(error);
		if (error instanceof UncertainFixturePreparation || admissionSubmitted || committed) {
			protect();
			return finish({
				status: "recovery-required",
				reason: reason(error),
				protectionRetained: protectedNow(),
				rollbackScope: bodyOutcome?.rollbackScope ?? "none",
				...(error instanceof UncertainFixturePreparation || admissionSubmitted
					? {
							uncertainPreparation: {
								stage: error instanceof UncertainFixturePreparation ? error.stage : "admission",
								casCommitted: committed,
							},
						}
					: {}),
				...(uncertainStage && after && reservationId
					? {
							uncertainEffect: {
								stage: uncertainStage,
								afterImageDigest: snapshotDigest(after),
								reservationId,
								leaseVersion: after.runtime.leaseVersion,
							},
						}
					: {}),
			});
		}
		if (reservation) {
			try {
				if (reservationId && isOwned(reservation, reservationId) && !releaseAttempted) {
					release(reservation, reservationId, true);
				} else protect();
			} catch {
				protect();
			}
		}
		return finish({
			status: retained ? "recovery-required" : "rejected",
			reason: reason(error),
			protectionRetained: retained,
			rollbackScope: "none",
		});
	}
}
