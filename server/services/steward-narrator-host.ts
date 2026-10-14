import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import { narratorReadableWhere } from "./narrator-acl";
import { integrationAuditService } from "./integration-audit-service";
import { canWriteNarrator, NARRATOR_ACL_COLUMNS } from "./narrator-acl";
import type {
	CapabilityAuthorizationRequest,
	CapabilityBroker,
	HostCallContext,
	PluginPrincipal,
} from "./plugin-capability-broker";
import type { PluginCommandRegistry } from "./plugin-command-registry";
import type { PluginPackageStore } from "./plugin-package-store";
import type { PluginPermissionStore } from "./plugin-permission-store";
import { createCommandRequest, type PluginPublicApi } from "./plugin-public-api";
import type { PluginStateRecord, PluginStateStore } from "./plugin-state-store";
import type { PluginToolRegistry } from "./plugin-tool-registry";
import { setStewardMessageAuthorizer } from "./steward-message-admission";
import {
	STEWARD_BIND_COMMAND_ID,
	STEWARD_PLUGIN_ID,
	STEWARD_PANEL_SEND_COMMAND_ID,
	STEWARD_RECIPIENTS_COMMAND_ID,
	STEWARD_READ_BINDING_COMMAND_ID,
	STEWARD_SEND_TOOL_ID,
	type StewardAuditRecord,
	StewardNarratorError,
	StewardNarratorService,
	type StewardNarratorServiceOptions,
} from "./steward-narrator-service";

export const STEWARD_APPROVED_VERSION = "0.2.0";
export const STEWARD_APPROVED_SOURCE_HASH =
	"06242b7dcbb549afe0bf8e18598b22cd08cd43ccde61cc949f919173fae136d8";
export const STEWARD_APPROVED_PACKAGE_HASH =
	"4bff64215cc7f1a971a2f5cbd1a0f275b3415b7fb3173e8ce9283819b43c3657";
export const STEWARD_HOST_RUNTIME_ID = "host.steward";
const STEWARD_CAPABILITIES = [
	"storage.read_self",
	"storage.write_self",
	"command.narrator.send_message",
];

/** Only host-owned resource/audit seams are injectable; installation and grants remain mandatory. */
export type StewardHostDependencies = Partial<
	Pick<
		StewardNarratorServiceOptions,
		"lookupNarrator" | "resolveUserPrincipal" | "canWriteNarrator" | "auditSink" | "clock"
	>
>;
export interface StewardHostOptions {
	stateStore: Pick<PluginStateStore, "getState">;
	packageStore: Pick<PluginPackageStore, "verifyPackageIntegrity" | "readCurrent">;
	permissionStore: Pick<PluginPermissionStore, "getSet">;
	capabilityBroker: CapabilityBroker;
	publicApi: Pick<PluginPublicApi, "executeHostCommand">;
	storageFactory: StewardNarratorServiceOptions["storageFactory"];
	toolRegistry: Pick<PluginToolRegistry, "registerHostHandler">;
	pluginCommandRegistry: Pick<PluginCommandRegistry, "registerHostHandler">;
	dependencies?: StewardHostDependencies;
}

function trustedInstallation(state: PluginStateRecord | undefined): state is PluginStateRecord {
	return (
		!!state &&
		state.pluginId === STEWARD_PLUGIN_ID &&
		state.current?.version === STEWARD_APPROVED_VERSION &&
		state.current.hash === STEWARD_APPROVED_PACKAGE_HASH &&
		!!state.installationId &&
		state.desiredState === "enabled" &&
		state.compatibility === "compatible" &&
		["inactive", "active", "degraded"].includes(state.runtimeState)
	);
}

async function productionAudit(record: StewardAuditRecord): Promise<void> {
	await integrationAuditService.record({
		principal: record.userId ? { type: "user", id: record.userId } : { type: "system" },
		transport: "plugin-host",
		operationId: `steward.${record.operation}`,
		outcome: record.outcome === "cancelled" ? "failed" : record.outcome,
		reasonCode: record.errorCode,
		createdAt: record.at,
		metadata: {
			pluginId: record.pluginId,
			contributionId: record.contributionId,
			requestId: record.requestId,
			correlationId: record.correlationId,
			principalKind: record.principalKind,
			stewardNarratorId: record.stewardNarratorId,
			targetNarratorId: record.targetNarratorId,
			bindingRevision: record.revision,
			length: record.length,
		},
	});
}

