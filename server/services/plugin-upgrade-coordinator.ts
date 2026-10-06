import { AsyncMutex } from "@server/lib/async-mutex";
import type {
	CurrentPackagePointer,
	CurrentPointerFile,
	InstalledPackageResult,
	PackageInstallOptions,
	PackageSource,
	SetCurrentOptions,
} from "./plugin-package-store";

export interface PluginUpgradeStore {
	install(source: PackageSource, options?: PackageInstallOptions): Promise<InstalledPackageResult>;
	readCurrent(): Promise<CurrentPointerFile>;
	setCurrent(
		pluginId: string,
		pointer: CurrentPackagePointer | undefined,
		options?: SetCurrentOptions,
	): Promise<CurrentPointerFile>;
}

export interface PluginUpgradeRuntime {
	drain?(pluginId: string): Promise<void>;
	stop(pluginId: string): Promise<void>;
	start(pluginId: string, pointer: CurrentPackagePointer, signal?: AbortSignal): Promise<void>;
}

export interface PluginUpgradeOptions {
	store: PluginUpgradeStore;
	runtime?: PluginUpgradeRuntime;
	healthCheck?: (
		pluginId: string,
		pointer: CurrentPackagePointer,
		signal?: AbortSignal,
	) => Promise<boolean>;
	now?: () => Date;
}

export interface UpgradeRecord {
	operation: "upgrade" | "rollback";
	pluginId: string;
	/** Pointer observed before the operation. */
	from?: CurrentPackagePointer;
	/** Immutable package installed for an upgrade attempt, before pointer activation. */
	candidate?: CurrentPackagePointer;
	/** Intended final pointer after the operation or its compensation. */
	to?: CurrentPackagePointer;
	/** Pointer observed after success or compensation. */
	finalCurrent?: CurrentPackagePointer;
	/** Most recently verified healthy pointer after this record. */
	lastKnownGood?: CurrentPackagePointer;
	/** Healthy pointer retained as the next explicit rollback target. */
	rollbackTarget?: CurrentPackagePointer;
	status: "succeeded" | "rolled-back" | "failed";
	error?: string;
	at: string;
}

function clonePointer(
	pointer: CurrentPackagePointer | undefined,
): CurrentPackagePointer | undefined {
	return pointer ? { ...pointer } : undefined;
}

