import { setImmediate as yieldTick } from "node:timers/promises";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
	fileChangeBlobs,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
	remoteDevices,
	revertOperationFiles,
	revertOperations,
	workspaceWriteLeases,
} from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { getDeviceConnectionGeneration } from "./device-connection-service";
import {
	reconcileRemoteFileOperation,
	reconcileRemoteRevertPlan,
} from "./remote-history-control-recovery";
import { assertRemoteRecoveryAuth } from "./remote-history-recovery-auth";
import {
	getRemoteWorkspaceHistoryRuntime,
	RemoteWorkspaceHistoryRuntime,
} from "./remote-workspace-history-runtime";
import { RemoteRestoreParser } from "./remote-workspace-restore-parser";
import {
	type RemoteWorkspaceRestoreConfirmation,
	RemoteWorkspaceRestoreService,
} from "./remote-workspace-restore-service";

export const REMOTE_HISTORY_RECOVERY_LIMITS = Object.freeze({
	page: 32,
	leasesPerPass: 64,
	metadataBytes: 16 * 1024,
	selectorBytes: 64 * 1024,
	queuedDevices: 64,
	activeDevices: 2,
	deviceIntervalMs: 60_000,
	timeoutMs: 30_000,
});
export interface RemoteRecoveryPassSummary {
	visited: number;
	released: number;
	manual: number;
	budgetReached: boolean;
	cancelled: boolean;
	unavailable: boolean;
}
export interface RemoteRecoveryDispatcherOptions {
	registry(): Promise<RemoteWorkspaceHistoryRuntime>;
	generation(deviceId: string): number | null;
	onSummary?(summary: RemoteRecoveryPassSummary): void;
	now?(): number;
}
interface Job {
	deviceId: string;
	generation: number;
	controller: AbortController;
	due: number;
}
/** No IO on connect callbacks. Global active/queue caps and one start/device/minute;
 * a new authenticated generation cancels old work instead of relabelling its roots. */
