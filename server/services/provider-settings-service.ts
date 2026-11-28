import { createHash } from "node:crypto";
import { AppError } from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { getProviderKeyStore } from "@server/lib/provider-keys";
import { settings, subscribeSettingsChanges } from "@server/lib/settings";
import type { ProviderSettingsTargetKind } from "@shared/provider-settings";
import {
	PROVIDER_SETTINGS_RPC_LIMITS,
	providerSettingsActionResultSchema,
} from "@shared/provider-settings-rpc";
import type { ProviderSettingsExtensionView } from "@shared/provider-settings-values";
import { PROVIDER_QUOTA_BUILTIN_ID } from "./builtin-plugin-catalog";
import type { CapabilityBroker, PluginPrincipal } from "./plugin-capability-broker";
import type { PluginContributionRegistry } from "./plugin-contribution-registry";
import type { PluginHostServices } from "./plugin-host-services";
import type { RuntimeSupervisor } from "./plugin-runtime";
import { getPluginSettingsStore } from "./plugin-settings-store-provider";
import type { PluginStateStore } from "./plugin-state-store";
import {
	LEGACY_QUOTA_PACKAGE_HASH,
	QUOTA_SETTINGS_CONTRIBUTION_ID,
} from "./provider-quota-settings-compat";
import { assertQuotaCompatibilityIdle } from "./provider-quota-settings-compat-save";
import { ensureQuotaSettingsMigration } from "./provider-quota-settings-migration";
import { beginQuotaSettingsProjection } from "./provider-quota-settings-projection";
import type {
	ProviderSettingsBindings,
	ProviderSettingsCapability,
} from "./provider-settings-bindings";
import { ProviderSettingsConfigPolicy } from "./provider-settings-config-policy";
import {
	readProviderSettingsCoreContext,
	settingsConfigContext,
} from "./provider-settings-context";
import { ProviderSettingsData } from "./provider-settings-data";
import { resolveProviderSettingsTarget } from "./provider-settings-targets";

