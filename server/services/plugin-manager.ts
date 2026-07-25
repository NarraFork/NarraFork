import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { db } from "@server/db";
import { AsyncMutex } from "@server/lib/async-mutex";
import { AppError, NotFoundError, ValidationError } from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { generateShortId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import { type Manifest, pluginIdSchema, safeParseManifest } from "@server/lib/plugins/manifest";
import type { PermissionGrant, TrustTier } from "@server/lib/plugins/permissions";
import { settings } from "@server/lib/settings";
import { PluginAgentToolBridge } from "./plugin-agent-tool-bridge";
import type { PluginPrincipal } from "./plugin-capability-broker";
import {
	PluginCatalog,
	type PluginCatalogPlugin,
	type PluginCatalogSnapshot,
	type PluginPackageSummary,
} from "./plugin-catalog";
import { PluginContributionCoordinator } from "./plugin-contribution-coordinator";
import { PluginContributionRegistry } from "./plugin-contribution-registry";
import type { PluginHostRuntimeBindingInput, PluginHostServices } from "./plugin-host-services";
import { PluginIntegrationAuthorityService } from "./plugin-integration-authority-service";
import {
	PluginLifecycleRevokeError,
	type PluginLifecycleRevokeEvent,
	type PluginLifecycleRevokeEventKind,
	type PluginLifecycleRevokeReport,
} from "./plugin-lifecycle-revoke-coordinator";
import {
	type CurrentPackagePointer,
	type InstalledPackageResult,
	type PackageSource,
	PluginPackageStore,
	type SetCurrentOptions,
} from "./plugin-package-store";
import {
	type PermissionGrantInput,
	type PermissionMutationResult,
	type PluginPermissionSet,
	PluginPermissionStore,
	permissionSummary,
} from "./plugin-permission-store";
import { pluginPlatformServices } from "./plugin-platform-services";
import {
	type PodmanPluginSpec,
	PodmanRunner,
	type PodmanRunnerOptions,
} from "./plugin-podman-runner";
import { createCorePluginPublicApiAdapters } from "./plugin-public-api";
import {
	LocalProcessRunner,
	PluginRuntimeError,
	type PluginRuntimeOptions,
	type RuntimeDiagnostics,
	RuntimeSupervisor,
} from "./plugin-runtime";
import { checkSbomInstallPolicy, parseSbom, type SbomInstallPolicy } from "./plugin-sbom";
import {
	type PluginTrustKeyring,
	parsePluginSignature,
	verifyPluginPackageSignature,
} from "./plugin-signature";
import {
	createPluginStateRecord,
	type PluginGrantSummary,
	type PluginJournalContext,
	type PluginJournalEntry,
	type PluginJournalOperation,
	type PluginPackageReference,
	type PluginPersistenceDiagnostic,
	type PluginStateRecord,
	PluginStateStore,
	pluginStateError,
} from "./plugin-state-store";
import { PluginToolRegistry, type PluginToolRuntime } from "./plugin-tool-registry";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TRUST_ARTIFACT_BYTES = 1024 * 1024;
const HOST_API_VERSION = "1.0";

interface RuntimeLike {
	state: string;
	generation: number;
	getDiagnostics(): RuntimeDiagnostics;
}

function asPluginToolRuntime(runtime: RuntimeLike | undefined): PluginToolRuntime | undefined {
	if (!runtime) return undefined;
	const request = (runtime as RuntimeLike & { request?: PluginToolRuntime["request"] }).request;
	if (typeof request !== "function") return undefined;
	return { request: request.bind(runtime) };
}

export interface PluginLifecycleRevokeCoordinatorLike {
	revoke(event: PluginLifecycleRevokeEvent): Promise<PluginLifecycleRevokeReport>;
}

export interface PluginRuntimeSupervisorLike {
	register(options: PluginRuntimeOptions): RuntimeLike;
	start(options: PluginRuntimeOptions): Promise<RuntimeLike>;
	start(pluginId: string, signal?: AbortSignal): Promise<RuntimeLike>;
	activate?(options: PluginRuntimeOptions | string, signal?: AbortSignal): Promise<RuntimeLike>;
	disable(pluginId: string): Promise<void>;
	drain(pluginId: string): Promise<void>;
	shutdown(): Promise<void>;
	get(pluginId: string): RuntimeLike | undefined;
	getDiagnostics(pluginId?: string): RuntimeDiagnostics[];
	quarantine(pluginId: string, reason: string): void;
}

export interface PluginPackageStoreLike {
	readonly root: string;
	readonly paths?: {
		root: string;
		staging: string;
		packages: string;
		current: string;
	};
	install(source: PackageSource): Promise<InstalledPackageResult>;
	readCurrent(): Promise<{
		version: number;
		plugins: Record<string, PluginPackageReference>;
	}>;
	setCurrent(
		pluginId: string,
		pointer: CurrentPackagePointer | undefined,
		options?: SetCurrentOptions,
	): Promise<{
		version: number;
		plugins: Record<string, PluginPackageReference>;
	}>;
	cleanupStaging?(): Promise<number>;
}

export interface PluginCatalogLike {
	scan(): Promise<PluginCatalogSnapshot>;
}

export interface PluginRuntimeBuildContext {
	pluginId: string;
	state: PluginStateRecord;
	package: PluginPackageSummary;
	manifest: Manifest;
	root: string;
	packagePath: string;
	dataPath: string;
	tempPath: string;
	logPath: string;
	reason: string;
}

export interface PluginTrustPolicy {
	/** Disabled by default so existing unsigned development fixtures remain installable. */
	enabled?: boolean;
	requireSignature?: boolean;
	keyring?: PluginTrustKeyring;
	sbomPolicy?: SbomInstallPolicy;
}

export interface PluginPodmanConfig {
	image: string;
	imageDigest: string;
	options?: PodmanRunnerOptions;
}

export interface PluginManagerOptions {
	root?: string;
	disabled?: boolean;
	packageStore?: PluginPackageStoreLike;
	catalog?: PluginCatalogLike;
	stateStore?: PluginStateStore;
	permissionStore?: PluginPermissionStore;
	integrationAuthorityService?: PluginIntegrationAuthorityService;
	hostServices?: PluginHostServices;
	contributionRegistry?: PluginContributionRegistry;
	toolRegistry?: PluginToolRegistry;
	agentToolBridge?: PluginAgentToolBridge;
	contributionCoordinator?: PluginContributionCoordinator;
	runtimeSupervisor?: PluginRuntimeSupervisorLike;
	runtimeOptionsFactory?: (
		context: PluginRuntimeBuildContext,
	) => PluginRuntimeOptions | Promise<PluginRuntimeOptions>;
	trustPolicy?: PluginTrustPolicy;
	podman?: PluginPodmanConfig;
	/** Injectable lifecycle fence; production uses the shared plugin platform composition root. */
	lifecycleRevokeCoordinator?: PluginLifecycleRevokeCoordinatorLike;
	restorePluginLifecycle?: (pluginId: string) => void | Promise<void>;
	/** @deprecated Use lifecycleRevokeCoordinator with a UI-session adapter in tests. */
	revokeUiSessions?: (pluginId: string) => void | Promise<void>;
	removeInstalledPackage?: (pluginId: string) => Promise<void>;
	now?: () => Date;
}

export interface PluginInstallOptions {
	pluginId?: string;
	trustTier?: TrustTier;
}

export interface PluginActivationOptions {
	reason?: string;
	signal?: AbortSignal;
	/** Automatic activation always obeys the global feature flag. */
	automatic?: boolean;
	/** Reserved for an explicit administrator health test while the flag is disabled. */
	allowWhenDisabled?: boolean;
}

export interface PluginPermissionReplaceInput {
	grants: readonly PermissionGrantInput[];
	expectedRevision: number;
	grantedBy: string;
}

export interface PluginPermissionRevokeInput {
	grantIds: readonly string[];
	expectedRevision: number;
	grantedBy: string;
}

export interface PluginPermissionMutationResult {
	status: PluginManagerStatus;
	permissions: PluginPermissionSet;
}

export interface PluginManagerStatus extends PluginStateRecord {
	installed: boolean;
	featureDisabled: boolean;
	packageStatus?: PluginPackageSummary["status"];
	manifest?: PluginPackageSummary["manifest"];
	contributions: PluginCatalogPlugin["contributions"];
	diagnostics: Array<
		| PluginCatalogPlugin["diagnostics"][number]
		| PluginCatalogSnapshot["diagnostics"][number]
		| PluginPersistenceDiagnostic
	>;
	runtime?: RuntimeDiagnostics;
	operations: PluginJournalEntry[];
}

export interface PluginManagerDiagnostics {
	featureEnabled: boolean;
	persistence: PluginPersistenceDiagnostic[];
	catalog: PluginCatalogSnapshot["diagnostics"];
	plugins: PluginManagerStatus[];
}

export class PluginManagerError extends AppError {
	constructor(message: string, code: string, statusCode = 409) {
		super(message, statusCode, code);
		this.name = "PluginManagerError";
	}
}

function isVolatileRuntimeState(state: PluginStateRecord["runtimeState"]): boolean {
	return [
		"starting",
		"handshaking",
		"activating",
		"active",
		"degraded",
		"draining",
		"deactivating",
		"backoff",
	].includes(state);
}

function currentPackage(plugin: PluginCatalogPlugin | undefined): PluginPackageSummary | undefined {
	if (!plugin?.current) return undefined;
	return plugin.packages.find(
		(item) => item.version === plugin.current?.version && item.hash === plugin.current.hash,
	);
}

function packageCompatibility(
	plugin: PluginCatalogPlugin | undefined,
): PluginStateRecord["compatibility"] {
	const current = currentPackage(plugin);
	if (current?.status === "compatible") return "compatible";
	if (current?.status === "incompatible") return "incompatible";
	return "unknown";
}

function packageError(
	plugin: PluginCatalogPlugin | undefined,
): { code: string; message: string } | null {
	const current = currentPackage(plugin);
	const diagnostic = current?.diagnostics[0] ?? plugin?.diagnostics[0];
	if (!diagnostic) return null;
	return { code: diagnostic.code, message: diagnostic.message };
}

function mapRuntimeState(state: string): PluginStateRecord["runtimeState"] {
	switch (state) {
		case "starting":
		case "handshaking":
		case "active":
		case "draining":
		case "crashed":
		case "failed":
		case "quarantine":
			return state;
		case "stopped":
			return "inactive";
		default:
			return "failed";
	}
}

function shouldQuarantine(error: unknown): boolean {
	if (!(error instanceof PluginRuntimeError)) return false;
	return (
		error.kind === "protocol" ||
		error.kind === "handshake" ||
		error.code.startsWith("HELLO_") ||
		error.code.startsWith("HEALTH_") ||
		["STDOUT_LIMIT", "INVALID_JSON_RPC", "invalid_json_rpc"].includes(error.code)
	);
}

function assertPluginId(pluginId: string): void {
	if (!pluginIdSchema.safeParse(pluginId).success) throw new ValidationError("Invalid pluginId");
}

function packageReference(
	packageSummary: PluginPackageSummary | undefined,
): PluginPackageReference | null {
	return packageSummary ? { version: packageSummary.version, hash: packageSummary.hash } : null;
}

function packagePointersEqual(
	left: PluginPackageReference | undefined,
	right: PluginPackageReference | null | undefined,
): boolean {
	if (!left || !right) return !left && !right;
	return left.version === right.version && left.hash === right.hash;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function resolveManagerToolPrincipal(
	pluginId: string,
	contributionId: string,
	runtimeSupervisor: PluginRuntimeSupervisorLike,
	stateStore: PluginStateStore,
): Promise<PluginPrincipal | undefined> {
	const runtime = runtimeSupervisor.get(pluginId);
	if (!runtime || !["active", "degraded"].includes(runtime.state)) return undefined;
	const diagnostics = runtime.getDiagnostics();
	const state = await stateStore.getState(pluginId);
	const packageVersion = diagnostics.pluginVersion ?? state?.current?.version;
	const installationId = state?.current?.hash;
	if (!packageVersion || !installationId) return undefined;
	return {
		pluginId,
		packageVersion,
		installationId,
		runtimeId: diagnostics.runtimeId,
		runtimeGeneration: diagnostics.generation,
		contributionId,
	};
}

/**
 * The host control plane for plugin lifecycle. It owns desired state and journal
 * changes; PluginCatalog remains static-only and RuntimeSupervisor owns process
 * mechanics and restart policy.
 */
export class PluginManager {
	readonly root: string;
	readonly disabled: boolean;
	readonly packageStore: PluginPackageStoreLike;
	readonly catalog: PluginCatalogLike;
	readonly stateStore: PluginStateStore;
	readonly permissionStore: PluginPermissionStore;
	readonly integrationAuthorityService: PluginIntegrationAuthorityService;
	readonly hostServices: PluginHostServices;
	readonly contributionRegistry: PluginContributionRegistry;
	readonly toolRegistry: PluginToolRegistry;
	readonly agentToolBridge: PluginAgentToolBridge;
	readonly contributionCoordinator: PluginContributionCoordinator;
	readonly runtimeSupervisor: PluginRuntimeSupervisorLike;
	private readonly runtimeOptionsFactory?: PluginManagerOptions["runtimeOptionsFactory"];
	private readonly trustPolicy: Required<Pick<PluginTrustPolicy, "enabled" | "requireSignature">> &
		Pick<PluginTrustPolicy, "keyring" | "sbomPolicy">;
	private readonly podman?: PluginPodmanConfig;
	private readonly lifecycleRevokeCoordinator: PluginLifecycleRevokeCoordinatorLike;
	private readonly restorePluginLifecycle: (pluginId: string) => void | Promise<void>;
	private readonly legacyRevokeUiSessions?: (pluginId: string) => void | Promise<void>;
	private readonly removeInstalledPackage: (pluginId: string) => Promise<void>;
	private readonly now: () => Date;
	private readonly lifecycleMutex = new AsyncMutex();
	private readonly packageMutex = new AsyncMutex();
	private catalogSnapshot?: PluginCatalogSnapshot;
	private initializePromise?: Promise<PluginManagerStatus[]>;
	private initialized = false;
	private shuttingDown = false;

	constructor(options: PluginManagerOptions = {}) {
		const root = resolve(options.root ?? options.packageStore?.root ?? getNarraforkPath("plugins"));
		this.root = root;
		this.disabled = options.disabled ?? true;
		this.packageStore = options.packageStore ?? new PluginPackageStore(root);
		this.catalog = options.catalog ?? new PluginCatalog(root);
		this.stateStore = options.stateStore ?? new PluginStateStore(root);
		this.permissionStore =
			options.permissionStore ??
			options.hostServices?.permissionStore ??
			new PluginPermissionStore({ root: this.stateStore.root, stateStore: this.stateStore });
		this.integrationAuthorityService =
			options.integrationAuthorityService ??
			new PluginIntegrationAuthorityService({ permissionStore: this.permissionStore });
		this.hostServices = options.hostServices ?? pluginPlatformServices.hostServices;
		this.runtimeSupervisor = options.runtimeSupervisor ?? new RuntimeSupervisor();
		const useSharedPlatform =
			!options.root &&
			!options.packageStore &&
			!options.catalog &&
			!options.stateStore &&
			!options.permissionStore &&
			!options.integrationAuthorityService &&
			!options.hostServices &&
			!options.runtimeSupervisor &&
			!options.contributionRegistry &&
			!options.toolRegistry &&
			!options.agentToolBridge &&
			!options.contributionCoordinator;
		if (useSharedPlatform) {
			this.contributionRegistry = pluginPlatformServices.contributionRegistry;
			this.toolRegistry = pluginPlatformServices.toolRegistry;
			this.agentToolBridge = pluginPlatformServices.toolBridge;
			this.contributionCoordinator = pluginPlatformServices.contributionCoordinator;
		} else {
			this.contributionRegistry = options.contributionRegistry ?? new PluginContributionRegistry();
			this.toolRegistry =
				options.toolRegistry ??
				new PluginToolRegistry({
					capabilityBroker: this.hostServices.capabilityBroker,
					resolvePrincipal: (pluginId, contributionId) =>
						resolveManagerToolPrincipal(
							pluginId,
							contributionId,
							this.runtimeSupervisor,
							this.stateStore,
						),
					resolveRuntime: (pluginId) => {
						const runtime = this.runtimeSupervisor.get(pluginId);
						return runtime && ["active", "degraded"].includes(runtime.state)
							? asPluginToolRuntime(runtime)
							: undefined;
					},
				});
			this.agentToolBridge =
				options.agentToolBridge ??
				new PluginAgentToolBridge({ pluginToolRegistry: this.toolRegistry });
			this.contributionCoordinator =
				options.contributionCoordinator ??
				new PluginContributionCoordinator({
					contributionRegistry: this.contributionRegistry,
					toolRegistry: this.toolRegistry,
					agentToolBridge: this.agentToolBridge,
					lifecycleStates: () => this.stateStore.listStates(),
				});
		}
		this.agentToolBridge.setActivationHandler((pluginId, activationOptions) =>
			this.activate(pluginId, activationOptions),
		);
		this.agentToolBridge.setRuntimeActiveResolver((pluginId) => {
			const runtime = this.runtimeSupervisor.get(pluginId);
			return Boolean(runtime && ["active", "degraded"].includes(runtime.state));
		});
		this.runtimeOptionsFactory = options.runtimeOptionsFactory;
		this.trustPolicy = {
			enabled: options.trustPolicy?.enabled ?? false,
			requireSignature: options.trustPolicy?.requireSignature ?? false,
			keyring: options.trustPolicy?.keyring,
			sbomPolicy: options.trustPolicy?.sbomPolicy,
		};
		this.podman = options.podman;
		this.lifecycleRevokeCoordinator =
			options.lifecycleRevokeCoordinator ?? pluginPlatformServices.lifecycleRevokeCoordinator;
		this.restorePluginLifecycle =
			options.restorePluginLifecycle ?? pluginPlatformServices.restorePlugin;
		this.legacyRevokeUiSessions = options.revokeUiSessions;
		this.removeInstalledPackage =
			options.removeInstalledPackage ?? ((pluginId) => this.removePackageFromDisk(pluginId));
		this.now = options.now ?? (() => new Date());
	}

	async initialize(): Promise<PluginManagerStatus[]> {
		if (this.initialized) return this.list();
		if (this.initializePromise) return this.initializePromise;
		this.initializePromise = this.initializeInternal();
		try {
			return await this.initializePromise;
		} finally {
			this.initializePromise = undefined;
		}
	}

	isEnabled(): boolean {
		return !this.disabled;
	}

	async install(
		source: PackageSource,
		options: PluginInstallOptions = {},
	): Promise<PluginManagerStatus> {
		await this.ensureInitialized();
		this.assertFeatureEnabled("install");
		const hintedPluginId = options.pluginId ?? (await this.discoverSourcePluginId(source));
		if (hintedPluginId) {
			assertPluginId(hintedPluginId);
			return this.lifecycleMutex.acquire(hintedPluginId, () =>
				this.installLocked(source, options, hintedPluginId),
			);
		}

		// Archive/byte sources do not reveal their identity before PackageStore validation.
		const installed = await this.packageMutex.acquire("package-store", () =>
			this.packageStore.install(source),
		);
		return this.lifecycleMutex.acquire(installed.pluginId, () =>
			this.finishInstalledPackage(installed, options),
		);
	}

	async enable(pluginId: string): Promise<PluginManagerStatus> {
		await this.ensureInitialized();
		this.assertFeatureEnabled("enable");
		assertPluginId(pluginId);
		return this.lifecycleMutex.acquire(pluginId, async () => {
			await this.refreshCatalog();
			const state = await this.requireState(pluginId);
			const plugin = this.catalogPlugin(pluginId);
			if (packageCompatibility(plugin) !== "compatible") {
				const operation = await this.stateStore.beginOperation({ pluginId, operation: "enable" });
				const error = new PluginManagerError(
					`Plugin is not compatible and cannot be enabled: ${pluginId}`,
					"PLUGIN_INCOMPATIBLE",
					422,
				);
				await this.failOperation(operation, error, "compatibility");
				throw error;
			}
			if (state.desiredState === "enabled") {
				await this.refreshCatalog("enable");
				return this.requireStatus(pluginId);
			}
			return this.runJournaled(pluginId, "enable", {}, async () => {
				await this.stateStore.updateState(pluginId, {
					desiredState: "enabled",
					compatibility: "compatible",
					lastError: null,
				});
				try {
					await this.restorePluginLifecycle(pluginId);
				} catch (error) {
					await this.stateStore.updateState(pluginId, {
						desiredState: "disabled",
						lastError: pluginStateError(error, {
							phase: "enable-restore",
							at: this.timestamp(),
						}),
					});
					throw error;
				}
				await this.refreshCatalog("enable");
				return this.requireStatus(pluginId);
			});
		});
	}

	async disable(pluginId: string): Promise<PluginManagerStatus> {
		await this.ensureInitialized();
		assertPluginId(pluginId);
		return this.lifecycleMutex.acquire(pluginId, async () => {
			const state = await this.requireState(pluginId);
			const runtime = this.runtimeSupervisor.get(pluginId);
			if (state.desiredState === "disabled" && (!runtime || runtime.state === "stopped")) {
				await this.refreshCatalog("disable");
				return this.requireStatus(pluginId);
			}
			return this.runJournaled(pluginId, "disable", {}, async () => {
				await this.revokePluginLifecycle(pluginId, "disable", "manager-disable");
				await this.stateStore.updateState(pluginId, {
					desiredState: "disabled",
					runtimeState: runtime && runtime.state !== "stopped" ? "draining" : "inactive",
				});
				await this.refreshCatalog("disable");
				try {
					await this.runtimeSupervisor.disable(pluginId);
				} catch (error) {
					this.runtimeSupervisor.quarantine(pluginId, "runtime shutdown failed");
					await this.persistFailure(pluginId, error, "disable", true);
					throw error;
				}
				await this.stateStore.updateState(pluginId, {
					desiredState: "disabled",
					runtimeState: "inactive",
					consecutiveFailures: 0,
					lastError: null,
				});
				await this.refreshCatalog("disable");
				return this.requireStatus(pluginId);
			});
		});
	}

	async activate(
		pluginId: string,
		options: PluginActivationOptions = {},
	): Promise<PluginManagerStatus> {
		await this.ensureInitialized();
		assertPluginId(pluginId);
		if (this.shuttingDown) {
			throw new PluginManagerError(
				"Plugin manager is shutting down",
				"PLUGIN_MANAGER_SHUTTING_DOWN",
				503,
			);
		}
		if (this.disabled && !options.allowWhenDisabled) {
			throw new PluginManagerError(
				options.automatic
					? "Automatic plugin activation is disabled by the host feature flag"
					: "Plugin activation is disabled by the host feature flag",
				"PLUGINS_DISABLED",
				503,
			);
		}
		return this.lifecycleMutex.acquire(pluginId, () => this.activateLocked(pluginId, options));
	}

	async deactivate(pluginId: string): Promise<PluginManagerStatus> {
		await this.ensureInitialized();
		assertPluginId(pluginId);
		return this.lifecycleMutex.acquire(pluginId, async () => {
			await this.requireState(pluginId);
			const runtime = this.runtimeSupervisor.get(pluginId);
			if (!runtime || runtime.state === "stopped") {
				await this.stateStore.updateState(pluginId, { runtimeState: "inactive" });
				await this.refreshCatalog();
				return this.requireStatus(pluginId);
			}
			return this.runJournaled(pluginId, "deactivate", {}, async () => {
				await this.revokePluginLifecycle(pluginId, "deactivate", "manager-deactivate");
				await this.stateStore.updateState(pluginId, { runtimeState: "draining" });
				await this.refreshCatalog();
				try {
					await this.runtimeSupervisor.disable(pluginId);
				} catch (error) {
					this.runtimeSupervisor.quarantine(pluginId, "runtime deactivation failed");
					await this.persistFailure(pluginId, error, "deactivate", true);
					throw error;
				}
				await this.stateStore.updateState(pluginId, {
					runtimeState: "inactive",
					consecutiveFailures: 0,
					lastError: null,
				});
				await this.refreshCatalog();
				return this.requireStatus(pluginId);
			});
		});
	}

	async getPermissions(pluginId: string): Promise<PluginPermissionSet> {
		await this.ensureInitialized();
		assertPluginId(pluginId);
		const installationId = await this.currentInstallationId(pluginId);
		const state = await this.requireState(pluginId);
		const permissions = await this.integrationAuthorityService.ensureInstallation(
			pluginId,
			installationId,
			state.grants,
		);
		await this.syncPermissionSummary(pluginId, permissions);
		return permissions;
	}

	async replacePermissions(
		pluginId: string,
		input: PluginPermissionReplaceInput,
	): Promise<PluginPermissionMutationResult> {
		await this.ensureInitialized();
		assertPluginId(pluginId);
		this.assertPermissionMutationInput(input);
		return this.lifecycleMutex.acquire(pluginId, async () => {
			const state = await this.requireState(pluginId);
			const installationId = await this.currentInstallationId(pluginId);
			await this.integrationAuthorityService.ensureInstallation(
				pluginId,
				installationId,
				state.grants,
			);
			const mutation = await this.integrationAuthorityService.replace(
				pluginId,
				installationId,
				input.grants,
				{
					expectedRevision: input.expectedRevision,
					grantedBy: input.grantedBy,
				},
			);
			return this.applyPermissionMutationLocked(pluginId, installationId, mutation);
		});
	}

	async revokePermissions(
		pluginId: string,
		input: PluginPermissionRevokeInput,
	): Promise<PluginPermissionMutationResult> {
		await this.ensureInitialized();
		assertPluginId(pluginId);
		this.assertPermissionMutationInput(input);
		return this.lifecycleMutex.acquire(pluginId, async () => {
			const state = await this.requireState(pluginId);
			const installationId = await this.currentInstallationId(pluginId);
			await this.integrationAuthorityService.ensureInstallation(
				pluginId,
				installationId,
				state.grants,
			);
			const mutation = await this.integrationAuthorityService.revoke(
				pluginId,
				installationId,
				input.grantIds,
				{
					expectedRevision: input.expectedRevision,
					grantedBy: input.grantedBy,
				},
			);
			return this.applyPermissionMutationLocked(pluginId, installationId, mutation);
		});
	}

	/** Backwards-compatible summary API. New callers should use replacePermissions/revokePermissions. */
	async updateGrants(
		pluginId: string,
		grants: Omit<PluginGrantSummary, "revision"> & { revision?: number },
	): Promise<PluginManagerStatus> {
		await this.ensureInitialized();
		assertPluginId(pluginId);
		return this.lifecycleMutex.acquire(pluginId, async () => {
			const state = await this.requireState(pluginId);
			const installationId = await this.currentInstallationId(pluginId);
			const current = await this.integrationAuthorityService.ensureInstallation(
				pluginId,
				installationId,
				state.grants,
			);
			const legacyGrants: PermissionGrantInput[] = grants.capabilities.map((capability) => ({
				capability: capability as PermissionGrant["capability"],
				scope: { type: "global" },
				grantId: `legacy-${pluginId}-${capability}`.slice(0, 128),
				grantedBy: "legacy-api",
			}));
			const mutation = await this.integrationAuthorityService.replace(
				pluginId,
				installationId,
				legacyGrants,
				{
					expectedRevision: current.revision,
					grantedBy: "legacy-api",
				},
			);
			const result = await this.applyPermissionMutationLocked(pluginId, installationId, mutation);
			return result.status;
		});
	}

	async updateGrantRevision(pluginId: string, grantRevision: number): Promise<PluginManagerStatus> {
		await this.ensureInitialized();
		assertPluginId(pluginId);
		if (!Number.isSafeInteger(grantRevision) || grantRevision < 0) {
			throw new ValidationError("Invalid grantRevision");
		}
		const state = await this.requireState(pluginId);
		return this.updateGrants(pluginId, {
			count: state.grants.count,
			capabilities: state.grants.capabilities,
			revision: grantRevision,
		});
	}

	async uninstall(pluginId: string): Promise<void> {
		await this.ensureInitialized();
		assertPluginId(pluginId);
		await this.lifecycleMutex.acquire(pluginId, async () => {
			const state = await this.stateStore.getState(pluginId);
			const plugin = this.catalogPlugin(pluginId);
			if (!state && !plugin) return;
			await this.runJournaled(
				pluginId,
				"uninstall",
				{ from: state?.current ?? plugin?.current ?? null },
				async () => {
					await this.revokePluginLifecycle(pluginId, "uninstall", "manager-uninstall", {
						grantRevision: state ? state.grants.revision + 1 : undefined,
					});
					await this.integrationAuthorityService.revokePlugin(
						pluginId,
						"Plugin installation uninstalled",
					);
					if (state) {
						await this.stateStore.updateState(pluginId, {
							desiredState: "uninstalling",
							runtimeState: "draining",
							grants: {
								count: 0,
								capabilities: [],
								revision: state.grants.revision + 1,
								updatedAt: this.timestamp(),
							},
						});
						await this.refreshCatalog("uninstall");
					}
					try {
						await this.runtimeSupervisor.disable(pluginId);
					} catch (error) {
						this.runtimeSupervisor.quarantine(pluginId, "runtime uninstall shutdown failed");
						logger.warn("Plugin runtime did not stop cleanly during uninstall", {
							pluginId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
					await this.packageMutex.acquire("package-store", () =>
						this.removeInstalledPackage(pluginId),
					);
					await this.permissionStore.clearPlugin(pluginId);
					await this.stateStore.removeState(pluginId);
					await this.refreshCatalog("uninstall");
				},
			);
		});
	}

	async getStatus(pluginId: string): Promise<PluginManagerStatus | undefined> {
		await this.ensureInitialized();
		assertPluginId(pluginId);
		return this.buildStatus(pluginId);
	}

	async get(pluginId: string): Promise<PluginManagerStatus | undefined> {
		return this.getStatus(pluginId);
	}

	async getDiagnostics(pluginId?: string): Promise<PluginManagerDiagnostics> {
		await this.ensureInitialized();
		const plugins = pluginId
			? [await this.getStatus(pluginId)].filter(
					(status): status is PluginManagerStatus => status !== undefined,
				)
			: await this.list();
		return {
			featureEnabled: this.isEnabled(),
			persistence: await this.stateStore.getDiagnostics(),
			catalog: this.catalogSnapshot?.diagnostics ?? [],
			plugins,
		};
	}

	async retry(
		pluginId: string,
		options: PluginActivationOptions = {},
	): Promise<PluginManagerStatus> {
		await this.ensureInitialized();
		this.assertFeatureEnabled("retry");
		assertPluginId(pluginId);
		return this.lifecycleMutex.acquire(pluginId, async () => {
			const state = await this.requireState(pluginId);
			if (state.runtimeState === "quarantine") {
				throw new PluginManagerError(
					"The current RuntimeSupervisor cannot clear quarantine in-process; restart or reinstall the plugin",
					"PLUGIN_RETRY_REQUIRES_RESTART",
					409,
				);
			}
			return this.activateLocked(pluginId, { ...options, reason: options.reason ?? "retry" });
		});
	}

	async list(): Promise<PluginManagerStatus[]> {
		if (!this.initialized) return this.initializePromise ?? this.initialize();
		const states = await this.stateStore.listStates();
		const pluginIds = new Set([
			...states.map((state) => state.pluginId),
			...(this.catalogSnapshot?.plugins.map((plugin) => plugin.pluginId) ?? []),
		]);
		const statuses = await Promise.all(
			[...pluginIds].sort().map((pluginId) => this.buildStatus(pluginId)),
		);
		return statuses.filter((status): status is PluginManagerStatus => status !== undefined);
	}

	async listStatuses(): Promise<PluginManagerStatus[]> {
		return this.list();
	}

	async shutdown(): Promise<void> {
		if (!this.initialized) return;
		this.shuttingDown = true;
		const states = await this.stateStore.listStates();
		const enabled = states.filter(
			(state) =>
				state.runtimeState !== "inactive" &&
				state.runtimeState !== "stopped" &&
				this.runtimeSupervisor.get(state.pluginId),
		);
		await Promise.allSettled(
			enabled.map((state) =>
				this.lifecycleMutex.acquire(state.pluginId, async () => {
					const operation = await this.stateStore.beginOperation({
						pluginId: state.pluginId,
						operation: "deactivate",
						context: { reason: "host-shutdown" },
					});
					await this.stateStore.updateOperation(operation.id, { status: "running" });
					try {
						await this.runtimeSupervisor.disable(state.pluginId);
						await this.stateStore.updateState(state.pluginId, {
							runtimeState: "inactive",
						});
						await this.stateStore.updateOperation(operation.id, { status: "succeeded" });
					} catch (error) {
						await this.persistFailure(state.pluginId, error, "shutdown", false);
						await this.failOperation(operation, error, "shutdown");
					}
				}),
			),
		);
		await this.runtimeSupervisor.shutdown().catch((error) => {
			logger.warn("Plugin runtime supervisor shutdown failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	private async initializeInternal(): Promise<PluginManagerStatus[]> {
		const snapshot = await this.stateStore.initialize();
		await this.permissionStore.initialize();
		if (this.packageStore.cleanupStaging) {
			await this.packageStore.cleanupStaging().catch((error) => {
				logger.warn("Unable to clean stale plugin staging entries", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
		const persistenceCorrupt = snapshot.diagnostics.some((item) =>
			["PLUGIN_STATE_CORRUPT", "PLUGIN_JOURNAL_CORRUPT"].includes(item.code),
		);
		const incompleteByPlugin = new Map<string, PluginJournalEntry[]>();
		for (const operation of snapshot.operations) {
			if (operation.status !== "pending" && operation.status !== "running") continue;
			incompleteByPlugin.set(operation.pluginId, [
				...(incompleteByPlugin.get(operation.pluginId) ?? []),
				operation,
			]);
		}
		const pointerRecovery = new Map<string, { restored: boolean; error?: unknown }>();
		for (const [pluginId, operations] of incompleteByPlugin) {
			const pointerOperation = operations.find(
				(operation) =>
					(operation.operation === "install" || operation.operation === "upgrade") &&
					operation.context.from !== undefined,
			);
			if (!pointerOperation) continue;
			try {
				const current = await this.packageStore.readCurrent();
				const expected = current.plugins[pluginId];
				const target = pointerOperation.context.from ?? undefined;
				if (!packagePointersEqual(expected, target)) {
					await this.packageStore.setCurrent(pluginId, target, {
						expectedCurrent: expected ?? null,
						operationId: `recover-${pointerOperation.id}`,
					});
				}
				pointerRecovery.set(pluginId, { restored: true });
			} catch (error) {
				pointerRecovery.set(pluginId, { restored: false, error });
				logger.error("Unable to compensate an interrupted plugin pointer update", {
					pluginId,
					operationId: pointerOperation.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.catalogSnapshot = await this.catalog.scan();

		const stateById = new Map(snapshot.states.map((state) => [state.pluginId, state]));
		const pluginIds = new Set([
			...stateById.keys(),
			...this.catalogSnapshot.plugins.map((plugin) => plugin.pluginId),
		]);
		const reconciled: PluginStateRecord[] = [];
		for (const pluginId of [...pluginIds].sort()) {
			const plugin = this.catalogPlugin(pluginId);
			const packageSummary = currentPackage(plugin);
			const currentState =
				stateById.get(pluginId) ?? createPluginStateRecord(pluginId, this.timestamp());
			const next: PluginStateRecord = {
				...currentState,
				current: plugin?.current ?? currentState.current,
				compatibility: packageCompatibility(plugin),
				updatedAt: this.timestamp(),
			};
			const incomplete = incompleteByPlugin.get(pluginId) ?? [];
			const corruptOrIncomplete = persistenceCorrupt || incomplete.length > 0;
			if (corruptOrIncomplete) {
				next.desiredState = "disabled";
				next.runtimeState = packageSummary ? "inactive" : "failed";
				next.lastError = pluginStateError(
					new Error(
						persistenceCorrupt
							? "Plugin persistence was corrupt; automatic activation was disabled"
							: `Recovered incomplete operation: ${incomplete.map((item) => item.operation).join(", ")}`,
					),
					{
						code: persistenceCorrupt
							? "PLUGIN_PERSISTENCE_RECOVERED"
							: "PLUGIN_OPERATION_RECOVERED",
						phase: "initialize",
						at: this.timestamp(),
					},
				);
			} else if (isVolatileRuntimeState(next.runtimeState)) {
				next.runtimeState = "inactive";
				next.lastError = pluginStateError(
					new Error("Previous runtime was lost during host restart"),
					{
						code: "PLUGIN_RUNTIME_LOST",
						phase: "initialize",
						at: this.timestamp(),
					},
				);
			}
			if (!packageSummary || !plugin?.current) {
				next.desiredState = "disabled";
				next.runtimeState = "failed";
				const diagnostic = packageError(plugin);
				next.lastError = pluginStateError(
					new Error(diagnostic?.message ?? "Current plugin package is unavailable"),
					{
						code: diagnostic?.code ?? "PLUGIN_PACKAGE_UNAVAILABLE",
						phase: "catalog",
						at: this.timestamp(),
					},
				);
			} else if (next.compatibility === "incompatible") {
				next.runtimeState = "inactive";
			}
			reconciled.push(next);
		}
		await this.stateStore.replaceStates(reconciled);
		await this.refreshCatalog("initialize");
		for (const state of reconciled) {
			if (!state.current) continue;
			const permissions = await this.integrationAuthorityService.ensureInstallation(
				state.pluginId,
				state.current.hash,
				state.grants,
			);
			await this.syncPermissionSummary(state.pluginId, permissions);
		}

		for (const [pluginId, operations] of incompleteByPlugin) {
			for (const operation of operations) {
				const recovery = pointerRecovery.get(pluginId);
				const pointerOperation =
					operation.operation === "install" || operation.operation === "upgrade";
				const restored = pointerOperation && recovery?.restored === true;
				const recoveryError = recovery?.error;
				await this.stateStore.updateOperation(operation.id, {
					status: restored ? "rolled_back" : "failed",
					context: {
						phase: restored ? "recovered-pointer-restored" : "recovered",
						recoveredAt: this.timestamp(),
					},
					error: pluginStateError(
						new Error(
							restored
								? "Host restarted; interrupted pointer update was restored"
								: recoveryError
									? `Host restarted; pointer compensation failed: ${errorMessage(recoveryError)}`
									: "Host restarted before the operation completed",
						),
						{
							code: restored ? "PLUGIN_OPERATION_ROLLED_BACK" : "PLUGIN_OPERATION_INTERRUPTED",
							phase: "initialize",
							at: this.timestamp(),
						},
					),
				});
			}
		}

		this.initialized = true;
		if (!this.disabled) {
			const startupPlugins = reconciled.filter((state) => {
				const plugin = this.catalogPlugin(state.pluginId);
				const manifest = currentPackage(plugin)?.manifest;
				return (
					state.desiredState === "enabled" &&
					state.compatibility === "compatible" &&
					manifest?.activationEvents.includes("onStartup")
				);
			});
			await Promise.allSettled(
				startupPlugins.map((state) =>
					this.activate(state.pluginId, { automatic: true, reason: "onStartup" }),
				),
			);
		}
		return this.list();
	}

	private async installLocked(
		source: PackageSource,
		options: PluginInstallOptions,
		expectedPluginId: string,
	): Promise<PluginManagerStatus> {
		const before = await this.packageStore.readCurrent();
		const operation = await this.stateStore.beginOperation({
			pluginId: expectedPluginId,
			operation: "install",
			context: { from: before.plugins[expectedPluginId] ?? null },
		});
		await this.stateStore.updateOperation(operation.id, { status: "running" });
		try {
			const installed = await this.packageMutex.acquire("package-store", () =>
				this.packageStore.install(source),
			);
			if (installed.pluginId !== expectedPluginId) {
				throw new PluginManagerError(
					`Installed package identity ${installed.pluginId} did not match ${expectedPluginId}`,
					"PLUGIN_IDENTITY_MISMATCH",
					422,
				);
			}
			const status = await this.finishInstalledPackage(installed, options, operation);
			return status;
		} catch (error) {
			await this.failOperation(operation, error, "install");
			throw error;
		}
	}

	private async finishInstalledPackage(
		installed: InstalledPackageResult,
		options: PluginInstallOptions,
		operation?: PluginJournalEntry,
	): Promise<PluginManagerStatus> {
		const journal =
			operation ??
			(await this.stateStore.beginOperation({
				pluginId: installed.pluginId,
				operation: "install",
				status: "running",
			}));
		try {
			const previousState = await this.stateStore.getState(installed.pluginId);
			const nextPackage = { version: installed.version, hash: installed.hash };
			const isUpgrade =
				previousState?.current !== null &&
				previousState?.current !== undefined &&
				!packagePointersEqual(previousState.current, nextPackage);
			if (isUpgrade) {
				const runtime = this.runtimeSupervisor.get(installed.pluginId);
				await this.revokePluginLifecycle(installed.pluginId, "upgrade", "manager-upgrade", {
					runtimeId: runtime?.getDiagnostics().runtimeId,
					runtimeGeneration: runtime?.getDiagnostics().generation,
				});
				try {
					await this.runtimeSupervisor.disable(installed.pluginId);
				} catch (error) {
					this.runtimeSupervisor.quarantine(installed.pluginId, "runtime upgrade shutdown failed");
					await this.persistFailure(installed.pluginId, error, "upgrade", true);
					throw error;
				}
			}
			await this.assertPackageTrust(
				installed.path,
				installed.manifest,
				options.trustTier,
				"install",
			);
			this.catalogSnapshot = await this.catalog.scan();
			const plugin = this.catalogPlugin(installed.pluginId);
			const packageSummary = currentPackage(plugin);
			const compatibility = packageCompatibility(plugin);
			await this.stateStore.updateState(installed.pluginId, (current) => ({
				...current,
				current: { version: installed.version, hash: installed.hash },
				desiredState: "disabled",
				compatibility,
				runtimeState: "inactive",
				trustTier: options.trustTier ?? current.trustTier,
				lastError:
					compatibility === "compatible"
						? null
						: pluginStateError(
								new Error(packageError(plugin)?.message ?? "Plugin is incompatible"),
								{
									code: packageError(plugin)?.code ?? "PLUGIN_INCOMPATIBLE",
									phase: "install",
									at: this.timestamp(),
								},
							),
				updatedAt: this.timestamp(),
			}));
			const permissions = await this.integrationAuthorityService.ensureInstallation(
				installed.pluginId,
				installed.hash,
				previousState?.grants ??
					createPluginStateRecord(installed.pluginId, this.timestamp()).grants,
				previousState?.current?.hash,
			);
			await this.syncPermissionSummary(installed.pluginId, permissions);
			await this.refreshCatalog("install");
			await this.stateStore.updateOperation(journal.id, {
				status: "succeeded",
				context: { to: packageReference(packageSummary) },
			});
			logger.info("Plugin installed into the host control plane", {
				pluginId: installed.pluginId,
				version: installed.version,
				hash: installed.hash,
				compatibility,
			});
			return this.requireStatus(installed.pluginId);
		} catch (error) {
			if (!operation) await this.failOperation(journal, error, "install");
			throw error;
		}
	}

	private async activateLocked(
		pluginId: string,
		options: PluginActivationOptions,
	): Promise<PluginManagerStatus> {
		await this.refreshCatalog();
		const state = await this.requireState(pluginId);
		if (state.desiredState !== "enabled") {
			throw new PluginManagerError(
				`Plugin must be enabled before activation: ${pluginId}`,
				"PLUGIN_NOT_ENABLED",
				422,
			);
		}
		if (state.compatibility !== "compatible") {
			throw new PluginManagerError(
				`Plugin is not compatible and cannot be activated: ${pluginId}`,
				"PLUGIN_INCOMPATIBLE",
				422,
			);
		}
		if (state.runtimeState === "quarantine") {
			throw new PluginManagerError(`Plugin is quarantined: ${pluginId}`, "PLUGIN_QUARANTINED", 423);
		}
		const existing = this.runtimeSupervisor.get(pluginId);
		if (existing?.state === "active") {
			await this.refreshCatalog("activate");
			return this.requireStatus(pluginId);
		}

		const plugin = this.catalogPlugin(pluginId);
		const packageSummary = currentPackage(plugin);
		if (!packageSummary || packageSummary.status !== "compatible") {
			throw new PluginManagerError(
				"Current plugin package is unavailable",
				"PLUGIN_PACKAGE_UNAVAILABLE",
				422,
			);
		}
		return this.runJournaled(
			pluginId,
			"activate",
			{ to: packageReference(packageSummary), reason: options.reason ?? "explicit" },
			async () => {
				await this.stateStore.updateState(pluginId, {
					runtimeState: "starting",
					lastError: null,
				});
				try {
					const manifest = await this.readPackageManifest(packageSummary);
					await this.assertPackageTrust(packageSummary.path, manifest, state.trustTier, "activate");
					if (!manifest.server) {
						await this.stateStore.updateState(pluginId, {
							runtimeState: "active",
							consecutiveFailures: 0,
						});
						await this.restorePluginLifecycle(pluginId);
						await this.refreshCatalog("activate");
						return this.requireStatus(pluginId);
					}
					const runtimeOptions = await this.createRuntimeOptions(
						state,
						packageSummary,
						manifest,
						options.reason ?? "explicit",
					);
					if (
						runtimeOptions.runner instanceof PodmanRunner &&
						!(await runtimeOptions.runner.isAvailable())
					) {
						throw new PluginManagerError(
							"Podman is unavailable; the manifest-required sandbox cannot start",
							"PLUGIN_RUNNER_UNAVAILABLE",
							503,
						);
					}
					const runtime = existing
						? await this.runtimeSupervisor.start(pluginId, options.signal)
						: await this.runtimeSupervisor.start(runtimeOptions);
					const diagnostics = runtime.getDiagnostics();
					if (runtimeOptions.runtimeId && packageSummary.hash) {
						await this.bindRuntimeForRuntime(pluginId, packageSummary.hash, diagnostics);
					}
					await this.stateStore.updateState(pluginId, (current) => ({
						...current,
						runtimeState: "active",
						runtimeGeneration: Math.max(current.runtimeGeneration, diagnostics.generation),
						restartCount: Math.max(current.restartCount, Math.max(0, diagnostics.generation - 1)),
						consecutiveFailures: 0,
						lastError: null,
						updatedAt: this.timestamp(),
					}));
					await this.restorePluginLifecycle(pluginId);
					await this.refreshCatalog("activate");
					return this.requireStatus(pluginId);
				} catch (error) {
					this.hostServices.revokeRuntime(pluginId);
					const quarantine = shouldQuarantine(error);
					if (quarantine) {
						this.runtimeSupervisor.quarantine(
							pluginId,
							error instanceof Error ? error.message : String(error),
						);
					}
					const runtime = this.runtimeSupervisor.get(pluginId);
					const diagnostics = runtime?.getDiagnostics();
					const lifecycleKind = diagnostics?.state === "quarantine" ? "quarantine" : "crash";
					try {
						await this.revokePluginLifecycle(pluginId, lifecycleKind, `runtime-${lifecycleKind}`, {
							runtimeId: diagnostics?.runtimeId,
							runtimeGeneration: diagnostics?.generation,
						});
					} catch (lifecycleError) {
						logger.error("Plugin lifecycle revocation failed after activation failure", {
							pluginId,
							error:
								lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError),
						});
						await this.persistFailure(pluginId, lifecycleError, "lifecycle-revoke", true);
					}
					await this.persistFailure(pluginId, error, "activate", quarantine);
					throw error;
				}
			},
		);
	}

	private async createRuntimeOptions(
		state: PluginStateRecord,
		packageSummary: PluginPackageSummary,
		manifest: Manifest,
		reason: string,
	): Promise<PluginRuntimeOptions> {
		const dataPath = join(this.root, "data", state.pluginId);
		const tempPath = join(this.root, "temp", state.pluginId);
		const logPath = join(this.root, "logs", state.pluginId);
		await Promise.all([
			mkdir(dataPath, { recursive: true, mode: 0o700 }),
			mkdir(tempPath, { recursive: true, mode: 0o700 }),
			mkdir(logPath, { recursive: true, mode: 0o700 }),
		]);
		const context: PluginRuntimeBuildContext = {
			pluginId: state.pluginId,
			state,
			package: packageSummary,
			manifest,
			root: this.root,
			packagePath: packageSummary.path,
			dataPath,
			tempPath,
			logPath,
			reason,
		};
		const created = this.runtimeOptionsFactory
			? await this.runtimeOptionsFactory(context)
			: await this.defaultRuntimeOptions(context);
		let runtimeOptions = created;
		if (manifest.server) {
			const existingDiagnostics = this.runtimeSupervisor.get(state.pluginId)?.getDiagnostics();
			const runtimeId =
				created.runtimeId ?? existingDiagnostics?.runtimeId ?? `rt_${generateShortId(20)}`;
			const nextGeneration =
				Math.max(
					existingDiagnostics?.generation ?? 0,
					state.runtimeGeneration,
					created.generation ?? 0,
				) + 1;
			await this.stateStore.updateState(state.pluginId, { runtimeGeneration: nextGeneration });
			const binding = await this.bindRuntimeDescriptor(context, runtimeId, nextGeneration);
			runtimeOptions = {
				...created,
				runtimeId,
				generation: nextGeneration - 1,
				dispatcher: binding.dispatcher,
			};
		}
		const onStateChange = runtimeOptions.onStateChange;
		const onCrash = runtimeOptions.onCrash;
		return {
			...runtimeOptions,
			onStateChange: (runtimeState, previous) => {
				onStateChange?.(runtimeState, previous);
				void this.handleRuntimeStateChange(state.pluginId, runtimeState);
			},
			onCrash: (error) => {
				onCrash?.(error);
				void this.observeRuntimeLifecycle(state.pluginId, "crash", error);
				void this.persistFailure(state.pluginId, error, "runtime", false);
			},
		};
	}

	private async bindRuntimeDescriptor(
		context: PluginRuntimeBuildContext,
		runtimeId: string,
		runtimeGeneration: number,
	): Promise<ReturnType<PluginHostServices["bindRuntime"]>> {
		const installationId = context.package.hash;
		const permissions = await this.integrationAuthorityService.ensureInstallation(
			context.pluginId,
			installationId,
			context.state.grants,
		);
		await this.syncPermissionSummary(context.pluginId, permissions);
		const input: PluginHostRuntimeBindingInput = {
			pluginId: context.pluginId,
			packageVersion: context.manifest.version,
			installationId,
			runtimeId,
			runtimeGeneration,
			grantRevision: permissions.revision,
			desiredState: context.state.desiredState,
			compatibilityState: context.state.compatibility,
			runtimeState: "starting",
			trustTier: context.state.trustTier,
			manifestRequested: context.manifest.permissions.host,
			grants: permissions.grants,
			dataPath: context.dataPath,
			packagePath: context.packagePath,
			getDiagnostics: () => this.runtimeSupervisor.get(context.pluginId)?.getDiagnostics(),
		};
		return this.hostServices.bindRuntime(input);
	}

	private async bindRuntimeForRuntime(
		pluginId: string,
		installationId: string,
		diagnostics: RuntimeDiagnostics,
	): Promise<ReturnType<PluginHostServices["bindRuntime"]>> {
		const state = await this.requireState(pluginId);
		await this.refreshCatalog();
		const plugin = this.catalogPlugin(pluginId);
		const packageSummary = currentPackage(plugin);
		if (!packageSummary)
			throw new PluginManagerError(
				"Current plugin package is unavailable",
				"PLUGIN_PACKAGE_UNAVAILABLE",
				422,
			);
		const manifest = await this.readPackageManifest(packageSummary);
		const dataPath = join(this.root, "data", pluginId);
		const permissions = await this.integrationAuthorityService.ensureInstallation(
			pluginId,
			installationId,
			state.grants,
		);
		await this.syncPermissionSummary(pluginId, permissions);
		return this.hostServices.bindRuntime({
			pluginId,
			packageVersion: manifest.version,
			installationId,
			runtimeId: diagnostics.runtimeId,
			runtimeGeneration: diagnostics.generation,
			grantRevision: permissions.revision,
			desiredState: state.desiredState,
			compatibilityState: state.compatibility,
			runtimeState: diagnostics.state,
			trustTier: state.trustTier,
			manifestRequested: manifest.permissions.host,
			grants: permissions.grants,
			dataPath,
			packagePath: packageSummary.path,
			getDiagnostics: () => this.runtimeSupervisor.get(pluginId)?.getDiagnostics(),
		});
	}

	private async defaultRuntimeOptions(
		context: PluginRuntimeBuildContext,
	): Promise<PluginRuntimeOptions> {
		const server = context.manifest.server;
		if (!server) throw new ValidationError("Plugin has no server runtime entry");
		const entryPath = join(context.packagePath, ...server.entry.split("/"));
		const containerEntryPath = `/plugin/${server.entry}`;
		let command: string[];
		let runner: LocalProcessRunner | PodmanRunner;
		if (context.manifest.engine.runner === "podman") {
			if (!this.podman) {
				throw new PluginManagerError(
					"Podman runner is configured by the manifest but no pinned image is configured",
					"PLUGIN_PODMAN_CONFIGURATION_MISSING",
					503,
				);
			}
			const spec: PodmanPluginSpec = {
				runtimeId: context.pluginId,
				image: this.podman.image,
				imageDigest: this.podman.imageDigest,
				packagePath: context.packagePath,
				dataPath: context.dataPath,
				// PodmanRunner owns a bounded tmpfs at /tmp; do not add a second
				// host mount from the manager's local temp directory.
			};
			runner = new PodmanRunner(spec, this.podman.options);
			switch (context.manifest.engine.runtime) {
				case "bun":
					command = ["bun", containerEntryPath, ...server.args];
					break;
				case "node":
					command = ["node", containerEntryPath, ...server.args];
					break;
				case "python":
					command = ["python", containerEntryPath, ...server.args];
					break;
				case "binary":
					command = [containerEntryPath, ...server.args];
					break;
			}
		} else {
			runner = new LocalProcessRunner({
				allowedCwds: [context.packagePath, context.dataPath, context.tempPath],
			});
			switch (context.manifest.engine.runtime) {
				case "bun":
					command = [process.execPath, entryPath, ...server.args];
					break;
				case "node":
					command = ["node", entryPath, ...server.args];
					break;
				case "python":
					command = ["python", entryPath, ...server.args];
					break;
				case "binary":
					command = [entryPath, ...server.args];
					break;
			}
		}
		const cwd =
			server.workingDirectory === "pluginData"
				? context.dataPath
				: server.workingDirectory === "pluginTemp"
					? context.tempPath
					: context.packagePath;
		return {
			pluginId: context.pluginId,
			pluginVersion: context.manifest.version,
			packageDigest: context.package.hash,
			command,
			cwd,
			runner,
			rpcProtocol: server.protocol,
			hostApiVersion: HOST_API_VERSION,
			grantedCapabilities: context.state.grants.capabilities,
			activationReason: context.reason,
			env: {
				NF_PLUGIN_PACKAGE_DIR: context.packagePath,
				NF_PLUGIN_DATA_DIR: context.dataPath,
				NF_PLUGIN_TEMP_DIR: context.tempPath,
				NF_PLUGIN_LOG_DIR: context.logPath,
			},
			timeouts: {
				handshakeMs: server.startupTimeoutMs,
				activationMs: server.activationTimeoutMs,
			},
		};
	}

	private async assertPackageTrust(
		packagePath: string,
		manifest: Manifest,
		trustTier: TrustTier | undefined,
		phase: "install" | "activate",
	): Promise<void> {
		if (!this.trustPolicy.enabled) return;
		if (phase === "activate" && trustTier === "T3") {
			throw new PluginManagerError(
				"Unapproved plugin packages cannot be activated",
				"PLUGIN_TRUST_REQUIRED",
				422,
			);
		}

		const rawSignature = await this.readOptionalTrustJson(packagePath, "signature.json");
		if (rawSignature === undefined && this.trustPolicy.requireSignature) {
			throw new PluginManagerError(
				"Plugin signature is required by the host trust policy",
				"PLUGIN_SIGNATURE_REQUIRED",
				422,
			);
		}
		if (rawSignature !== undefined) {
			let signature: ReturnType<typeof parsePluginSignature>;
			try {
				signature = parsePluginSignature(rawSignature);
			} catch (error) {
				throw new PluginManagerError(
					error instanceof Error ? error.message : "Plugin signature is invalid",
					"PLUGIN_SIGNATURE_INVALID",
					422,
				);
			}
			if (signature.pluginId !== manifest.pluginId || signature.version !== manifest.version) {
				throw new PluginManagerError(
					"Plugin signature identity does not match the manifest",
					"PLUGIN_SIGNATURE_IDENTITY_MISMATCH",
					422,
				);
			}
			if (!this.trustPolicy.keyring) {
				throw new PluginManagerError(
					"Plugin signature verification requires a configured trust keyring",
					"PLUGIN_TRUST_CONFIGURATION_MISSING",
					503,
				);
			}
			const verification = await verifyPluginPackageSignature(
				packagePath,
				signature,
				this.trustPolicy.keyring,
			);
			if (!verification.valid || !verification.trusted) {
				throw new PluginManagerError(
					`Plugin signature verification failed: ${verification.reason ?? "UNTRUSTED_SIGNATURE"}`,
					"PLUGIN_SIGNATURE_UNTRUSTED",
					422,
				);
			}
		}

		const rawSpdx = await this.readOptionalTrustJson(packagePath, "sbom.spdx.json");
		const rawSbom =
			rawSpdx !== undefined
				? rawSpdx
				: await this.readOptionalTrustJson(packagePath, "sbom.cdx.json");
		if (rawSbom === undefined && this.trustPolicy.sbomPolicy?.requireSbom) {
			throw new PluginManagerError(
				"Plugin SBOM is required by the host trust policy",
				"PLUGIN_SBOM_REQUIRED",
				422,
			);
		}
		if (rawSbom !== undefined) {
			let sbom: ReturnType<typeof parseSbom>;
			try {
				sbom = parseSbom(rawSbom);
			} catch (error) {
				throw new PluginManagerError(
					error instanceof Error ? error.message : "Plugin SBOM is invalid",
					"PLUGIN_SBOM_INVALID",
					422,
				);
			}
			if (this.trustPolicy.sbomPolicy) {
				const result = checkSbomInstallPolicy(sbom, this.trustPolicy.sbomPolicy);
				if (!result.allowed) {
					throw new PluginManagerError(
						`Plugin SBOM policy failed: ${result.violations.join(",")}`,
						"PLUGIN_SBOM_POLICY",
						422,
					);
				}
			}
		}
	}

	private async readOptionalTrustJson(root: string, name: string): Promise<unknown | undefined> {
		const path = join(root, name);
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		if (info.isSymbolicLink() || !info.isFile()) {
			throw new PluginManagerError(
				`Plugin trust artifact is not a regular file: ${name}`,
				"PLUGIN_TRUST_ARTIFACT_INVALID",
				422,
			);
		}
		if (info.size > MAX_TRUST_ARTIFACT_BYTES) {
			throw new PluginManagerError(
				`Plugin trust artifact is too large: ${name}`,
				"PLUGIN_TRUST_ARTIFACT_TOO_LARGE",
				422,
			);
		}
		try {
			return JSON.parse(await readFile(path, "utf8")) as unknown;
		} catch {
			throw new PluginManagerError(
				`Plugin trust artifact is invalid JSON: ${name}`,
				"PLUGIN_TRUST_ARTIFACT_INVALID",
				422,
			);
		}
	}

	private async readPackageManifest(packageSummary: PluginPackageSummary): Promise<Manifest> {
		const manifestPath = join(packageSummary.path, "manifest.json");
		const info = await lstat(manifestPath);
		if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) {
			throw new PluginManagerError(
				"Plugin manifest is unavailable",
				"PLUGIN_MANIFEST_UNAVAILABLE",
				422,
			);
		}
		const bytes = await readFile(manifestPath);
		if (bytes.byteLength > MAX_MANIFEST_BYTES) {
			throw new PluginManagerError(
				"Plugin manifest is too large",
				"PLUGIN_MANIFEST_TOO_LARGE",
				422,
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
		} catch {
			throw new PluginManagerError("Plugin manifest is corrupt", "PLUGIN_MANIFEST_CORRUPT", 422);
		}
		const parsed = safeParseManifest(value);
		if (!parsed.success) {
			throw new PluginManagerError("Plugin manifest is invalid", "PLUGIN_MANIFEST_INVALID", 422);
		}
		if (
			parsed.data.pluginId !== packageSummary.pluginId ||
			parsed.data.version !== packageSummary.version
		) {
			throw new PluginManagerError(
				"Plugin manifest identity does not match the catalog",
				"PLUGIN_IDENTITY_MISMATCH",
				422,
			);
		}
		return parsed.data;
	}

	private async persistRuntimeState(pluginId: string, runtimeState: string): Promise<void> {
		const existing = await this.stateStore.getState(pluginId);
		if (!existing) return;
		const runtime = this.runtimeSupervisor.get(pluginId);
		const diagnostics = runtime?.getDiagnostics();
		await this.stateStore
			.updateState(pluginId, (state) => ({
				...state,
				runtimeState: mapRuntimeState(runtimeState),
				runtimeGeneration: Math.max(state.runtimeGeneration, diagnostics?.generation ?? 0),
				restartCount: Math.max(state.restartCount, Math.max(0, (diagnostics?.generation ?? 1) - 1)),
				updatedAt: this.timestamp(),
			}))
			.catch((error) => {
				logger.warn("Unable to persist plugin runtime state", {
					pluginId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	private async persistFailure(
		pluginId: string,
		error: unknown,
		phase: string,
		quarantine: boolean,
	): Promise<void> {
		const existing = await this.stateStore.getState(pluginId);
		if (!existing) return;
		const runtime = this.runtimeSupervisor.get(pluginId);
		const diagnostics = runtime?.getDiagnostics();
		await this.stateStore.updateState(pluginId, (state) => ({
			...state,
			runtimeState: quarantine ? "quarantine" : "failed",
			crashCount: state.crashCount + 1,
			restartCount: Math.max(state.restartCount, Math.max(0, (diagnostics?.generation ?? 1) - 1)),
			consecutiveFailures: state.consecutiveFailures + 1,
			runtimeGeneration: Math.max(state.runtimeGeneration, diagnostics?.generation ?? 0),
			lastError: pluginStateError(error, { phase, at: this.timestamp() }),
			updatedAt: this.timestamp(),
		}));
		try {
			await this.refreshCatalog();
		} catch (refreshError) {
			logger.warn("Unable to synchronize plugin contributions after failure", {
				pluginId,
				phase,
				error: refreshError instanceof Error ? refreshError.message : String(refreshError),
			});
		}
	}

	private async runJournaled<T>(
		pluginId: string,
		operation: PluginJournalOperation,
		context: PluginJournalContext,
		action: () => Promise<T>,
	): Promise<T> {
		const journal = await this.stateStore.beginOperation({ pluginId, operation, context });
		await this.stateStore.updateOperation(journal.id, { status: "running" });
		try {
			const result = await action();
			await this.stateStore.updateOperation(journal.id, { status: "succeeded" });
			return result;
		} catch (error) {
			await this.failOperation(journal, error, operation);
			throw error;
		}
	}

	private async failOperation(
		operation: PluginJournalEntry,
		error: unknown,
		phase: string,
	): Promise<void> {
		await this.stateStore
			.updateOperation(operation.id, {
				status: "failed",
				error: pluginStateError(error, { phase, at: this.timestamp() }),
			})
			.catch((journalError) => {
				logger.error("Unable to persist failed plugin operation", {
					pluginId: operation.pluginId,
					operationId: operation.id,
					error: journalError instanceof Error ? journalError.message : String(journalError),
				});
			});
	}

	private assertPermissionMutationInput(
		input: PluginPermissionReplaceInput | PluginPermissionRevokeInput,
	): void {
		if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
			throw new ValidationError("Invalid expected permission revision");
		}
		if (
			typeof input.grantedBy !== "string" ||
			!input.grantedBy.trim() ||
			input.grantedBy.length > 256 ||
			/[\0\r\n]/u.test(input.grantedBy)
		) {
			throw new ValidationError("Invalid permission actor");
		}
	}

	private async currentInstallationId(pluginId: string): Promise<string> {
		const state = await this.requireState(pluginId);
		if (!state.current?.hash) {
			throw new PluginManagerError(
				"Plugin has no current installation package",
				"PLUGIN_PACKAGE_UNAVAILABLE",
				422,
			);
		}
		return state.current.hash;
	}

	private async syncPermissionSummary(
		pluginId: string,
		permissions: PluginPermissionSet,
	): Promise<void> {
		await this.stateStore.updateGrantSummary(pluginId, permissionSummary(permissions));
	}

	private async applyPermissionMutationLocked(
		pluginId: string,
		installationId: string,
		mutation: PermissionMutationResult,
	): Promise<PluginPermissionMutationResult> {
		await this.syncPermissionSummary(pluginId, mutation.set);
		if (mutation.changed) {
			await this.revokePluginLifecycle(pluginId, "grant_revision", "manager-grant-revision", {
				grantRevision: mutation.set.revision,
			});
		}
		const state = await this.requireState(pluginId);
		const runtime = this.runtimeSupervisor.get(pluginId);
		const runtimeCanAccessHost = runtime?.state === "active" || runtime?.state === "degraded";
		let rebound = false;
		if (runtime && runtimeCanAccessHost) {
			const diagnostics = runtime.getDiagnostics();
			const binding = this.hostServices.getRuntimeBinding(pluginId, diagnostics.runtimeId);
			const bindingIsCurrent =
				binding?.plugin.installationId === installationId &&
				binding.plugin.runtimeGeneration === diagnostics.generation &&
				binding.grantRevision === mutation.set.revision;
			if (mutation.changed || !bindingIsCurrent) {
				await this.bindRuntimeForRuntime(pluginId, installationId, diagnostics);
				rebound = true;
			}
		}
		const canRestore =
			state.desiredState === "enabled" &&
			(runtime ? runtimeCanAccessHost : state.runtimeState === "active");
		if ((mutation.changed || rebound) && canRestore) {
			await this.restorePluginLifecycle(pluginId);
		}
		return {
			status: await this.requireStatus(pluginId),
			permissions: mutation.set,
		};
	}

	private async revokePluginLifecycle(
		pluginId: string,
		kind: PluginLifecycleRevokeEventKind,
		reason: string,
		details: Partial<
			Pick<PluginLifecycleRevokeEvent, "runtimeId" | "runtimeGeneration" | "grantRevision">
		> = {},
	): Promise<PluginLifecycleRevokeReport> {
		const deterministicRuntimeEvent =
			kind === "crash" ||
			kind === "quarantine" ||
			kind === "runtime_generation" ||
			(kind === "grant_revision" && details.grantRevision !== undefined);
		const eventId = deterministicRuntimeEvent
			? [
					"plugin-lifecycle",
					kind,
					pluginId,
					details.runtimeId ?? "runtime",
					details.runtimeGeneration ?? 0,
					details.grantRevision ?? 0,
				].join(":")
			: `plugin-lifecycle:${kind}:${pluginId}:${generateShortId(12)}`;
		let report: PluginLifecycleRevokeReport;
		try {
			report = await this.lifecycleRevokeCoordinator.revoke({
				eventId,
				pluginId,
				kind,
				reason,
				...details,
			});
		} catch (error) {
			this.hostServices.revokeRuntime(
				pluginId,
				details.runtimeId,
				kind === "runtime_generation" ? undefined : details.runtimeGeneration,
			);
			throw error;
		}
		await this.legacyRevokeUiSessions?.(pluginId);
		return report;
	}

	private async handleRuntimeStateChange(pluginId: string, runtimeState: string): Promise<void> {
		const runtime = this.runtimeSupervisor.get(pluginId);
		const diagnostics = runtime?.getDiagnostics();
		try {
			if (
				runtimeState === "active" &&
				diagnostics &&
				(await this.isRuntimeGenerationChange(pluginId, diagnostics.generation))
			) {
				await this.revokePluginLifecycle(
					pluginId,
					"runtime_generation",
					"runtime-generation-changed",
					{
						runtimeId: diagnostics.runtimeId,
						runtimeGeneration: diagnostics.generation,
					},
				);
				const state = await this.requireState(pluginId);
				if (state.current?.hash) {
					await this.bindRuntimeForRuntime(pluginId, state.current.hash, diagnostics);
				}
				await this.restorePluginLifecycle(pluginId);
			}
			if (["crashed", "failed", "quarantine"].includes(runtimeState)) {
				const kind = runtimeState === "quarantine" ? "quarantine" : "crash";
				await this.revokePluginLifecycle(pluginId, kind, `runtime-${kind}`, {
					runtimeId: diagnostics?.runtimeId,
					runtimeGeneration: diagnostics?.generation,
				});
			}
			await this.persistRuntimeState(pluginId, runtimeState);
			await this.refreshCatalog();
		} catch (error) {
			await this.handleObservedLifecycleRevokeFailure(pluginId, runtimeState, error);
		}
	}

	private async observeRuntimeLifecycle(
		pluginId: string,
		kind: Extract<PluginLifecycleRevokeEventKind, "crash" | "quarantine">,
		sourceError?: unknown,
	): Promise<void> {
		const diagnostics = this.runtimeSupervisor.get(pluginId)?.getDiagnostics();
		try {
			await this.revokePluginLifecycle(pluginId, kind, `runtime-${kind}`, {
				runtimeId: diagnostics?.runtimeId,
				runtimeGeneration: diagnostics?.generation,
			});
		} catch (error) {
			await this.handleObservedLifecycleRevokeFailure(
				pluginId,
				diagnostics?.state ?? kind,
				error,
				sourceError,
			);
		}
	}

	private async handleObservedLifecycleRevokeFailure(
		pluginId: string,
		runtimeState: string,
		error: unknown,
		sourceError?: unknown,
	): Promise<void> {
		logger.error("Plugin lifecycle revocation failed for a runtime event", {
			pluginId,
			runtimeState,
			error: error instanceof Error ? error.message : String(error),
			revokeErrors:
				error instanceof PluginLifecycleRevokeError
					? error.report.errors.map((failure) => ({
							layer: failure.layer,
							action: failure.action,
							code: failure.code,
							message: failure.message,
						}))
					: undefined,
		});
		if (runtimeState !== "quarantine") {
			this.runtimeSupervisor.quarantine(pluginId, "lifecycle revocation failed");
		}
		await this.persistFailure(pluginId, error, "lifecycle-revoke", true).catch((persistError) => {
			logger.error("Unable to persist plugin lifecycle revocation failure", {
				pluginId,
				error: persistError instanceof Error ? persistError.message : String(persistError),
				sourceError: sourceError instanceof Error ? sourceError.message : undefined,
			});
		});
	}

	private async isRuntimeGenerationChange(pluginId: string, generation: number): Promise<boolean> {
		const state = await this.stateStore.getState(pluginId);
		return !!state && state.runtimeGeneration > 0 && generation > state.runtimeGeneration;
	}

	private async refreshCatalog(
		operation:
			| "refresh"
			| "initialize"
			| "install"
			| "enable"
			| "activate"
			| "disable"
			| "uninstall" = "refresh",
	): Promise<PluginCatalogSnapshot> {
		this.catalogSnapshot = await this.catalog.scan();
		let report: { changed: boolean; revision: number };
		switch (operation) {
			case "initialize":
				report = await this.contributionCoordinator.initialize(this.catalogSnapshot);
				break;
			case "install":
				report = await this.contributionCoordinator.install(this.catalogSnapshot);
				break;
			case "enable":
				report = await this.contributionCoordinator.enable(this.catalogSnapshot);
				break;
			case "activate":
				report = await this.contributionCoordinator.activate(this.catalogSnapshot);
				break;
			case "disable":
				report = await this.contributionCoordinator.disable(this.catalogSnapshot);
				break;
			case "uninstall":
				report = await this.contributionCoordinator.uninstall(this.catalogSnapshot);
				break;
			default:
				report = await this.contributionCoordinator.refresh(this.catalogSnapshot);
				break;
		}
		if (report.changed) {
			eventBus.emit({
				type: "plugin:contributions_changed",
				revision: report.revision,
				reason: operation,
			});
		}
		return this.catalogSnapshot;
	}

	private catalogPlugin(pluginId: string): PluginCatalogPlugin | undefined {
		return this.catalogSnapshot?.plugins.find((plugin) => plugin.pluginId === pluginId);
	}

	private async requireState(pluginId: string): Promise<PluginStateRecord> {
		const state = await this.stateStore.getState(pluginId);
		if (!state) throw new NotFoundError("Plugin", pluginId);
		return state;
	}

	private async requireStatus(pluginId: string): Promise<PluginManagerStatus> {
		const status = await this.buildStatus(pluginId);
		if (!status) throw new NotFoundError("Plugin", pluginId);
		return status;
	}

	private async buildStatus(pluginId: string): Promise<PluginManagerStatus | undefined> {
		const state = await this.stateStore.getState(pluginId);
		const plugin = this.catalogPlugin(pluginId);
		if (!state && !plugin) return undefined;
		const effectiveState = state ?? createPluginStateRecord(pluginId, this.timestamp());
		const packageSummary = currentPackage(plugin);
		const runtime = this.runtimeSupervisor.getDiagnostics(pluginId)[0];
		return {
			...effectiveState,
			installed: Boolean(packageSummary),
			featureDisabled: this.disabled,
			packageStatus: packageSummary?.status,
			manifest: packageSummary?.manifest,
			contributions: plugin?.contributions ?? [],
			diagnostics: [
				...(this.catalogSnapshot?.diagnostics ?? []),
				...(plugin?.diagnostics ?? []),
				...(await this.stateStore.getDiagnostics()),
			],
			runtime,
			operations: await this.stateStore.listOperations(pluginId),
		};
	}

	private async discoverSourcePluginId(source: PackageSource): Promise<string | undefined> {
		if (typeof source !== "string" && !(source instanceof URL)) return undefined;
		const path = resolve(source instanceof URL ? source.pathname : source);
		try {
			const info = await lstat(path);
			if (!info.isDirectory()) return undefined;
			const manifestPath = join(path, "manifest.json");
			const manifestInfo = await lstat(manifestPath);
			if (
				!manifestInfo.isFile() ||
				manifestInfo.isSymbolicLink() ||
				manifestInfo.size > MAX_MANIFEST_BYTES
			) {
				return undefined;
			}
			const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
			const pluginId = (raw as { pluginId?: unknown }).pluginId;
			return typeof pluginId === "string" && pluginIdSchema.safeParse(pluginId).success
				? pluginId
				: undefined;
		} catch {
			return undefined;
		}
	}

	private async removePackageFromDisk(pluginId: string): Promise<void> {
		assertPluginId(pluginId);
		const current = await this.packageStore.readCurrent();
		if (current.plugins[pluginId]) {
			await this.packageStore.setCurrent(pluginId, undefined, {
				expectedCurrent: current.plugins[pluginId],
				operationId: `uninstall-${pluginId}`,
			});
		}
		const packagesPath = this.packageStore.paths?.packages ?? join(this.root, "packages");
		await rm(join(packagesPath, pluginId), { recursive: true, force: true });
		await Promise.all([
			rm(join(this.root, "temp", pluginId), { recursive: true, force: true }),
			rm(join(this.root, "logs", pluginId), { recursive: true, force: true }),
		]);
	}

	private assertFeatureEnabled(operation: string): void {
		if (this.disabled) {
			throw new PluginManagerError(
				`Plugin ${operation} is disabled by the host feature flag`,
				"PLUGINS_DISABLED",
				503,
			);
		}
	}

	private timestamp(): string {
		return this.now().toISOString();
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) return;
		await this.initialize();
	}
}

/**
 * Resolve whether the plugin subsystem is enabled. The environment variables
 * `NF_PLUGINS_ENABLED` / `NARRAFORK_PLUGINS_ENABLED`, when set, take precedence
 * (operational kill switch: "0"/"false" force-disables). When neither is set,
 * fall back to `settings.plugins.enabled` (defaults to true).
 */
function pluginsEnabledFromEnvironment(): boolean {
	const value = process.env.NF_PLUGINS_ENABLED ?? process.env.NARRAFORK_PLUGINS_ENABLED;
	if (value !== undefined) {
		return value === "1" || value.toLowerCase() === "true";
	}
	return settings.plugins?.enabled ?? true;
}

function pluginTrustPolicyFromEnvironment(): PluginTrustPolicy | undefined {
	const enabled =
		process.env.NF_PLUGIN_TRUST_ENFORCED === "1" ||
		process.env.NF_PLUGIN_TRUST_ENFORCED?.toLowerCase() === "true";
	const requireSignature =
		process.env.NF_PLUGIN_REQUIRE_SIGNATURE === "1" ||
		process.env.NF_PLUGIN_REQUIRE_SIGNATURE?.toLowerCase() === "true";
	const requireSbom =
		process.env.NF_PLUGIN_REQUIRE_SBOM === "1" ||
		process.env.NF_PLUGIN_REQUIRE_SBOM?.toLowerCase() === "true";
	if (!enabled && !requireSignature && !requireSbom) return undefined;
	return {
		enabled: true,
		requireSignature,
		sbomPolicy: requireSbom ? { requireSbom: true } : undefined,
	};
}

function podmanConfigFromEnvironment(): PluginPodmanConfig | undefined {
	const image = process.env.NF_PLUGIN_PODMAN_IMAGE;
	const imageDigest = process.env.NF_PLUGIN_PODMAN_IMAGE_DIGEST;
	return image && imageDigest ? { image, imageDigest } : undefined;
}

export const pluginManager = new PluginManager({
	disabled: !pluginsEnabledFromEnvironment(),
	trustPolicy: pluginTrustPolicyFromEnvironment(),
	podman: podmanConfigFromEnvironment(),
	runtimeSupervisor: pluginPlatformServices.runtimeSupervisor,
	stateStore: pluginPlatformServices.stateStore,
	permissionStore: pluginPlatformServices.permissionStore,
	hostServices: pluginPlatformServices.hostServices,
	contributionRegistry: pluginPlatformServices.contributionRegistry,
	toolRegistry: pluginPlatformServices.toolRegistry,
	agentToolBridge: pluginPlatformServices.toolBridge,
	contributionCoordinator: pluginPlatformServices.contributionCoordinator,
	lifecycleRevokeCoordinator: pluginPlatformServices.lifecycleRevokeCoordinator,
	restorePluginLifecycle: pluginPlatformServices.restorePlugin,
});

pluginPlatformServices.publicApi.configureAdapters(
	createCorePluginPublicApiAdapters({ db, pluginManager }),
);
