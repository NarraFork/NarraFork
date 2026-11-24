import { createHash } from "node:crypto";
import { logger } from "@server/lib/logger";
import type { Manifest } from "@server/lib/plugins/manifest";
import { ProviderQuotaError, quotaAbortable } from "@server/lib/provider-quota-async";
import {
	type CustomApiQuotaTarget,
	customApiQuotaTargetSchema,
	QUOTA_MAX_QUERY_MS,
	QUOTA_PROTOCOL_VERSION,
	QUOTA_QUERY_METHOD,
	type QuotaQueryResult,
} from "@shared/provider-quota";
import type { CapabilityBroker, PluginPrincipal } from "./plugin-capability-broker";
import type { PluginHostServices } from "./plugin-host-services";
import type { PluginPermissionStore } from "./plugin-permission-store";
import type { PluginProviderConnectionService } from "./plugin-provider-connection-service";
import { PluginQuotaClient, type PluginQuotaRuntime } from "./plugin-quota-client";
import type { PluginStateRecord, PluginStateStore } from "./plugin-state-store";
import type {
	ProviderQuotaDriver,
	ProviderQuotaQueryOptions,
	ProviderQuotaSource,
} from "./provider-quota-service";

function quotaFailureDetails(error: unknown): {
	errorType: string;
	code?: string;
	causeType?: string;
	causeCode?: string;
} {
	const record =
		error instanceof Error ? (error as Error & { code?: unknown; cause?: unknown }) : undefined;
	const cause =
		record?.cause instanceof Error ? (record.cause as Error & { code?: unknown }) : undefined;
	const code = (value: unknown) =>
		typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(value) ? value : undefined;
	return {
		errorType: record?.name.slice(0, 64) ?? "UnknownError",
		code: code(record?.code),
		causeType: cause?.name.slice(0, 64),
		causeCode: code(cause?.code),
	};
}

const REQUIRED_CAPABILITIES = ["quota.provide", "provider.connection.request"] as const;
const UNAVAILABLE_STATES = new Set(["crashed", "failed", "quarantine", "draining", "deactivating"]);

export interface PluginQuotaRegistryOptions {
	stateStore: Pick<PluginStateStore, "getCachedState">;
	permissionStore: Pick<PluginPermissionStore, "hasCachedUnrestrictedGlobalGrant" | "getSet">;
	hostServices: Pick<PluginHostServices, "getRuntimeBinding">;
	capabilityBroker: Pick<CapabilityBroker, "authorize">;
	providerConnectionService: Pick<PluginProviderConnectionService, "issue" | "revokePlugin">;
	resolveRuntime: (pluginId: string) => PluginQuotaRuntime | undefined;
	activate?: (
		pluginId: string,
		options: { reason: string; signal: AbortSignal },
	) => Promise<unknown>;
	now?: () => number;
}

interface SourceEntry {
	source: ProviderQuotaSource;
	packageGeneration: string;
}
interface ActiveQuery {
	pluginId: string;
	controller: AbortController;
	/** Absent during lazy activation; a first runtime generation must not cancel its own start. */
	principal?: PluginPrincipal;
}

function installationId(state: PluginStateRecord | undefined): string | undefined {
	return state?.installationId ?? state?.authorityInstallationId ?? state?.current?.hash;
}
function packageGeneration(state: PluginStateRecord | undefined): string | undefined {
	return state?.current ? `${state.current.version}:${state.current.hash}` : undefined;
}

/** Static sources and an independent quota driver; no provider registrations or credentials. */
export class PluginQuotaRegistry implements ProviderQuotaDriver {
	private readonly entries = new Map<string, SourceEntry>();
	private readonly disabled = new Set<string>();
	private readonly revoked = new Set<string>();
	private readonly active = new Set<ActiveQuery>();
	private readonly listeners = new Set<() => void>();
	private readonly now: () => number;
	private activate?: PluginQuotaRegistryOptions["activate"];
	private ready = false;
	private notificationPending = false;

	constructor(private readonly options: PluginQuotaRegistryOptions) {
		this.now = options.now ?? Date.now;
		this.activate = options.activate;
	}

	setActivationHandler(handler: NonNullable<PluginQuotaRegistryOptions["activate"]>): void {
		this.activate = handler;
	}

	isReady(): boolean {
		return this.ready;
	}

	setReady(ready = true): void {
		if (this.ready === ready) return;
		this.ready = ready;
		if (!ready)
			for (const call of this.active) call.controller.abort(new ProviderQuotaError("unavailable"));
		this.changed();
	}