export interface ProviderSettingsServiceOptions {
	registry: PluginContributionRegistry;
	states: PluginStateStore;
	runtimes: RuntimeSupervisor;
	host: PluginHostServices;
	broker: CapabilityBroker;
	bindings: ProviderSettingsBindings;
}
function unavailable(code = "PROVIDER_SETTINGS_UNAVAILABLE", status = 409): never {
	throw new AppError("Provider settings operation is unavailable", status, code);
}
function targetScope(kind: ProviderSettingsTargetKind, id: string): string {
	return `provider-settings:${createHash("sha256")
		.update(JSON.stringify([kind, id]))
		.digest("hex")}`;
}
function assertCompatibilityIdle(
	pluginId: string,
	contributionId: string,
	kind: ProviderSettingsTargetKind,
	id: string,
) {
	if (
		pluginId === PROVIDER_QUOTA_BUILTIN_ID &&
		contributionId === QUOTA_SETTINGS_CONTRIBUTION_ID &&
		kind === "custom-api"
	)
		assertQuotaCompatibilityIdle(id);
}
/** Host orchestration. HTTP caller must have administrator authority; runtime calls need leases. */
export class ProviderSettingsService {
	private activate:
		| ((pluginId: string, options: { reason: string; signal: AbortSignal }) => Promise<unknown>)
		| undefined;
	private readonly pending = new Set<AbortController>();
	private readonly unsubscribe: Array<() => void> = [];
	private closing = false;
	constructor(private readonly options: ProviderSettingsServiceOptions) {}
	private observe(): void {
		if (this.unsubscribe.length || this.closing) return;
		this.unsubscribe.push(subscribeSettingsChanges(() => this.invalidateAll()));
		this.unsubscribe.push(getProviderKeyStore().onChange(() => this.invalidateAll()));
	}
	setActivationHandler(handler: NonNullable<ProviderSettingsService["activate"]>): void {
		this.activate = handler;
	}
	private invalidateAll(): void {
		for (const controller of this.pending) controller.abort(new Error("Saved providers changed"));
		this.options.bindings.close();
	}
	close(): void {
		this.closing = true;
		this.invalidateAll();
		for (const stop of this.unsubscribe.splice(0)) stop();
	}
	private async descriptor(pluginId: string, contributionId: string) {
		if (this.closing) return unavailable();
		const entry = this.options.registry.get(`${pluginId}/${contributionId}`),
			declaration = this.options.registry.getProviderSettingsDescriptor(
				`${pluginId}/${contributionId}`,
			);
		const state = await this.options.states.getState(pluginId);
		if (
			!entry ||
			!declaration ||
			!state?.current ||
			state.current.hash !== entry.hash ||
			state.current.version !== entry.version
		)
			return unavailable();
		const installationId =
			state.installationId ?? state.authorityInstallationId ?? state.current.hash;
		return { entry, declaration, state, installationId };
	}
	private async migrate(
		current: Awaited<ReturnType<ProviderSettingsService["descriptor"]>>,
		kind: ProviderSettingsTargetKind,
		id: string,
		signal?: AbortSignal,
	): Promise<void> {
		if (current.entry.pluginId === PROVIDER_QUOTA_BUILTIN_ID && kind === "custom-api")
			await ensureQuotaSettingsMigration({
				pluginId: current.entry.pluginId,
				version: current.entry.version,
				hash: current.entry.hash,
				installationId: current.installationId,
				providerId: id,
				declaration: current.declaration,
				signal,
			});
	}
	private async data(): Promise<ProviderSettingsData> {
		return new ProviderSettingsData(await getPluginSettingsStore());
	}
	async prepareQuotaMigrations(): Promise<void> {
		let current: Awaited<ReturnType<ProviderSettingsService["descriptor"]>>;
		try {
			current = await this.descriptor(PROVIDER_QUOTA_BUILTIN_ID, QUOTA_SETTINGS_CONTRIBUTION_ID);
		} catch {
			return;
		}
		const source = settings.customApiProviders ?? [];
		if (source.length > 1024) unavailable("PROVIDER_SETTINGS_LIMIT_EXCEEDED", 413);
		const providers = [...source];
		for (const provider of providers) beginQuotaSettingsProjection(provider);
		for (const provider of providers) {
			if (this.closing) return;
			try {
				await this.migrate(current, "custom-api", provider.id);
			} catch {
				logger.warn("Provider extension migration remains blocked", { providerId: provider.id });
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	async list(
		kind: ProviderSettingsTargetKind,
		id: string,
	): Promise<ProviderSettingsExtensionView[]> {
		const core = readProviderSettingsCoreContext(kind, id);
		const entries = this.options.registry
			.listByKind("providerSettings")
			.filter((entry) => entry.descriptor.providerSettings?.targetKinds.includes(kind));
		if (entries.length > 128) return unavailable("PROVIDER_SETTINGS_LIMIT_EXCEEDED", 413);
		const result: ProviderSettingsExtensionView[] = [];
		let outputBytes = 0;
		for (const entry of entries) {
			const declaration = this.options.registry.getProviderSettingsDescriptor(entry.fullId);
			if (!declaration) continue;
			try {
				const current = await this.descriptor(entry.pluginId, entry.contributionId);
				await this.migrate(current, kind, id);
				const data = await this.data(),
					config = await data.read(
						settingsConfigContext(entry.pluginId, current.installationId, core),
						current.declaration,
					);
				result.push({
					pluginId: entry.pluginId,
					contributionId: entry.contributionId,
					declaration: current.declaration,
					pluginState: current.state.desiredState,
					compatible: current.state.compatibility === "compatible",
					target: core.target,
					config,
				});
			} catch {
				result.push({
					pluginId: entry.pluginId,
					contributionId: entry.contributionId,
					declaration,
					unavailable: true,
					target: core.target,
				});
			}
			outputBytes += Buffer.byteLength(JSON.stringify(result[result.length - 1]));
			if (outputBytes > 250 * 1024) unavailable("PROVIDER_SETTINGS_LIMIT_EXCEEDED", 413);
		}
		return result;
	}
	async save(
		pluginId: string,
		contributionId: string,
		kind: ProviderSettingsTargetKind,
		id: string,
		input: unknown,
		signal?: AbortSignal,
	) {
		this.observe();
		const initial = await this.descriptor(pluginId, contributionId),
			core = readProviderSettingsCoreContext(kind, id),
			data = await this.data();
		await this.migrate(initial, kind, id, signal);
		const controller = new AbortController();
		this.pending.add(controller);
		const effective = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		try {
			effective.throwIfAborted();
			const latest = await this.descriptor(pluginId, contributionId);
			if (
				initial.installationId !== latest.installationId ||
				initial.entry.hash !== latest.entry.hash
			)
				return unavailable();
			const config = await data.save(
				settingsConfigContext(pluginId, initial.installationId, core),
				initial.declaration,
				input,
				{
					signal: effective,
					assertCurrent: () => {
						assertCompatibilityIdle(pluginId, contributionId, kind, id);
						const state = this.options.states.getCachedState(pluginId);
						const entry = this.options.registry.get(initial.entry.fullId);
						if (
							this.closing ||
							state?.current?.hash !== initial.entry.hash ||
							(state.installationId ?? state.authorityInstallationId ?? state.current.hash) !==
								initial.installationId ||
							entry?.hash !== initial.entry.hash ||
							readProviderSettingsCoreContext(kind, id).identityRevision !== core.identityRevision
						)
							unavailable("PROVIDER_SETTINGS_BINDING_CHANGED");
					},
				},
			);
			await this.migrate(initial, kind, id, signal);
			this.options.bindings.revokeTarget(kind, id);
			eventBus.emit({
				type: "provider:settings_changed",
				pluginId,
				contributionId,
				targetKind: kind,
				targetId: id,
				revision: config.revision,
			});
			return config;
		} finally {
			this.pending.delete(controller);
		}
	}
	async retained(
		pluginId: string,
		contributionId: string,
		kind: ProviderSettingsTargetKind,
		id: string,
		cursor?: string,
	) {
		const current = await this.descriptor(pluginId, contributionId);
		readProviderSettingsCoreContext(kind, id);
		const policy = new ProviderSettingsConfigPolicy(current.declaration);
		if (!current.declaration.targetKinds.includes(kind)) return unavailable();
		const store = await getPluginSettingsStore();
		const page = await store.listSettings(pluginId, { cursor, limit: 50 });
		return {
			items: page.items
				.filter(
					(item) =>
						item.contributionId === contributionId &&
						item.targetKind === kind &&
						item.targetId !== id &&
						item.state !== "deleted" &&
						item.state !== "blocked" &&
						item.schemaFingerprint === policy.schemaFingerprint &&
						resolveProviderSettingsTarget(kind, item.targetId).status === "not-found",
				)
				.map((item) => ({
					targetId: item.targetId,
					revision: item.revision,
					updatedAt: item.updatedAt,
				})),
			nextCursor: page.nextCursor,
		};
	}
	async rebind(
		pluginId: string,
		contributionId: string,
		kind: ProviderSettingsTargetKind,
		id: string,
		confirmation: {
			expectedRevision: number;
			schemaFingerprint: string;
			expectedBindingRevision: string;
			source?: { targetId: string; expectedRevision: number };
		},
		signal?: AbortSignal,
	) {
		this.observe();
		const initial = await this.descriptor(pluginId, contributionId),
			core = readProviderSettingsCoreContext(kind, id),
			data = await this.data();
		const assertSource = () => {
			if (
				confirmation.source &&
				(confirmation.source.targetId === id ||
					resolveProviderSettingsTarget(kind, confirmation.source.targetId).status !== "not-found")
			)
				unavailable("PROVIDER_SETTINGS_SOURCE_STILL_AVAILABLE");
		};
		assertSource();
		const config = await data.rebind(
			settingsConfigContext(pluginId, initial.installationId, core),
			initial.declaration,
			confirmation,
			{
				signal,
				assertCurrent: () => {
					assertCompatibilityIdle(pluginId, contributionId, kind, id);
					if (confirmation.source)
						assertCompatibilityIdle(pluginId, contributionId, kind, confirmation.source.targetId);
					assertSource();
					const state = this.options.states.getCachedState(pluginId),
						entry = this.options.registry.get(initial.entry.fullId);
					if (
						this.closing ||
						state?.current?.hash !== initial.entry.hash ||
						(state.installationId ?? state.authorityInstallationId ?? state.current.hash) !==
							initial.installationId ||
						entry?.hash !== initial.entry.hash ||
						readProviderSettingsCoreContext(kind, id).identityRevision !== core.identityRevision
					)
						unavailable("PROVIDER_SETTINGS_BINDING_CHANGED");
				},
			},
		);
		await this.migrate(initial, kind, id, signal);
		if (confirmation.source) this.options.bindings.revokeTarget(kind, confirmation.source.targetId);
		this.options.bindings.revokeTarget(kind, id);
		eventBus.emit({
			type: "provider:settings_changed",
			pluginId,
			contributionId,
			targetKind: kind,
			targetId: id,
			revision: config.revision,
		});
		return config;
	}
	async remove(
		pluginId: string,
		contributionId: string,
		kind: ProviderSettingsTargetKind,
		id: string,
		revision: number,
		signal?: AbortSignal,
	) {
		const current = await this.descriptor(pluginId, contributionId),
			core = readProviderSettingsCoreContext(kind, id),
			data = await this.data();
		await data.remove(
			settingsConfigContext(pluginId, current.installationId, core),
			current.declaration,
			revision,
			{
				signal,
				assertCurrent: () => {
					assertCompatibilityIdle(pluginId, contributionId, kind, id);
					const state = this.options.states.getCachedState(pluginId);
					if (
						this.closing ||
						state?.current?.hash !== current.entry.hash ||
						(state.installationId ?? state.authorityInstallationId ?? state.current.hash) !==
							current.installationId ||
						readProviderSettingsCoreContext(kind, id).identityRevision !== core.identityRevision
					)
						unavailable("PROVIDER_SETTINGS_BINDING_CHANGED");
				},
			},
		);
		await this.migrate(current, kind, id, signal);
		this.options.bindings.revokeTarget(kind, id);
		eventBus.emit({
			type: "provider:settings_changed",
			pluginId,
			contributionId,
			targetKind: kind,
			targetId: id,
			revision: revision + 1,
		});
	}
	private async authorize(
		principal: PluginPrincipal,
		capability: ProviderSettingsCapability,
		userId: string,
		kind: ProviderSettingsTargetKind,
		id: string,
		deadlineAt: number,
	): Promise<boolean> {
		const result = await this.options.broker.authorize({
			capability,
			methodId:
				capability === "provider.settings.read_self"
					? "provider.settings.get"
					: "provider.settings.connection.request",
			context: {
				requestId: crypto.randomUUID(),
				correlationId: crypto.randomUUID(),
				deadlineAt: new Date(deadlineAt).toISOString(),
				plugin: principal,
				invocation: { kind: "user", userId, userRole: "admin", source: "ui" },
				scope: { userId, providerInstanceId: targetScope(kind, id) },
			},
		});
		return result.allowed;
	}
	/** Runtime query integration: the caller supplies its already bound principal and lifecycle guard. */
	async bindQuery(input: {
		legacyCompatibility?: boolean;
		plugin: PluginPrincipal;
		contributionId: string;
		target: { kind: ProviderSettingsTargetKind; id: string };
		deadlineAt: number;
		signal: AbortSignal;
		isCurrent: () => boolean | Promise<boolean>;
	}) {
		this.observe();
		const current = await this.descriptor(input.plugin.pluginId, input.contributionId),
			{ kind, id } = input.target;
		if (
			current.installationId !== input.plugin.installationId ||
			current.state.desiredState !== "enabled" ||
			current.state.compatibility !== "compatible"
		)
			return unavailable();
		await this.migrate(current, kind, id, input.signal);
		const core = readProviderSettingsCoreContext(kind, id),
			context = settingsConfigContext(input.plugin.pluginId, current.installationId, core),
			data = await this.data();
		const snapshot = await data.readBound(context, current.declaration, { signal: input.signal });
		const bound = this.options.host.getRuntimeBinding(
			input.plugin.pluginId,
			input.plugin.runtimeId,
		);
		if (!bound || bound.plugin.runtimeGeneration !== input.plugin.runtimeGeneration)
			return unavailable();
		const isCurrent = () => {
			const state = this.options.states.getCachedState(input.plugin.pluginId),
				binding = this.options.host.getRuntimeBinding(
					input.plugin.pluginId,
					input.plugin.runtimeId,
				),
				entry = this.options.registry.get(current.entry.fullId);
			if (
				this.closing ||
				input.signal.aborted ||
				state?.desiredState !== "enabled" ||
				state.current?.hash !== current.entry.hash ||
				entry?.status !== "available" ||
				entry.hash !== current.entry.hash ||
				binding?.plugin.runtimeGeneration !== input.plugin.runtimeGeneration ||
				binding.grantRevision !== bound.grantRevision
			)
				return false;
			try {
				const live = readProviderSettingsCoreContext(kind, id);
				return (
					!live.target.disabled &&
					live.target.available &&
					live.identityRevision === core.identityRevision
				);
			} catch {
				return false;
			}
		};
		const legacy =
			input.legacyCompatibility === true &&
			current.entry.pluginId === PROVIDER_QUOTA_BUILTIN_ID &&
			current.entry.version === "1.0.3" &&
			current.entry.hash === LEGACY_QUOTA_PACKAGE_HASH;
		if (input.legacyCompatibility && !legacy) return unavailable();
		const authorize = async (capability: ProviderSettingsCapability) => {
			if (!isCurrent() || !(await input.isCurrent())) return false;
			const result = await this.options.broker.authorize({
				capability: legacy
					? capability === "provider.settings.read_self"
						? "quota.provide"
						: "provider.connection.request"
					: capability,
				methodId:
					capability === "provider.settings.read_self"
						? "provider.settings.get"
						: "provider.settings.connection.request",
				context: {
					requestId: crypto.randomUUID(),
					correlationId: crypto.randomUUID(),
					deadlineAt: new Date(input.deadlineAt).toISOString(),
					plugin: input.plugin,
					invocation: { kind: "plugin_background", source: "internal" },
					scope: { providerInstanceId: targetScope(kind, id) },
				},
			});
			return result.allowed && isCurrent();
		};
		if (
			!(await authorize("provider.settings.read_self")) ||
			(current.declaration.connections?.length &&
				!(await authorize("provider.settings.connection.use")))
		)
			return unavailable("PROVIDER_SETTINGS_PERMISSION_DENIED", 403);
		const lease = this.options.bindings.issue({
			principal: input.plugin,
			userId: "host-background",
			target: input.target,
			declaration: current.declaration,
			revision: snapshot.revision,
			bindingRevision: snapshot.bindingRevision,
			deadlineAt: input.deadlineAt,
			signal: input.signal,
			isCurrent,
			authorize,
			read: async (signal) => {
				const live = readProviderSettingsCoreContext(kind, id);
				return {
					...(await data.readBound(
						settingsConfigContext(input.plugin.pluginId, current.installationId, live),
						current.declaration,
						{ signal },
					)),
					providerRoot: live.providerRoot,
					providerKey: live.providerKey,
					resolveProxy: live.resolveProxy,
					tlsRejectUnauthorized: live.tlsRejectUnauthorized,
				};
			},
		});
		return {
			settings: {
				reference: lease.reference,
				revision: snapshot.revision,
				values: snapshot.publicValues,
			},
			requestLegacy: legacy
				? (signal: AbortSignal) =>
						this.options.bindings.request(
							{ reference: lease.reference, connectionId: "balance" },
							input.plugin,
							signal,
						)
				: undefined,
			release: lease.release,
			isCurrent: async () => {
				try {
					await this.options.bindings.get(
						{ reference: lease.reference },
						input.plugin,
						input.signal,
					);
					return true;
				} catch {
					return false;
				}
			},
		};
	}
	async action(
		pluginId: string,
		contributionId: string,
		kind: ProviderSettingsTargetKind,
		id: string,
		userId: string,
		signal?: AbortSignal,
	) {
		this.observe();
		if (this.pending.size >= 32) unavailable("PROVIDER_SETTINGS_BUSY", 429);
		const current = await this.descriptor(pluginId, contributionId);
		if (
			!current.declaration.action ||
			current.state.desiredState !== "enabled" ||
			current.state.compatibility !== "compatible" ||
			current.entry.status !== "available" ||
			!this.activate
		)
			return unavailable();
		const core = readProviderSettingsCoreContext(kind, id);
		if (core.target.disabled || !core.target.available) return unavailable();
		if (this.pending.size >= 32) unavailable("PROVIDER_SETTINGS_BUSY", 429);
		const controller = new AbortController(),
			deadlineAt = Date.now() + PROVIDER_SETTINGS_RPC_LIMITS.ttlMs;
		const effective = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const timer = setTimeout(
			() => controller.abort(new Error("Provider settings action timed out")),
			PROVIDER_SETTINGS_RPC_LIMITS.ttlMs,
		);
		this.pending.add(controller);
		let release: (() => void) | undefined;
		try {
			await this.activate(pluginId, {
				reason: `onProviderSettings:${contributionId}`,
				signal: effective,
			});
			effective.throwIfAborted();
			const runtime = this.options.runtimes.get(pluginId);
			if (!runtime || runtime.state !== "active") return unavailable();
			const diagnostics = runtime.getDiagnostics(),
				binding = this.options.host.getRuntimeBinding(pluginId, diagnostics.runtimeId);
			if (
				!binding ||
				!diagnostics.features?.includes("host_api.provider_settings") ||
				binding.plugin.installationId !== current.installationId
			)
				return unavailable("PROVIDER_SETTINGS_RUNTIME_INCOMPATIBLE");
			const data = await this.data(),
				ctx = settingsConfigContext(pluginId, current.installationId, core),
				policy = new ProviderSettingsConfigPolicy(current.declaration);
			const snapshot = await data.readBound(ctx, current.declaration, { signal: effective });
			const isCurrent = () => {
				if (
					this.closing ||
					effective.aborted ||
					this.options.runtimes.get(pluginId) !== runtime ||
					runtime.state !== "active"
				)
					return false;
				const now = this.options.states.getCachedState(pluginId),
					entry = this.options.registry.get(current.entry.fullId),
					bound = this.options.host.getRuntimeBinding(pluginId, diagnostics.runtimeId);
				if (
					now?.desiredState !== "enabled" ||
					now.current?.hash !== current.entry.hash ||
					(now.installationId ?? now.authorityInstallationId ?? now.current.hash) !==
						current.installationId ||
					entry?.status !== "available" ||
					entry.hash !== current.entry.hash ||
					bound?.plugin.runtimeGeneration !== binding.plugin.runtimeGeneration ||
					bound.grantRevision !== binding.grantRevision
				)
					return false;
				try {
					const live = readProviderSettingsCoreContext(kind, id);
					return (
						!live.target.disabled &&
						live.target.available &&
						live.identityRevision === core.identityRevision
					);
				} catch {
					return false;
				}
			};
			if (
				!isCurrent() ||
				!(await this.authorize(
					binding.plugin,
					"provider.settings.read_self",
					userId,
					kind,
					id,
					deadlineAt,
				))
			)
				return unavailable("PROVIDER_SETTINGS_PERMISSION_DENIED", 403);
			const lease = this.options.bindings.issue({
				principal: binding.plugin,
				userId,
				target: { kind, id },
				declaration: current.declaration,
				revision: snapshot.revision,
				bindingRevision: snapshot.bindingRevision,
				deadlineAt,
				signal: effective,
				isCurrent,
				authorize: (capability) =>
					this.authorize(binding.plugin, capability, userId, kind, id, deadlineAt),
				read: async (callSignal) => {
					const live = readProviderSettingsCoreContext(kind, id),
						liveContext = settingsConfigContext(pluginId, current.installationId, live);
					return {
						...(await data.readBound(liveContext, current.declaration, { signal: callSignal })),
						providerRoot: live.providerRoot,
						providerKey: live.providerKey,
						resolveProxy: live.resolveProxy,
						tlsRejectUnauthorized: live.tlsRejectUnauthorized,
					};
				},
			});
			release = lease.release;
			const result = await runtime.request(
				"providerSettings.action",
				{
					contributionId,
					reference: lease.reference,
					schemaVersion: 1,
					schemaFingerprint: policy.schemaFingerprint,
					target: { kind, id },
				},
				{
					signal: effective,
					timeoutMs: Math.max(1, deadlineAt - Date.now()),
					maxResponseBytes: PROVIDER_SETTINGS_RPC_LIMITS.actionBytes,
				},
			);
			if (!isCurrent()) return unavailable();
			await this.options.bindings.get({ reference: lease.reference }, binding.plugin, effective);
			const parsed = providerSettingsActionResultSchema.safeParse(result);
			if (!parsed.success) return unavailable("PROVIDER_SETTINGS_INVALID_RESPONSE", 502);
			for (const value of Object.values(snapshot.secrets))
				if (value && parsed.data.text.includes(value))
					return unavailable("PROVIDER_SETTINGS_INVALID_RESPONSE", 502);
			return parsed.data;
		} finally {
			release?.();
			clearTimeout(timer);
			controller.abort();
			this.pending.delete(controller);
		}
	}
}