export class RemoteHistoryRecoveryDispatcher {
	private readonly queued = new Map<string, Job>();
	private readonly active = new Map<string, Job>();
	private readonly lastStarted = new Map<string, number>();
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = false;
	private readonly idle = new Set<() => void>();
	constructor(private readonly options: RemoteRecoveryDispatcherOptions) {}
	enqueue(deviceId: string, generation: number) {
		if (
			this.stopped ||
			!deviceId ||
			!Number.isSafeInteger(generation) ||
			generation < 1 ||
			this.options.generation(deviceId) !== generation
		)
			return false;
		const old = this.active.get(deviceId) ?? this.queued.get(deviceId);
		if (old?.generation === generation) {
			this.schedule();
			return true;
		}
		if (old) {
			old.controller.abort(new Error("Authenticated recovery generation replaced"));
			this.queued.delete(deviceId);
		}
		if (
			!this.queued.has(deviceId) &&
			this.queued.size >= REMOTE_HISTORY_RECOVERY_LIMITS.queuedDevices
		)
			return false;
		// The cooldown map shares the global device bound, never grows without limit.
		const known = () =>
			new Set([...this.lastStarted.keys(), ...this.queued.keys(), ...this.active.keys()]);
		if (!known().has(deviceId) && known().size >= REMOTE_HISTORY_RECOVERY_LIMITS.queuedDevices) {
			const now = this.now();
			for (const [id, time] of this.lastStarted)
				if (
					now - time >= REMOTE_HISTORY_RECOVERY_LIMITS.deviceIntervalMs &&
					!this.active.has(id) &&
					!this.queued.has(id)
				)
					this.lastStarted.delete(id);
			if (known().size >= REMOTE_HISTORY_RECOVERY_LIMITS.queuedDevices) return false;
		}
		this.queued.set(deviceId, {
			deviceId,
			generation,
			controller: new AbortController(),
			due: Math.max(
				this.now(),
				(this.lastStarted.get(deviceId) ?? -Infinity) +
					REMOTE_HISTORY_RECOVERY_LIMITS.deviceIntervalMs,
			),
		});
		this.schedule();
		return true;
	}
	cancel(deviceId: string) {
		this.active
			.get(deviceId)
			?.controller.abort(new Error("Authenticated recovery connection ended"));
		this.queued.get(deviceId)?.controller.abort();
		this.queued.delete(deviceId);
		this.schedule();
	}
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const job of this.active.values()) job.controller.abort();
		this.queued.clear();
		this.notifyIdle();
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.whenIdle(),
				new Promise<never>((_resolve, reject) => {
					drainTimer = setTimeout(
						() => reject(new Error("Remote history recovery shutdown drain timed out")),
						5_000,
					);
				}),
			]);
		} finally {
			if (drainTimer) clearTimeout(drainTimer);
		}
	}
	whenIdle(): Promise<void> {
		if (!this.active.size && !this.queued.size) return Promise.resolve();
		return new Promise((resolve) => this.idle.add(resolve));
	}
	private now() {
		return this.options.now?.() ?? Date.now();
	}
	private notifyIdle() {
		if (this.active.size || this.queued.size) return;
		for (const resolve of this.idle) resolve();
		this.idle.clear();
	}
	private schedule() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.stopped || !this.queued.size) {
			this.notifyIdle();
			return;
		}
		if (this.active.size >= REMOTE_HISTORY_RECOVERY_LIMITS.activeDevices) return;
		const ready = [...this.queued.values()].filter((job) => !this.active.has(job.deviceId));
		if (!ready.length) return;
		const due = Math.min(...ready.map((job) => job.due));
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				this.pump();
			},
			Math.max(0, due - this.now()),
		);
		this.timer.unref();
	}
	private pump() {
		if (this.stopped) return;
		for (const [id, job] of this.queued) {
			if (this.active.size >= REMOTE_HISTORY_RECOVERY_LIMITS.activeDevices) break;
			if (this.active.has(id) || job.due > this.now()) continue;
			this.queued.delete(id);
			if (this.options.generation(id) !== job.generation) continue;
			this.active.set(id, job);
			this.lastStarted.set(id, this.now());
			void this.run(job).finally(() => {
				if (this.active.get(id) === job) this.active.delete(id);
				this.schedule();
			});
		}
		this.schedule();
	}
	private async run(job: Job) {
		const signal = AbortSignal.any([
			job.controller.signal,
			AbortSignal.timeout(REMOTE_HISTORY_RECOVERY_LIMITS.timeoutMs),
		]);
		const summary: RemoteRecoveryPassSummary = {
			visited: 0,
			released: 0,
			manual: 0,
			budgetReached: false,
			cancelled: false,
			unavailable: false,
		};
		const current = () => {
			signal.throwIfAborted();
			if (this.options.generation(job.deviceId) !== job.generation)
				throw new Error("Authenticated recovery connection changed");
		};
		try {
			current();
			const registry = await this.options.registry();
			current();
			let cursor: string | undefined;
			while (summary.visited < REMOTE_HISTORY_RECOVERY_LIMITS.leasesPerPass) {
				current();
				const page = registry.options.db
					.select({
						id: workspaceWriteLeases.leaseId,
						scopeId: workspaceWriteLeases.scopeId,
						fence: workspaceWriteLeases.fencingToken,
						bytes: sql<number>`octet_length(${workspaceWriteLeases.mutationManifestJson})`,
					})
					.from(workspaceWriteLeases)
					.where(
						and(
							eq(workspaceWriteLeases.deviceId, job.deviceId),
							sql`${workspaceWriteLeases.status} in ('executing','quarantined')`,
							cursor ? gt(workspaceWriteLeases.leaseId, cursor) : undefined,
						),
					)
					.orderBy(asc(workspaceWriteLeases.leaseId))
					.limit(REMOTE_HISTORY_RECOVERY_LIMITS.page + 1)
					.all();
				for (const row of page.slice(0, REMOTE_HISTORY_RECOVERY_LIMITS.page)) {
					current();
					summary.visited++;
					cursor = row.id;
					try {
						if (row.bytes > REMOTE_HISTORY_RECOVERY_LIMITS.metadataBytes)
							throw new Error("Recovery metadata budget");
						if (await this.recoverLease(registry, job, row, signal, current)) summary.released++;
						else summary.manual++;
					} catch {
						current();
						summary.manual++;
					}
					await yieldTick();
				}
				if (page.length <= REMOTE_HISTORY_RECOVERY_LIMITS.page) break;
				if (summary.visited >= REMOTE_HISTORY_RECOVERY_LIMITS.leasesPerPass)
					summary.budgetReached = true;
			}
		} catch {
			// Explicit counters, never interpret cancellation as a successful empty pass.
			summary.cancelled =
				signal.aborted || this.options.generation(job.deviceId) !== job.generation;
			summary.unavailable = !summary.cancelled;
		} finally {
			try {
				this.options.onSummary?.(Object.freeze(summary));
			} catch {
				/* Observer is not authority. */
			}
		}
	}
	private async recoverLease(
		registry: RemoteWorkspaceHistoryRuntime,
		job: Job,
		row: { id: string; scopeId: string; fence: number },
		signal: AbortSignal,
		current: () => void,
	) {
		const scopeBudget = registry.options.db
			.select({
				bytes: sql<number>`coalesce(octet_length(${fileChangeScopes.rootIdentityJson}),0) + octet_length(${fileChangeScopes.canonicalRoot}) + octet_length(${fileChangeScopes.displayRoot})`,
			})
			.from(fileChangeScopes)
			.where(eq(fileChangeScopes.id, row.scopeId))
			.get();
		if (!scopeBudget || scopeBudget.bytes > REMOTE_HISTORY_RECOVERY_LIMITS.metadataBytes)
			return false;
		const scope = registry.evidence.getScope(row.scopeId);
		if (
			!scope ||
			scope.deviceId !== job.deviceId ||
			!["active", "needs_verification"].includes(scope.status) ||
			!scope.rootIdentityJson?.object ||
			!scope.sourceInstanceId ||
			!scope.workspaceInstanceId ||
			scope.canonicalRoot.length > 4096
		)
			return false;
		const lease = registry.options.db
			.select({ manifest: workspaceWriteLeases.mutationManifestJson })
			.from(workspaceWriteLeases)
			.where(
				and(
					eq(workspaceWriteLeases.leaseId, row.id),
					sql`octet_length(${workspaceWriteLeases.mutationManifestJson}) <= ${REMOTE_HISTORY_RECOVERY_LIMITS.metadataBytes}`,
				),
			)
			.get();
		const mutations = lease?.manifest.mutations;
		if (!mutations?.length || mutations.length > FILE_CHANGE_LIMITS.revertFiles) return false;
		const opId = mutations[0].operationId;
		if (opId) {
			if (mutations.length !== 1) return false;
			const operation = registry.options.db
				.select({
					ownerUserId: fileChangeOperations.ownerUserId,
					narratorId: fileChangeOperations.narratorId,
					projectId: fileChangeOperations.projectId,
					sourceInstanceId: fileChangeOperations.sourceInstanceId,
					sourceKind: fileChangeOperations.sourceKind,
					actorJson: fileChangeOperations.actorJson,
					executionBindingJson: fileChangeOperations.executionBindingJson,
				})
				.from(fileChangeOperations)
				.where(
					and(
						eq(fileChangeOperations.id, opId),
						sql`octet_length(${fileChangeOperations.actorJson}) + octet_length(${fileChangeOperations.executionBindingJson}) <= ${REMOTE_HISTORY_RECOVERY_LIMITS.metadataBytes}`,
					),
				)
				.get();
			if (
				!operation?.ownerUserId ||
				!operation.narratorId ||
				operation.sourceInstanceId !== scope.sourceInstanceId ||
				operation.executionBindingJson?.fencingToken !== row.fence ||
				operation.executionBindingJson.deviceId !== job.deviceId
			)
				return false;
			const effects = registry.options.db
				.select({
					id: fileChangeEffects.id,
					scopeId: fileChangeEffects.scopeId,
					mutationId: fileChangeEffects.mutationId,
					bytes: sql<number>`octet_length(${fileChangeEffects.identityJson}) + octet_length(${fileChangeEffects.beforeStateJson}) + octet_length(${fileChangeEffects.intendedAfterStateJson}) + octet_length(${fileChangeEffects.observedAfterStateJson}) + coalesce(octet_length(${fileChangeEffects.executionReceiptJson}),0)`,
				})
				.from(fileChangeEffects)
				.where(eq(fileChangeEffects.operationId, opId))
				.limit(2)
				.all();
			if (
				effects.length !== 1 ||
				effects[0].id !== mutations[0].effectId ||
				effects[0].scopeId !== scope.id ||
				effects[0].mutationId !== mutations[0].mutationId ||
				effects[0].bytes > REMOTE_HISTORY_RECOVERY_LIMITS.metadataBytes
			)
				return false;
			const actor = operation.actorJson as typeof operation.actorJson & {
				recoveryAuth?: unknown;
				recoveryOrigin?: { narratorId: string; projectId: string | null };
			};
			if (
				actor.recoveryOrigin?.narratorId !== operation.narratorId ||
				actor.recoveryOrigin.projectId !== operation.projectId ||
				(operation.sourceKind === "editor" &&
					(actor.kind !== "human" ||
						actor.userId !== operation.ownerUserId ||
						actor.subjectKey !== `human:${operation.ownerUserId}`))
			)
				return false;
			await assertRemoteRecoveryAuth(registry, actor.recoveryAuth, operation.ownerUserId, signal);
			const guarded = this.guard(registry, actor.recoveryAuth, operation.ownerUserId, current, {
				deviceId: job.deviceId,
				narratorId: operation.narratorId,
				projectId: operation.projectId,
				root: scope.canonicalRoot,
			});
			const result = await reconcileRemoteFileOperation({
				registry: guarded,
				principal: { userId: operation.ownerUserId, isAdmin: false },
				operationId: opId,
				signal,
			});
			return result.barrierReleased;
		}
		// A revert lease has immutable apply mutation IDs, not an inferred current narrator.
		const file = registry.options.db
			.select({ planId: revertOperationFiles.revertOperationId })
			.from(revertOperationFiles)
			.where(eq(revertOperationFiles.applyMutationId, mutations[0].mutationId))
			.get();
		if (!file) return false;
		const plan = registry.options.db
			.select({
				id: revertOperations.id,
				narratorId: revertOperations.narratorId,
				owner: revertOperations.requestedBySubjectKey,
				projectId: revertOperations.projectId,
				status: revertOperations.status,
				scope: revertOperations.scope,
				hash: revertOperations.planHash,
				selector: revertOperations.selectorBlobDigest,
			})
			.from(revertOperations)
			.where(eq(revertOperations.id, file.planId))
			.get();
		if (
			!plan?.narratorId ||
			!plan.hash ||
			!plan.owner.startsWith("human:") ||
			!plan.selector ||
			!["committed", "recovery_required", "compensated"].includes(plan.status)
		)
			return false;
		const ref = registry.options.db
			.select({ size: fileChangeBlobs.sizeBytes, status: fileChangeBlobs.status })
			.from(fileChangeBlobs)
			.where(eq(fileChangeBlobs.digest, plan.selector))
			.get();
		if (!ref || ref.status !== "ready" || ref.size > REMOTE_HISTORY_RECOVERY_LIMITS.selectorBytes)
			return false;
		const namespace = await registry.auditNamespace(signal);
		const parser = new RemoteRestoreParser(signal);
		try {
			const selector = await parser.request<{
				recoveryAuth?: unknown;
				owner?: { narratorId: string; projectId: string | null };
				purpose?: string;
				confirmation?: RemoteWorkspaceRestoreConfirmation;
				origin?: { projectId: string | null };
			}>({
				kind: "parseManifest",
				bytes: await namespace.store.readBytes(
					{ algorithm: "sha256", digest: plan.selector, sizeBytes: ref.size },
					{ signal, maxBytes: REMOTE_HISTORY_RECOVERY_LIMITS.selectorBytes },
				),
			});
			const userId = plan.owner.slice(6);
			if (
				!userId ||
				selector.owner?.narratorId !== plan.narratorId ||
				selector.owner.projectId !== plan.projectId
			)
				return false;
			await assertRemoteRecoveryAuth(registry, selector.recoveryAuth, userId, signal);
			const guarded = this.guard(registry, selector.recoveryAuth, userId, current, {
				deviceId: job.deviceId,
				narratorId: plan.narratorId,
				projectId: plan.projectId,
				root: scope.canonicalRoot,
			});
			const principal = { userId, isAdmin: false };
			if (plan.scope === "workspace") {
				if (
					selector.purpose !== "remote_workspace_snapshot_restore_v1" ||
					!selector.confirmation ||
					selector.origin?.projectId !== plan.projectId
				)
					return false;
				const result = await new RemoteWorkspaceRestoreService({ registry: guarded }).recover({
					principal,
					narratorId: plan.narratorId,
					planId: plan.id,
					planHash: plan.hash,
					confirmation: selector.confirmation,
					signal,
				});
				return (
					(result.status === "committed" || result.status === "compensated") &&
					registry.options.db
						.select({ status: workspaceWriteLeases.status })
						.from(workspaceWriteLeases)
						.where(eq(workspaceWriteLeases.leaseId, row.id))
						.get()?.status === "recovered"
				);
			}
			return (
				await reconcileRemoteRevertPlan({
					registry: guarded,
					principal,
					narratorId: plan.narratorId,
					planId: plan.id,
					planHash: plan.hash,
					signal,
				})
			).barrierReleased;
		} finally {
			parser.close();
		}
	}
	private guard(
		registry: RemoteWorkspaceHistoryRuntime,
		proof: unknown,
		userId: string,
		current: () => void,
		origin: { deviceId: string; narratorId: string; projectId: string | null; root: string },
	) {
		return new RemoteWorkspaceHistoryRuntime({
			...registry.options,
			authorize: async (actor, target, need, signal) => {
				current();
				if (
					actor.userId !== userId ||
					actor.narratorId !== origin.narratorId ||
					actor.projectId !== origin.projectId ||
					target.deviceId !== origin.deviceId ||
					target.cwd !== origin.root
				)
					throw new Error("Original recovery actor/device/project/root changed");
				await assertRemoteRecoveryAuth(registry, proof, userId, signal);
				await registry.options.authorize(actor, target, need, signal);
				current();
			},
		});
	}
}