/** Install handlers once; resolve the real installation, immutable package and current grants per call. */
export function registerStewardHostContributions(options: StewardHostOptions): {
	service: StewardNarratorService;
	dispose: () => void;
} {
	let disposed = false;
	let publishedPrincipal: PluginPrincipal | undefined;
	const isTrusted = async (): Promise<boolean> => {
		const state = await options.stateStore.getState(STEWARD_PLUGIN_ID);
		if (disposed || !trustedInstallation(state)) return false;
		const pointer = (await options.packageStore.readCurrent()).plugins[STEWARD_PLUGIN_ID];
		return (
			pointer?.version === state.current?.version &&
			pointer?.hash === state.current?.hash &&
			(await options.packageStore.verifyPackageIntegrity(
				STEWARD_PLUGIN_ID,
				STEWARD_APPROVED_VERSION,
				STEWARD_APPROVED_PACKAGE_HASH,
			))
		);
	};
	const ensureBound = async (expected?: PluginPrincipal): Promise<PluginPrincipal | undefined> => {
		if (disposed) return undefined;
		const state = await options.stateStore.getState(STEWARD_PLUGIN_ID);
		if (!trustedInstallation(state) || !state.installationId || !(await isTrusted()))
			return undefined;
		const principal: PluginPrincipal = {
			pluginId: STEWARD_PLUGIN_ID,
			packageVersion: STEWARD_APPROVED_VERSION,
			runtimeId: STEWARD_HOST_RUNTIME_ID,
			runtimeGeneration: state.runtimeGeneration,
			installationId: state.installationId,
		};
		if (
			expected &&
			(expected.pluginId !== principal.pluginId ||
				expected.packageVersion !== principal.packageVersion ||
				expected.installationId !== principal.installationId ||
				expected.runtimeId !== principal.runtimeId ||
				expected.runtimeGeneration !== principal.runtimeGeneration)
		)
			return undefined;
		const permissionSet = await options.permissionStore.getSet(
			STEWARD_PLUGIN_ID,
			principal.installationId,
		);
		// Do not publish a binding for state replaced while permission I/O was in flight.
		const latest = await options.stateStore.getState(STEWARD_PLUGIN_ID);
		if (
			!trustedInstallation(latest) ||
			latest.installationId !== principal.installationId ||
			latest.runtimeGeneration !== principal.runtimeGeneration ||
			latest.grants.revision !== permissionSet.revision ||
			disposed
		)
			return undefined;
		if (
			permissionSet.pluginId !== STEWARD_PLUGIN_ID ||
			permissionSet.installationId !== principal.installationId
		)
			return undefined;
		const previousBinding = options.capabilityBroker.getBinding(
			STEWARD_PLUGIN_ID,
			STEWARD_HOST_RUNTIME_ID,
		);
		if (
			publishedPrincipal?.installationId === principal.installationId &&
			publishedPrincipal.runtimeGeneration === principal.runtimeGeneration &&
			!previousBinding
		)
			return undefined;
		if (
			previousBinding?.plugin?.installationId === principal.installationId &&
			(previousBinding.grantRevision ?? 0) > permissionSet.revision
		)
			return undefined;
		options.capabilityBroker.setBinding(STEWARD_PLUGIN_ID, {
			plugin: principal,
			desiredState: "enabled",
			compatibilityState: "compatible",
			// A UI-only package has no process. This is its separately identified host runtime.
			runtimeState: "active",
			runtimeGeneration: principal.runtimeGeneration,
			manifestRequested: STEWARD_CAPABILITIES,
			installationGrants: permissionSet.grants
				.filter(
					(grant) =>
						grant.pluginId === STEWARD_PLUGIN_ID &&
						grant.installationId === principal.installationId &&
						STEWARD_CAPABILITIES.includes(grant.capability),
				)
				.map((grant) => ({
					capability: grant.capability,
					scope: grant.scope,
					grantId: grant.grantId,
					grantedBy: grant.grantedBy,
					constraints: grant.constraints,
					expiresAt: grant.expiresAt,
				})),
			hostPolicy: STEWARD_CAPABILITIES,
			currentUserAuthority: STEWARD_CAPABILITIES,
			contributionPolicy: STEWARD_CAPABILITIES,
			runnerEnforcement: STEWARD_CAPABILITIES,
			grantRevision: permissionSet.revision,
		});
		publishedPrincipal = principal;
		// Never restore a revoked/cleared runtime in the same installation generation.
		// Never broker.restore() here: lifecycle revocation must not be undone by a caller.
		return principal;
	};
	const requireLive = async (host: HostCallContext): Promise<void> => {
		if (!(await ensureBound(host.plugin))) throw new StewardNarratorError("UNTRUSTED_INSTALLATION");
	};
	const authorize = async (input: CapabilityAuthorizationRequest) => {
		await requireLive(input.context);
		const target =
			input.capability === "command.narrator.send_message" && input.resource?.type === "narrator"
				? input.resource.id
				: undefined;
		// Service has already checked write ACL on source and target. Check grants against the
		// actual target, retaining authenticated source narrator in invocation (never plugin input).
		const context = target
			? { ...input.context, scope: { ...input.context.scope, narratorId: target } }
			: input.context;
		return options.capabilityBroker.authorize({ ...input, context, scope: context.scope });
	};
	const service = new StewardNarratorService({
		storageFactory: options.storageFactory,
		authorize,
		lookupNarrator: (id) =>
			db.query.narrators.findFirst({ where: eq(narrators.id, id), columns: NARRATOR_ACL_COLUMNS }),
		resolveUserPrincipal: async (userId) => {
			const user = await db.query.users.findFirst({
				where: eq(users.id, userId),
				columns: { id: true, role: true },
			});
			return user ? { userId: user.id, isAdmin: user.role === "admin" } : undefined;
		},
		canWriteNarrator: (principal, row) => canWriteNarrator(row, principal),
		auditSink: productionAudit,
		...options.dependencies,
		sendAdapter: {
			async sendMessage(input) {
				await requireLive(input.context);
				const result = await options.publicApi.executeHostCommand(
					input.context,
					createCommandRequest(input.context, "narrafork.narrator.send_message", {
						narratorId: input.narratorId,
						message: input.message,
					}),
					{ signal: input.signal, stewardProvenance: input.stewardProvenance },
				);
				if (
					result.status !== "succeeded" ||
					!result.data ||
					typeof result.data !== "object" ||
					!("messageId" in result.data) ||
					typeof result.data.messageId !== "string"
				)
					throw new StewardNarratorError(
						result.status === "cancelled" ? "CANCELLED" : "SEND_FAILED",
						503,
					);
				return { messageId: result.data.messageId };
			},
		},
	});
	const removeMessageAuthorizer = setStewardMessageAuthorizer(async (provenance, host, signal) => {
		await requireLive(host);
		await service.revalidateDelivery(provenance, host, signal);
	});
	const template: PluginPrincipal = {
		pluginId: STEWARD_PLUGIN_ID,
		packageVersion: STEWARD_APPROVED_VERSION,
		runtimeId: STEWARD_HOST_RUNTIME_ID,
		runtimeGeneration: 0,
		installationId: "host-template-not-an-installation",
	};
	const registration = (
		capability: "storage.read_self" | "storage.write_self" | "command.narrator.send_message",
	) => ({
		principal: template,
		followInstallation: true,
		capability,
		isTrusted,
		resolvePrincipal: () => ensureBound(),
	});
	const unregister = [
		options.pluginCommandRegistry.registerHostHandler(
			STEWARD_PLUGIN_ID,
			STEWARD_BIND_COMMAND_ID,
			async (_input, context) => {
				if (context.host.invocation.source !== "ui")
					throw new StewardNarratorError("BIND_REQUIRES_UI");
				return { output: await service.bindCurrentNarrator(context.host, context.signal) };
			},
			registration("storage.write_self"),
		),
		options.pluginCommandRegistry.registerHostHandler(
			STEWARD_PLUGIN_ID,
			STEWARD_READ_BINDING_COMMAND_ID,
			async (_input, context) => {
				if (context.host.invocation.source !== "ui")
					throw new StewardNarratorError("BINDING_REQUIRES_UI");
				await requireLive(context.host);
				return { output: await service.readBinding(context.host) };
			},
			registration("storage.read_self"),
		),
		options.pluginCommandRegistry.registerHostHandler(
			STEWARD_PLUGIN_ID,
			STEWARD_RECIPIENTS_COMMAND_ID,
			async (input, context) => {
				if (context.host.invocation.source !== "ui")
					throw new StewardNarratorError("INVALID_SEND_SOURCE");
				await requireLive(context.host);
				const userId = context.host.invocation.userId;
				if (!userId) throw new StewardNarratorError("USER_REQUIRED");
				const request = input && typeof input === "object" && !Array.isArray(input)
					? input as Record<string, unknown>
					: {};
				const limit = Number.isInteger(request.limit) ? Math.min(100, Math.max(1, request.limit as number)) : 100;
				let cursor: { updatedAt: string; id: string } | undefined;
				if (request.cursor !== undefined) {
					const value = request.cursor as Record<string, unknown>;
					if (!value || typeof value !== "object" || typeof value.updatedAt !== "string" ||
						!Number.isFinite(Date.parse(value.updatedAt)) || typeof value.id !== "string" || !value.id.trim())
						throw new StewardNarratorError("INVALID_INPUT", 400);
					cursor = { updatedAt: new Date(value.updatedAt).toISOString(), id: value.id };
				}
				const cursorPredicate = cursor
					? or(
						lt(narrators.updatedAt, cursor.updatedAt),
						and(eq(narrators.updatedAt, cursor.updatedAt), lt(narrators.id, cursor.id)),
					)
					: undefined;
				const rows = await db
					.select({ id: narrators.id, title: narrators.title, handle: narrators.handle, updatedAt: narrators.updatedAt })
					.from(narrators)
					.where(and(
						narratorReadableWhere({ userId, isAdmin: context.host.invocation.userRole === "admin" }),
						cursorPredicate,
					))
					.orderBy(desc(narrators.updatedAt), desc(narrators.id))
					.limit(limit + 1);
				const hasMore = rows.length > limit;
				const items = rows.slice(0, limit).map((row) => ({
					id: row.id,
					title: row.title ?? null,
					handle: row.handle ?? null,
				}));
				const last = rows[limit - 1];
				return {
					output: {
						items,
					...(hasMore && last ? { nextCursor: { updatedAt: last.updatedAt, id: last.id } } : {}),
					},
				};
			},
			registration("command.narrator.send_message"),
		),
		options.pluginCommandRegistry.registerHostHandler(
			STEWARD_PLUGIN_ID,
			STEWARD_PANEL_SEND_COMMAND_ID,
			async (input, context) => {
				if (context.host.invocation.source !== "ui")
					throw new StewardNarratorError("INVALID_SEND_SOURCE");
				const sendContext = {
					...context.host,
					plugin: { ...context.host.plugin, contributionId: STEWARD_SEND_TOOL_ID },
				};
				const result = await service.send(sendContext, input, context.signal);
				return { output: result };
			},
			registration("command.narrator.send_message"),
		),
		options.toolRegistry.registerHostHandler(
			STEWARD_PLUGIN_ID,
			STEWARD_SEND_TOOL_ID,
			async (input, context) => {
				const result = await service.send(context.host, input, context.signal);
				return { output: JSON.stringify(result), metadata: { messageId: result.messageId } };
			},
			registration("command.narrator.send_message"),
		),
	];
	return {
		service,
		dispose: () => {
			disposed = true;
			removeMessageAuthorizer();
			for (const remove of unregister) remove();
			options.capabilityBroker.clearBinding(STEWARD_PLUGIN_ID, STEWARD_HOST_RUNTIME_ID);
		},
	};
}