	onChanged(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	replaceManifest(manifest: Manifest, generation: string): void {
		const previous = [...this.entries.values()].filter(
			(entry) => entry.source.pluginId === manifest.pluginId,
		);
		if (
			previous.length === manifest.contributes.quotaSources.length &&
			previous.every(
				(entry, index) =>
					entry.packageGeneration === generation &&
					JSON.stringify(entry.source.declaration) ===
						JSON.stringify(manifest.contributes.quotaSources[index]),
			)
		)
			return;
		this.cancelPlugin(manifest.pluginId);
		for (const [id, entry] of this.entries)
			if (entry.source.pluginId === manifest.pluginId) this.entries.delete(id);
		for (const declaration of manifest.contributes.quotaSources) {
			// Stable across restarts. Installation and durable grant identity are added at read time.
			const digest = createHash("sha256").update(JSON.stringify(declaration)).digest("hex");
			const revision = `${generation}:${declaration.id}:${digest}`;
			const id = `${manifest.pluginId}/${declaration.id}`;
			this.entries.set(id, {
				packageGeneration: generation,
				source: {
					id,
					pluginId: manifest.pluginId,
					contributionId: declaration.id,
					revision,
					declaration: structuredClone(declaration),
				},
			});
		}
		if (previous.length > 0 || manifest.contributes.quotaSources.length > 0) this.changed();
	}

	removePlugin(pluginId: string): void {
		this.cancelPlugin(pluginId);
		let changed = false;
		for (const [id, entry] of this.entries) {
			if (entry.source.pluginId !== pluginId) continue;
			this.entries.delete(id);
			changed = true;
		}
		this.disabled.delete(pluginId);
		this.revoked.delete(pluginId);
		if (changed) this.changed();
	}

	/** Catalog state does not clear a lifecycle revocation; only the manager's restore may. */
	setPluginEnabled(pluginId: string, enabled: boolean): void {
		const wasEnabled = !this.disabled.has(pluginId);
		if (enabled) this.disabled.delete(pluginId);
		else {
			this.disabled.add(pluginId);
			this.cancelPlugin(pluginId);
		}
		if (wasEnabled !== enabled && this.hasPlugin(pluginId)) this.changed();
	}

	disablePlugin(pluginId: string): void {
		const changed = !this.revoked.has(pluginId);
		this.revoked.add(pluginId);
		this.cancelPlugin(pluginId);
		if (changed && this.hasPlugin(pluginId)) this.changed();
	}

	enablePlugin(pluginId: string): void {
		if (this.revoked.delete(pluginId) && this.hasPlugin(pluginId)) this.changed();
	}

	invalidatePlugin(pluginId: string, options: { runtimeOnly?: boolean } = {}): void {
		if (options.runtimeOnly) {
			// Starting the very first runtime is part of the current query's budget, not a revoke
			// of that query. Already-bound calls and every issued reference are still invalidated.
			let bound = false;
			for (const call of this.active) {
				if (call.pluginId !== pluginId || !call.principal) continue;
				bound = true;
				call.controller.abort(new ProviderQuotaError("unavailable"));
			}
			this.options.providerConnectionService.revokePlugin(pluginId);
			if (bound) this.changed();
			return;
		}
		this.cancelPlugin(pluginId);
		if (this.hasPlugin(pluginId)) this.changed();
	}

	listSources(): ProviderQuotaSource[] {
		if (!this.ready) return [];
		const sources: ProviderQuotaSource[] = [];
		for (const entry of this.entries.values()) {
			const state = this.liveState(entry);
			if (!state) continue;
			sources.push({ ...structuredClone(entry.source), revision: this.revision(entry, state) });
		}
		return sources.sort((a, b) => a.id.localeCompare(b.id));
	}

	async query(
		source: ProviderQuotaSource,
		target: CustomApiQuotaTarget,
		options: ProviderQuotaQueryOptions,
	): Promise<QuotaQueryResult> {
		const entry = this.currentEntry(source);
		if (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt <= 0)
			throw new ProviderQuotaError("invalid_configuration");
		if (!customApiQuotaTargetSchema.safeParse(target).success)
			throw new ProviderQuotaError("invalid_configuration");
		const deadlineAt = Math.min(
			options.deadlineAt,
			this.now() + QUOTA_MAX_QUERY_MS,
			this.now() + entry.source.declaration.limits.timeoutMs,
		);
		if (options.signal.aborted || deadlineAt <= this.now()) throw new ProviderQuotaError("timeout");
		const call: ActiveQuery = { pluginId: source.pluginId, controller: new AbortController() };
		const signal = call.controller.signal;
		const abort = () =>
			call.controller.abort(
				options.signal.reason instanceof ProviderQuotaError
					? options.signal.reason
					: new ProviderQuotaError("timeout"),
			);
		options.signal.addEventListener("abort", abort, { once: true });
		if (options.signal.aborted) abort();
		const timer = setTimeout(
			() => call.controller.abort(new ProviderQuotaError("timeout")),
			Math.max(1, deadlineAt - this.now()),
		);
		this.active.add(call);
		let phase = "permission-read";
		let reference:
			| ReturnType<PluginQuotaRegistryOptions["providerConnectionService"]["issue"]>
			| undefined;
		try {
			// This async boundary is also inside the same deadline; permission I/O cannot leak slots.
			await quotaAbortable(
				this.options.permissionStore.getSet(
					source.pluginId,
					installationId(this.options.stateStore.getCachedState(source.pluginId)) ?? "",
				),
				signal,
			);
			this.currentEntry(source);
			if (this.activate)
				await quotaAbortable(
					this.activate(source.pluginId, { reason: `onQuota:${source.id}`, signal }),
					signal,
				);
			phase = "runtime-binding";
			const runtime = this.options.resolveRuntime(source.pluginId);
			if (!runtime || !["active", "degraded"].includes(runtime.state))
				throw new ProviderQuotaError("unavailable");
			const diagnostics = runtime.getDiagnostics();
			if (!diagnostics.features?.includes("host_api.provider_connection"))
				throw new ProviderQuotaError("unavailable");
			const binding = this.options.hostServices.getRuntimeBinding(
				source.pluginId,
				diagnostics.runtimeId,
			);
			if (!binding || binding.plugin.runtimeGeneration !== diagnostics.generation)
				throw new ProviderQuotaError("unavailable");
			call.principal = { ...binding.plugin };
			const principal = call.principal;
			const grantRevision = binding.grantRevision;
			const isCurrent = async () => {
				if (signal.aborted || this.now() >= deadlineAt) return false;
				try {
					this.currentEntry(source);
					const currentRuntime = this.options.resolveRuntime(source.pluginId);
					if (currentRuntime !== runtime || !["active", "degraded"].includes(runtime.state))
						return false;
					const currentDiagnostics = runtime.getDiagnostics();
					if (
						currentDiagnostics.runtimeId !== principal.runtimeId ||
						currentDiagnostics.generation !== principal.runtimeGeneration
					)
						return false;
					const currentBinding = this.options.hostServices.getRuntimeBinding(
						source.pluginId,
						principal.runtimeId,
					);
					if (
						!currentBinding ||
						currentBinding.plugin.installationId !== principal.installationId ||
						currentBinding.plugin.runtimeGeneration !== principal.runtimeGeneration ||
						currentBinding.grantRevision !== grantRevision
					)
						return false;
					const state = this.options.stateStore.getCachedState(source.pluginId);
					if (
						installationId(state) !== principal.installationId ||
						state?.current?.version !== principal.packageVersion
					)
						return false;
					const grants = await this.options.permissionStore.getSet(
						source.pluginId,
						principal.installationId,
					);
					if (grants.revision !== grantRevision || signal.aborted) return false;
					for (const capability of REQUIRED_CAPABILITIES) {
						const decision = await this.options.capabilityBroker.authorize({
							context: {
								requestId: "quota-query",
								correlationId: "quota-query",
								deadlineAt: new Date(deadlineAt).toISOString(),
								plugin: principal,
								invocation: { kind: "plugin_background", source: "internal" },
								scope: {},
							},
							capability,
							methodId: QUOTA_QUERY_METHOD,
							scope: {},
						});
						if (!decision.allowed) return false;
					}
					// Close the TOCTOU window after permission-store/kernel awaits with synchronous
					// re-reads of every host-owned identity and the live grant predicates.
					this.currentEntry(source);
					const finalRuntime = this.options.resolveRuntime(source.pluginId);
					const finalDiagnostics = finalRuntime?.getDiagnostics();
					const finalBinding = this.options.hostServices.getRuntimeBinding(
						source.pluginId,
						principal.runtimeId,
					);
					const finalState = this.options.stateStore.getCachedState(source.pluginId);
					return (
						!signal.aborted &&
						this.now() < deadlineAt &&
						finalRuntime === runtime &&
						["active", "degraded"].includes(runtime.state) &&
						finalDiagnostics?.runtimeId === principal.runtimeId &&
						finalDiagnostics.generation === principal.runtimeGeneration &&
						finalBinding?.plugin.runtimeGeneration === principal.runtimeGeneration &&
						finalBinding.plugin.installationId === principal.installationId &&
						finalBinding.grantRevision === grantRevision &&
						installationId(finalState) === principal.installationId &&
						finalState?.current?.version === principal.packageVersion &&
						packageGeneration(finalState) === entry.packageGeneration
					);
				} catch (error) {
					// A lifecycle change is a definite "no longer current". Anything else (a busy
					// database while auditing, an unreadable permission store) means the authority
					// could not be checked: still fail closed, but report a transient failure
					// instead of telling the user a permission is missing.
					if (error instanceof ProviderQuotaError) return false;
					logger.warn("Quota authority check failed", { phase, ...quotaFailureDetails(error) });
					throw new ProviderQuotaError("request_failed");
				}
			};
			phase = "authority-check";
			if (!(await quotaAbortable(isCurrent(), signal)))
				throw new ProviderQuotaError("permission_denied");
			phase = "connection-lease";
			reference = this.options.providerConnectionService.issue({
				principal,
				target,
				source: entry.source.declaration,
				deadlineAt,
				signal,
				isCurrent,
			});
			phase = "quota-rpc";
			const { keyId: _boundKeyId, ...wireTarget } = target;
			const result = await new PluginQuotaClient(runtime).query(
				{
					protocolVersion: QUOTA_PROTOCOL_VERSION,
					contributionId: source.contributionId,
					// Key identity is bound to the lease; older quota plugins need only its opaque generation.
					target: { ...wireTarget, id: `custom-api/${target.providerId}` },
					mode: options.mode,
					reference: reference.reference,
					deadlineAt,
					...(options.cursor === undefined ? {} : { cursor: options.cursor }),
				},
				{ signal, timeoutMs: Math.max(1, deadlineAt - this.now()) },
			);
			if (!(await quotaAbortable(isCurrent(), signal))) throw new ProviderQuotaError("unavailable");
			return result;
		} catch (error) {
			if (!(error instanceof ProviderQuotaError))
				logger.warn("Quota query failed", { phase, ...quotaFailureDetails(error) });
			throw signal.aborted && signal.reason instanceof ProviderQuotaError
				? signal.reason
				: error instanceof ProviderQuotaError
					? error
					: new ProviderQuotaError("request_failed");
		} finally {
			reference?.release();
			clearTimeout(timer);
			options.signal.removeEventListener("abort", abort);
			this.active.delete(call);
		}
	}

	private hasPlugin(pluginId: string): boolean {
		return [...this.entries.values()].some((entry) => entry.source.pluginId === pluginId);
	}

	private liveState(entry: SourceEntry): PluginStateRecord | undefined {
		const pluginId = entry.source.pluginId;
		if (!this.ready || this.disabled.has(pluginId) || this.revoked.has(pluginId)) return undefined;
		const state = this.options.stateStore.getCachedState(pluginId);
		const installation = installationId(state);
		if (
			!state ||
			!installation ||
			state.desiredState !== "enabled" ||
			state.compatibility !== "compatible" ||
			UNAVAILABLE_STATES.has(state.runtimeState) ||
			packageGeneration(state) !== entry.packageGeneration
		)
			return undefined;
		if (
			!REQUIRED_CAPABILITIES.every((capability) =>
				this.options.permissionStore.hasCachedUnrestrictedGlobalGrant(
					pluginId,
					installation,
					capability,
				),
			)
		)
			return undefined;
		return state;
	}

	private revision(entry: SourceEntry, state: PluginStateRecord): string {
		return `${entry.source.revision}/${installationId(state)}/${state.grants.revision}`;
	}

	private currentEntry(source: ProviderQuotaSource): SourceEntry {
		const entry = this.entries.get(source.id);
		if (
			!entry ||
			entry.source.pluginId !== source.pluginId ||
			entry.source.contributionId !== source.contributionId
		)
			throw new ProviderQuotaError("unavailable");
		const state = this.liveState(entry);
		if (!state) throw new ProviderQuotaError("permission_denied");
		if (this.revision(entry, state) !== source.revision)
			throw new ProviderQuotaError("unavailable");
		return entry;
	}

	private cancelPlugin(pluginId: string): void {
		for (const call of this.active)
			if (call.pluginId === pluginId) call.controller.abort(new ProviderQuotaError("unavailable"));
		this.options.providerConnectionService.revokePlugin(pluginId);
	}

	private changed(): void {
		if (this.notificationPending) return;
		this.notificationPending = true;
		queueMicrotask(() => {
			this.notificationPending = false;
			for (const listener of this.listeners) {
				try {
					listener();
				} catch {
					/* A subscriber cannot reopen revoked access. */
				}
			}
		});
	}
}