function pointersEqual(
	left: CurrentPackagePointer | undefined,
	right: CurrentPackagePointer | undefined,
): boolean {
	if (!left || !right) return !left && !right;
	return left.version === right.version && left.hash === right.hash;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Coordinates candidate activation, expected-current CAS, and runtime/pointer compensation. */
export class PluginUpgradeCoordinator {
	private readonly lastKnownGood = new Map<string, CurrentPackagePointer>();
	private readonly rollbackTargets = new Map<string, CurrentPackagePointer>();
	private readonly history: UpgradeRecord[] = [];
	private readonly lifecycleMutex = new AsyncMutex();
	private readonly now: () => Date;

	constructor(private readonly options: PluginUpgradeOptions) {
		this.now = options.now ?? (() => new Date());
	}

	getLastKnownGood(pluginId: string): CurrentPackagePointer | undefined {
		return clonePointer(this.lastKnownGood.get(pluginId));
	}

	getRollbackTarget(pluginId: string): CurrentPackagePointer | undefined {
		return clonePointer(this.rollbackTargets.get(pluginId));
	}

	getHistory(pluginId?: string): UpgradeRecord[] {
		return this.history
			.filter((record) => !pluginId || record.pluginId === pluginId)
			.map((record) => structuredClone(record));
	}

	async upgrade(
		pluginId: string,
		source: PackageSource,
		signal?: AbortSignal,
	): Promise<UpgradeRecord> {
		return this.lifecycleMutex.acquire(pluginId, () =>
			this.upgradeLocked(pluginId, source, signal),
		);
	}

	async rollback(pluginId: string, signal?: AbortSignal): Promise<UpgradeRecord> {
		return this.lifecycleMutex.acquire(pluginId, () => this.rollbackLocked(pluginId, signal));
	}

	private async upgradeLocked(
		pluginId: string,
		source: PackageSource,
		signal?: AbortSignal,
	): Promise<UpgradeRecord> {
		const from = clonePointer((await this.options.store.readCurrent()).plugins[pluginId]);
		const knownGoodBefore = clonePointer(this.lastKnownGood.get(pluginId) ?? from);
		let candidate: CurrentPackagePointer | undefined;
		try {
			await this.options.runtime?.drain?.(pluginId);
			await this.options.runtime?.stop(pluginId);
			const installed = await this.options.store.install(source, { updateCurrent: false });
			if (installed.pluginId !== pluginId) {
				throw new Error("Upgrade package identity does not match pluginId");
			}
			candidate = { version: installed.version, hash: installed.hash };
			await this.options.store.setCurrent(pluginId, candidate, {
				expectedCurrent: from ?? null,
			});
			const healthy = this.options.healthCheck
				? await this.options.healthCheck(pluginId, candidate, signal)
				: true;
			if (!healthy) throw new Error("Plugin health check failed");
			await this.options.runtime?.start(pluginId, candidate, signal);

			this.lastKnownGood.set(pluginId, candidate);
			if (knownGoodBefore && !pointersEqual(knownGoodBefore, candidate)) {
				this.rollbackTargets.set(pluginId, knownGoodBefore);
			} else {
				this.rollbackTargets.delete(pluginId);
			}
			return this.record({
				operation: "upgrade",
				pluginId,
				from,
				candidate,
				to: candidate,
				finalCurrent: candidate,
				lastKnownGood: candidate,
				rollbackTarget: clonePointer(this.rollbackTargets.get(pluginId)),
				status: "succeeded",
			});
		} catch (error) {
			const recoveryErrors: string[] = [];
			let runtimeRecovered = true;
			try {
				await this.options.runtime?.stop(pluginId);
			} catch (stopError) {
				runtimeRecovered = false;
				recoveryErrors.push(`candidate runtime stop failed: ${errorMessage(stopError)}`);
			}

			const beforeRestore = await this.readCurrentBestEffort(pluginId, recoveryErrors);
			if (candidate && pointersEqual(beforeRestore, candidate)) {
				try {
					await this.options.store.setCurrent(pluginId, from, { expectedCurrent: candidate });
				} catch (restoreError) {
					recoveryErrors.push(`pointer restore failed: ${errorMessage(restoreError)}`);
				}
			} else if (!pointersEqual(beforeRestore, from)) {
				recoveryErrors.push("pointer changed concurrently; old pointer was not restored");
			}

			if (from && this.options.runtime) {
				try {
					// Compensation must not inherit an already-aborted upgrade signal.
					await this.options.runtime.start(pluginId, from);
				} catch (runtimeError) {
					runtimeRecovered = false;
					recoveryErrors.push(`old runtime restore failed: ${errorMessage(runtimeError)}`);
				}
			}
			const finalCurrent = await this.readCurrentBestEffort(pluginId, recoveryErrors);
			const restored =
				runtimeRecovered && recoveryErrors.length === 0 && pointersEqual(finalCurrent, from);
			if (restored) {
				if (knownGoodBefore) this.lastKnownGood.set(pluginId, knownGoodBefore);
				else this.lastKnownGood.delete(pluginId);
			}
			const message = [errorMessage(error), ...recoveryErrors].join("; ");
			const record = this.record({
				operation: "upgrade",
				pluginId,
				from,
				candidate,
				to: restored ? from : finalCurrent,
				finalCurrent,
				lastKnownGood: knownGoodBefore,
				rollbackTarget: clonePointer(this.rollbackTargets.get(pluginId)),
				status: restored ? "rolled-back" : "failed",
				error: message,
			});
			throw Object.assign(new Error(message), { cause: error, upgrade: record });
		}
	}

	private async rollbackLocked(pluginId: string, signal?: AbortSignal): Promise<UpgradeRecord> {
		const target = clonePointer(this.rollbackTargets.get(pluginId));
		if (!target) throw new Error(`No rollback target for ${pluginId}`);
		const from = clonePointer((await this.options.store.readCurrent()).plugins[pluginId]);
		const knownGoodBefore = clonePointer(this.lastKnownGood.get(pluginId) ?? from);
		if (pointersEqual(from, target)) {
			this.lastKnownGood.set(pluginId, target);
			this.rollbackTargets.delete(pluginId);
			return this.record({
				operation: "rollback",
				pluginId,
				from,
				to: target,
				finalCurrent: target,
				lastKnownGood: target,
				status: "succeeded",
			});
		}

		try {
			await this.options.runtime?.drain?.(pluginId);
			await this.options.runtime?.stop(pluginId);
			await this.options.store.setCurrent(pluginId, target, {
				expectedCurrent: from ?? null,
			});
			await this.options.runtime?.start(pluginId, target, signal);
			this.lastKnownGood.set(pluginId, target);
			if (from) this.rollbackTargets.set(pluginId, from);
			else this.rollbackTargets.delete(pluginId);
			return this.record({
				operation: "rollback",
				pluginId,
				from,
				to: target,
				finalCurrent: target,
				lastKnownGood: target,
				rollbackTarget: clonePointer(this.rollbackTargets.get(pluginId)),
				status: "succeeded",
			});
		} catch (error) {
			const recoveryErrors: string[] = [];
			let runtimeRecovered = true;
			try {
				await this.options.runtime?.stop(pluginId);
			} catch (stopError) {
				runtimeRecovered = false;
				recoveryErrors.push(`rollback runtime stop failed: ${errorMessage(stopError)}`);
			}
			const beforeRestore = await this.readCurrentBestEffort(pluginId, recoveryErrors);
			if (pointersEqual(beforeRestore, target)) {
				try {
					await this.options.store.setCurrent(pluginId, from, { expectedCurrent: target });
				} catch (restoreError) {
					recoveryErrors.push(`pre-rollback pointer restore failed: ${errorMessage(restoreError)}`);
				}
			} else if (!pointersEqual(beforeRestore, from)) {
				recoveryErrors.push("pointer changed concurrently during rollback compensation");
			}
			if (from && this.options.runtime) {
				try {
					await this.options.runtime.start(pluginId, from);
				} catch (runtimeError) {
					runtimeRecovered = false;
					recoveryErrors.push(`pre-rollback runtime restore failed: ${errorMessage(runtimeError)}`);
				}
			}
			const finalCurrent = await this.readCurrentBestEffort(pluginId, recoveryErrors);
			const restored =
				runtimeRecovered && recoveryErrors.length === 0 && pointersEqual(finalCurrent, from);
			if (restored && knownGoodBefore) this.lastKnownGood.set(pluginId, knownGoodBefore);
			const message = [errorMessage(error), ...recoveryErrors].join("; ");
			const record = this.record({
				operation: "rollback",
				pluginId,
				from,
				to: restored ? from : finalCurrent,
				finalCurrent,
				lastKnownGood: knownGoodBefore,
				rollbackTarget: target,
				status: restored ? "rolled-back" : "failed",
				error: message,
			});
			throw Object.assign(new Error(message), { cause: error, upgrade: record });
		}
	}

	private async readCurrentBestEffort(
		pluginId: string,
		recoveryErrors: string[],
	): Promise<CurrentPackagePointer | undefined> {
		try {
			return clonePointer((await this.options.store.readCurrent()).plugins[pluginId]);
		} catch (error) {
			recoveryErrors.push(`current pointer read failed: ${errorMessage(error)}`);
			return undefined;
		}
	}

	private record(record: Omit<UpgradeRecord, "at">): UpgradeRecord {
		const completed = { ...record, at: this.now().toISOString() };
		this.history.push(structuredClone(completed));
		return structuredClone(completed);
	}
}