let production: RemoteHistoryRecoveryDispatcher | undefined;
export function enqueueAuthenticatedRemoteHistoryRecovery(
	deviceId: string,
	generation: number,
): boolean {
	return production?.enqueue(deviceId, generation) ?? false;
}
/** Startup installs the authenticated status listener before the bounded online
 * probe; reconnect callbacks merely enqueue and never await long native IO. */
export function startRemoteHistoryRecoveryDispatcher(
	options: Partial<RemoteRecoveryDispatcherOptions> = {},
): () => Promise<void> {
	if (production) return async () => undefined;
	const registryProvider = options.registry ?? getRemoteWorkspaceHistoryRuntime;
	const dispatcher = new RemoteHistoryRecoveryDispatcher({
		registry: registryProvider,
		generation: options.generation ?? getDeviceConnectionGeneration,
		now: options.now,
		onSummary: (summary) => {
			options.onSummary?.(summary);
			if (summary.visited)
				logger.info("Bounded remote history recovery pass", {
					...summary,
					requiresManualRecovery: summary.manual > 0,
				});
		},
	});
	production = dispatcher;
	const listener = (event: { deviceId: string; status: "online" | "offline" }) => {
		if (event.status === "offline") dispatcher.cancel(event.deviceId);
		else {
			const generation = getDeviceConnectionGeneration(event.deviceId);
			if (generation !== null) dispatcher.enqueue(event.deviceId, generation);
		}
	};
	eventBus.on("device:status", listener);
	const controller = new AbortController();
	void (async () => {
		await yieldTick();
		const registry = await registryProvider();
		let cursor: string | undefined;
		let seen = 0;
		while (!controller.signal.aborted && seen < REMOTE_HISTORY_RECOVERY_LIMITS.queuedDevices) {
			const page = registry.options.db
				.select({ id: remoteDevices.id })
				.from(remoteDevices)
				.where(
					and(
						eq(remoteDevices.status, "online"),
						cursor ? gt(remoteDevices.id, cursor) : undefined,
					),
				)
				.orderBy(asc(remoteDevices.id))
				.limit(REMOTE_HISTORY_RECOVERY_LIMITS.page + 1)
				.all();
			for (const device of page.slice(0, REMOTE_HISTORY_RECOVERY_LIMITS.page)) {
				cursor = device.id;
				seen++;
				const generation = getDeviceConnectionGeneration(device.id);
				if (generation !== null) dispatcher.enqueue(device.id, generation);
			}
			if (page.length <= REMOTE_HISTORY_RECOVERY_LIMITS.page) break;
			await yieldTick();
		}
	})().catch(() => {
		logger.warn("Bounded remote history startup probe unavailable");
	});
	return async () => {
		controller.abort();
		eventBus.off("device:status", listener);
		try {
			await dispatcher.stop();
		} finally {
			if (production === dispatcher) production = undefined;
		}
	};
}
