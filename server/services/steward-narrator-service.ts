import { AsyncMutex } from "@server/lib/async-mutex";
import { AppError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import { z } from "zod";
import type { NarratorAclRow, NarratorPrincipal } from "./narrator-acl";
import {
	type CapabilityAuthorizationRequest,
	type HostCallContext,
	hostCallContextSchema,
} from "./plugin-capability-broker";
import type { NarratorCommandAdapter } from "./plugin-public-api";
import type {
	PluginStorageCommitOptions,
	PluginStorageEntry,
	PluginStorageGetInput,
	PluginStorageSetInput,
} from "./plugin-storage";
import {
	STEWARD_BIND_COMMAND_ID,
	STEWARD_BINDING_KEY,
	STEWARD_MAX_MESSAGE_LENGTH,
	STEWARD_PLUGIN_ID,
	STEWARD_READ_BINDING_COMMAND_ID,
	STEWARD_SEND_TOOL_ID,
} from "./steward-narrator-constants";

export * from "./steward-narrator-constants";

const identifierSchema = z
	.string()
	.min(1)
	.max(128)
	.refine(
		(value) =>
			value === value.trim() &&
			[...value].every((character) => {
				const code = character.charCodeAt(0);
				return code >= 0x20 && code !== 0x7f;
			}),
	);
const bindingSchema = z
	.object({
		stewardNarratorId: identifierSchema,
		userId: identifierSchema,
		boundByNarratorId: identifierSchema,
		boundAt: z.string().datetime({ offset: true }),
		revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	})
	.strict();
const provenanceSchema = z
	.object({
		userId: identifierSchema,
		pluginId: identifierSchema,
		contributionId: identifierSchema,
		requestId: identifierSchema,
		correlationId: identifierSchema,
		stewardNarratorId: identifierSchema,
		targetNarratorId: identifierSchema,
		bindingRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	})
	.strict();
const messageSchema = z
	.string()
	.min(1)
	.max(STEWARD_MAX_MESSAGE_LENGTH)
	.refine((value) => value.trim().length > 0);
const sendInputSchema = z.union([
	z.object({ targetNarratorId: identifierSchema, message: messageSchema }).strict(),
	z.object({ narratorId: identifierSchema, message: messageSchema }).strict(),
]);

export type StewardBinding = z.infer<typeof bindingSchema>;
export type StewardHostContext = HostCallContext & {
	invocation: HostCallContext["invocation"] & { narratorId?: string };
};
export type StewardSendInput = z.infer<typeof sendInputSchema>;
export interface StewardSource {
	userId: string;
	pluginId: string;
	contributionId: string;
	requestId: string;
	correlationId: string;
	stewardNarratorId: string;
	targetNarratorId: string;
	bindingRevision: number;
}

export interface StewardBindingStorage {
	get(input: PluginStorageGetInput): Promise<PluginStorageEntry | null | undefined>;
	set(
		input: PluginStorageSetInput,
		options?: PluginStorageCommitOptions,
	): Promise<PluginStorageEntry>;
}
export type StewardStorageFactory =
	| { get(pluginId: string): StewardBindingStorage }
	| ((pluginId: string) => StewardBindingStorage);
export interface StewardSendAdapter {
	/** Must check signal immediately before durable commit, and preserve stewardProvenance. */
	sendMessage(
		input: Parameters<NarratorCommandAdapter["sendMessage"]>[0] & {
			stewardProvenance: StewardSource;
		},
	): Promise<{ messageId: string }>;
}
export type StewardAuditOutcome = "allowed" | "succeeded" | "denied" | "failed" | "cancelled";
export interface StewardAuditRecord {
	at: string;
	operation: "bind" | "readBinding" | "send" | "revalidateDelivery";
	userId?: string;
	pluginId?: string;
	contributionId?: string;
	requestId?: string;
	correlationId?: string;
	principalKind?: string;
	stewardNarratorId?: string;
	targetNarratorId?: string;
	outcome: StewardAuditOutcome;
	revision?: number;
	errorCode?: string;
	length: number;
}
export interface StewardNarratorServiceOptions {
	storageFactory: StewardStorageFactory;
	authorize?: (
		input: CapabilityAuthorizationRequest,
	) =>
		| void
		| boolean
		| { allowed: boolean }
		| Promise<void>
		| Promise<boolean | { allowed: boolean }>;
	capabilityBroker?: {
		authorize(input: CapabilityAuthorizationRequest): Promise<{ allowed: boolean }>;
	};
	lookupNarrator: (narratorId: string) => Promise<NarratorAclRow | null | undefined>;
	/** Resolve the authenticated user's current role from host-owned state, never from input. */
	resolveUserPrincipal: (userId: string) => Promise<NarratorPrincipal | null | undefined>;
	canWriteNarrator: (
		principal: NarratorPrincipal,
		narrator: NarratorAclRow,
	) => boolean | Promise<boolean>;
	sendAdapter: StewardSendAdapter;
	auditSink: (record: StewardAuditRecord) => void | Promise<void>;
	clock?: () => Date;
}

export class StewardNarratorError extends AppError {
	constructor(code: string, statusCode = 403) {
		super("Steward narrator operation was rejected", statusCode, code);
		this.name = "StewardNarratorError";
	}
}

// Shared by service instances: a rebind cannot race a send's final check in this host.
// CAS remains necessary for other writers/processes; ACL and storage are not one transaction.
const bindingMutex = new AsyncMutex();
const MAX_BIND_ATTEMPTS = 4;
interface OperationState {
	audit: StewardAuditRecord;
	host?: StewardHostContext;
	signal?: AbortSignal;
}

export class StewardNarratorService {
	private readonly clock: () => Date;

	constructor(private readonly options: StewardNarratorServiceOptions) {
		this.clock = options.clock ?? (() => new Date());
		if (!options.authorize && !options.capabilityBroker)
			throw new Error("Steward service requires capability authorization");
	}

	bindCurrentNarrator(host: StewardHostContext, signal?: AbortSignal): Promise<StewardBinding> {
		return this.execute("bind", host, signal, async (state, context, storage) => {
			const narratorId = this.callerNarrator(context);
			state.audit.stewardNarratorId = narratorId;
			if (context.invocation.source !== "ui") this.reject("BIND_REQUIRES_UI");
			for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
				await this.requireWrite(context, narratorId, state);
				await this.requireCapability(context, "storage.write_self", narratorId, state);
				const previous = await storage.get(this.bindingInput(context));
				this.checkLive(state);
				if (previous) this.validateEntryMetadata(previous, context);
				const revision = (previous?.revision ?? 0) + 1;
				if (!Number.isSafeInteger(revision)) this.reject("CORRUPT_BINDING");
				const binding: StewardBinding = {
					stewardNarratorId: narratorId,
					userId: this.userId(context),
					boundByNarratorId: narratorId,
					boundAt: this.clock().toISOString(),
					revision,
				};
				// Preflight audit is durable before any mutation; failure closes the operation.
				await this.audit({ ...state.audit, outcome: "allowed", revision });
				this.checkLive(state);
				await this.requireWrite(context, narratorId, state);
				await this.requireCapability(context, "storage.write_self", narratorId, state);
				try {
					const entry = await storage.set(
						{
							...this.bindingInput(context),
							value: binding,
							expectedRevision: previous?.revision ?? 0,
						},
						{
							signal: state.signal,
							beforeCommit: async () => {
								this.checkLive(state);
								await this.requireWrite(context, narratorId, state);
								await this.requireCapability(context, "storage.write_self", narratorId, state);
							},
							commitGuard: () => this.checkLive(state),
						},
					);
					const stored = this.parseBinding(entry, context);
					state.audit.revision = stored.revision;
					return stored;
				} catch (error) {
					if (!this.isRevisionConflict(error)) throw error;
					this.checkLive(state);
				}
			}
			this.reject("REVISION_CONFLICT", 409);
		});
	}

	readBinding(host: StewardHostContext): Promise<StewardBinding | null> {
		return this.execute("readBinding", host, undefined, async (state, context, storage) => {
			await this.requireCapability(context, "storage.read_self", undefined, state);
			const binding = await this.loadBinding(storage, context, state);
			if (binding) {
				state.audit.stewardNarratorId = binding.stewardNarratorId;
				state.audit.revision = binding.revision;
			}
			return binding;
		});
	}

	send(
		host: StewardHostContext,
		input: unknown,
		signal?: AbortSignal,
	): Promise<{ messageId: string }> {
		return this.execute("send", host, signal, async (state, context, storage) => {
			const parsed = sendInputSchema.safeParse(input);
			if (!parsed.success) this.reject("INVALID_INPUT", 400);
			const request = parsed.data;
			const targetNarratorId =
				"targetNarratorId" in request ? request.targetNarratorId : request.narratorId;
			state.audit.targetNarratorId = targetNarratorId;
			state.audit.length = request.message.length;
			if (!["internal", "command", "ui"].includes(context.invocation.source))
				this.reject("INVALID_SEND_SOURCE");
			const sourceId = this.callerNarrator(context);
			const binding = await this.requireCurrentBinding(storage, context, sourceId, state);
			state.audit.stewardNarratorId = sourceId;
			state.audit.revision = binding.revision;
			await this.validateSend(context, sourceId, targetNarratorId, state);
			await this.audit({ ...state.audit, outcome: "allowed" });
			this.checkLive(state);
			// Authorization may await policy/ACL I/O. Re-read everything after the preflight audit.
			await this.validateSend(context, sourceId, targetNarratorId, state);
			const finalBinding = await this.requireCurrentBinding(storage, context, sourceId, state);
			if (finalBinding.revision !== binding.revision) this.reject("BINDING_REPLACED", 409);
			this.checkLive(state);
			const stewardProvenance = Object.freeze({
				userId: this.userId(context),
				pluginId: context.plugin.pluginId,
				contributionId: STEWARD_SEND_TOOL_ID,
				requestId: context.requestId,
				correlationId: context.correlationId,
				stewardNarratorId: sourceId,
				targetNarratorId,
				bindingRevision: binding.revision,
			});
			if (!state.signal) this.reject("INVALID_CONTEXT", 400);
			return this.options.sendAdapter.sendMessage({
				narratorId: targetNarratorId,
				message: request.message,
				pluginId: context.plugin.pluginId,
				context,
				signal: state.signal,
				stewardProvenance,
			});
		});
	}

	/** Host-only durable inbox admission/recovery hook; never register as a plugin contribution.
	 * The adapter may invoke it while send holds the user mutex, so this deliberately does not
	 * acquire that mutex. It performs fresh fail-closed checks, not another delivery.
	 */
	revalidateDelivery(
		provenance: unknown,
		originalHostContext: StewardHostContext,
		signal?: AbortSignal,
	): Promise<void> {
		return this.execute(
			"revalidateDelivery",
			originalHostContext,
			signal,
			async (state, context, storage) => {
				const parsed = provenanceSchema.safeParse(provenance);
				if (!parsed.success) this.reject("INVALID_PROVENANCE", 400);
				const source = parsed.data;
				const caller = this.callerNarrator(context);
				if (
					source.userId !== this.userId(context) ||
					source.pluginId !== context.plugin.pluginId ||
					source.contributionId !== context.plugin.contributionId ||
					source.requestId !== context.requestId ||
					source.correlationId !== context.correlationId ||
					source.stewardNarratorId !== caller
				)
					this.reject("PROVENANCE_IDENTITY_MISMATCH");
				if (!["internal", "command", "ui"].includes(context.invocation.source))
					this.reject("INVALID_SEND_SOURCE");
				state.audit.stewardNarratorId = caller;
				state.audit.targetNarratorId = source.targetNarratorId;
				state.audit.revision = source.bindingRevision;
				await this.audit({ ...state.audit, outcome: "allowed" });
				this.checkLive(state);
				await this.validateSend(context, caller, source.targetNarratorId, state);
				const binding = await this.requireCurrentBinding(storage, context, caller, state);
				if (binding.revision !== source.bindingRevision) this.reject("BINDING_REPLACED", 409);
				this.checkLive(state);
			},
			false,
		);
	}

	private async execute<T>(
		operation: StewardAuditRecord["operation"],
		rawHost: StewardHostContext,
		externalSignal: AbortSignal | undefined,
		run: (
			state: OperationState,
			host: StewardHostContext,
			storage: StewardBindingStorage,
		) => Promise<T>,
		serialize = true,
	): Promise<T> {
		const state: OperationState = {
			audit: {
				at: this.clock().toISOString(),
				operation,
				outcome: "denied",
				length: 0,
			},
		};
		this.auditIdentity(state, rawHost);
		let cleanup: (() => void) | undefined;
		try {
			const context = this.validateHost(rawHost, operation);
			state.host = context;
			const controlled = this.operationSignal(context, externalSignal);
			state.signal = controlled.signal;
			cleanup = controlled.cleanup;
			this.checkLive(state);
			const perform = async () => {
				this.checkLive(state);
				const factory = this.options.storageFactory;
				const storage =
					typeof factory === "function"
						? factory(context.plugin.pluginId)
						: factory.get(context.plugin.pluginId);
				return run(state, context, storage);
			};
			const value = serialize
				? await bindingMutex.acquire(
						JSON.stringify([context.plugin.pluginId, context.invocation.userId]),
						perform,
					)
				: await perform();
			if (operation === "bind" || operation === "send") {
				try {
					await this.audit({ ...state.audit, outcome: "succeeded" });
				} catch {
					// The mutation already committed. Its durable preflight is preserved; reporting
					// failure here invites a retry and duplicate delivery. Do not mislabel it denied.
					logger.warn("Steward final audit unavailable after committed operation", {
						operation,
						requestId: state.audit.requestId,
						correlationId: state.audit.correlationId,
					});
				}
			} else if (operation !== "revalidateDelivery")
				await this.audit({ ...state.audit, outcome: "succeeded" });
			return value;
		} catch (error) {
			const normalized = this.normalizeError(error, state);
			await this.audit({
				...state.audit,
				outcome:
					normalized.code === "CANCELLED" || normalized.code === "TIMEOUT"
						? "cancelled"
						: normalized.statusCode >= 500
							? "failed"
							: "denied",
				errorCode: normalized.code,
			});
			throw normalized;
		} finally {
			cleanup?.();
		}
	}

	private validateHost(
		rawHost: StewardHostContext,
		operation: StewardAuditRecord["operation"],
	): StewardHostContext {
		if (!rawHost || typeof rawHost !== "object") this.reject("INVALID_CONTEXT", 400);
		// Support the host's optional narrator identity extension while validating all other fields
		// with its canonical strict schema. Never infer caller identity from scope alone.
		const { narratorId, ...invocation } = rawHost.invocation ?? {};
		const parsed = hostCallContextSchema.safeParse({ ...rawHost, invocation });
		if (!parsed.success) this.reject("INVALID_CONTEXT", 400);
		if (narratorId !== undefined && !identifierSchema.safeParse(narratorId).success)
			this.reject("INVALID_CONTEXT", 400);
		const host: StewardHostContext = {
			...parsed.data,
			invocation: { ...parsed.data.invocation, ...(narratorId ? { narratorId } : {}) },
		};
		if (host.invocation.kind !== "user") this.reject("USER_REQUIRED");
		if (!host.scope.userId || host.scope.userId !== host.invocation.userId)
			this.reject("USER_SCOPE_MISMATCH");
		if (host.invocation.narratorId || host.scope.narratorId) this.callerNarrator(host);
		const contribution =
			operation === "bind"
				? STEWARD_BIND_COMMAND_ID
				: operation === "send" || operation === "revalidateDelivery"
					? STEWARD_SEND_TOOL_ID
					: STEWARD_READ_BINDING_COMMAND_ID;
		if (host.plugin.pluginId !== STEWARD_PLUGIN_ID || host.plugin.contributionId !== contribution)
			this.reject("INVALID_CONTRIBUTION");
		Object.freeze(host.plugin);
		Object.freeze(host.invocation);
		Object.freeze(host.scope);
		return Object.freeze(host);
	}

	private userId(host: StewardHostContext): string {
		if (host.invocation.kind !== "user" || !host.invocation.userId) this.reject("USER_REQUIRED");
		return host.invocation.userId;
	}

	private callerNarrator(host: StewardHostContext): string {
		const id = host.invocation.narratorId;
		if (!id || !host.scope.narratorId || id !== host.scope.narratorId)
			this.reject("NARRATOR_SCOPE_MISMATCH");
		return id;
	}

	private bindingInput(host: StewardHostContext): PluginStorageGetInput {
		return { scope: { type: "user", id: this.userId(host) }, key: STEWARD_BINDING_KEY };
	}

	private validateEntryMetadata(entry: PluginStorageEntry, host: StewardHostContext): void {
		if (
			entry.pluginId !== host.plugin.pluginId ||
			entry.key !== STEWARD_BINDING_KEY ||
			entry.scope.type !== "user" ||
			entry.scope.id !== host.invocation.userId ||
			!Number.isSafeInteger(entry.revision) ||
			entry.revision < 1
		)
			this.reject("CORRUPT_BINDING");
	}

	private parseBinding(entry: PluginStorageEntry, host: StewardHostContext): StewardBinding {
		this.validateEntryMetadata(entry, host);
		const parsed = bindingSchema.safeParse(entry.value);
		if (
			!parsed.success ||
			parsed.data.userId !== host.invocation.userId ||
			parsed.data.revision !== entry.revision ||
			parsed.data.boundByNarratorId !== parsed.data.stewardNarratorId
		)
			this.reject("CORRUPT_BINDING");
		return Object.freeze(parsed.data);
	}

	private async loadBinding(
		storage: StewardBindingStorage,
		host: StewardHostContext,
		state: OperationState,
	): Promise<StewardBinding | null> {
		const entry = await storage.get(this.bindingInput(host));
		this.checkLive(state);
		return entry ? this.parseBinding(entry, host) : null;
	}

	private async requireCurrentBinding(
		storage: StewardBindingStorage,
		host: StewardHostContext,
		sourceId: string,
		state: OperationState,
	): Promise<StewardBinding> {
		const binding = await this.loadBinding(storage, host, state);
		if (!binding) this.reject("BINDING_NOT_FOUND", 404);
		if (binding.stewardNarratorId !== sourceId) this.reject("NOT_CURRENT_STEWARD");
		return binding;
	}

	private async requireWrite(
		host: StewardHostContext,
		id: string,
		state: OperationState,
	): Promise<void> {
		const principal = await this.options.resolveUserPrincipal(this.userId(host));
		this.checkLive(state);
		if (
			!principal ||
			principal.userId !== host.invocation.userId ||
			typeof principal.isAdmin !== "boolean"
		)
			this.reject("USER_AUTHORITY_DENIED");
		const row = await this.options.lookupNarrator(id);
		this.checkLive(state);
		if (!row || row.id !== id) this.reject("NARRATOR_NOT_FOUND", 404);
		const allowed = await this.options.canWriteNarrator(principal, row);
		this.checkLive(state);
		if (allowed !== true) this.reject("NARRATOR_WRITE_DENIED");
	}

	private async requireCapability(
		host: StewardHostContext,
		capability: string,
		id: string | undefined,
		state: OperationState,
	): Promise<void> {
		const input: CapabilityAuthorizationRequest = {
			context: host,
			capability,
			methodId: host.plugin.contributionId,
			scope: host.scope,
			...(id ? { resource: { type: "narrator" as const, id } } : {}),
		};
		const authorize = this.options.authorize;
		const broker = this.options.capabilityBroker;
		if (!authorize && !broker) this.reject("CAPABILITY_DENIED");
		const result = authorize ? await authorize(input) : await broker?.authorize(input);
		this.checkLive(state);
		if (result === false || (result && typeof result === "object" && result.allowed !== true))
			this.reject("CAPABILITY_DENIED");
	}

	private async validateSend(
		host: StewardHostContext,
		sourceId: string,
		targetId: string,
		state: OperationState,
	): Promise<void> {
		await this.requireWrite(host, sourceId, state);
		await this.requireWrite(host, targetId, state);
		await this.requireCapability(host, "command.narrator.send_message", targetId, state);
	}

	private operationSignal(
		host: StewardHostContext,
		external?: AbortSignal,
	): { signal: AbortSignal; cleanup: () => void } {
		const controller = new AbortController();
		const onAbort = () => controller.abort("CANCELLED");
		const onTimeout = () => controller.abort("TIMEOUT");
		if (external?.aborted) controller.abort("CANCELLED");
		else external?.addEventListener("abort", onAbort, { once: true });
		const remaining = Date.parse(host.deadlineAt) - this.clock().getTime();
		const timer =
			remaining > 0 ? setTimeout(onTimeout, Math.min(remaining, 2_147_483_647)) : undefined;
		if (remaining <= 0) onTimeout();
		return {
			signal: controller.signal,
			cleanup: () => {
				if (timer) clearTimeout(timer);
				external?.removeEventListener("abort", onAbort);
			},
		};
	}

	private checkLive(state: OperationState): void {
		if (state.host && Date.parse(state.host.deadlineAt) <= this.clock().getTime())
			this.reject("TIMEOUT", 408);
		if (state.signal?.aborted)
			this.reject(
				state.signal.reason === "TIMEOUT" ? "TIMEOUT" : "CANCELLED",
				state.signal.reason === "TIMEOUT" ? 408 : 499,
			);
	}

	private auditIdentity(state: OperationState, host: StewardHostContext): void {
		if (!host || typeof host !== "object") return;
		const identity = {
			userId: host.invocation?.userId,
			pluginId: host.plugin?.pluginId,
			contributionId: host.plugin?.contributionId,
			requestId: host.requestId,
			correlationId: host.correlationId,
			principalKind: host.invocation?.kind,
		};
		for (const [key, value] of Object.entries(identity)) {
			if (typeof value === "string" && identifierSchema.safeParse(value).success)
				Object.assign(state.audit, { [key]: value });
		}
	}

	private async audit(record: StewardAuditRecord): Promise<void> {
		try {
			await this.options.auditSink(Object.freeze({ ...record }));
		} catch {
			this.reject("AUDIT_UNAVAILABLE", 503);
		}
	}

	private normalizeError(error: unknown, state: OperationState): StewardNarratorError {
		if (error instanceof StewardNarratorError) return error;
		if (state.signal?.aborted) {
			const timeout =
				state.signal.reason === "TIMEOUT" ||
				(state.host && Date.parse(state.host.deadlineAt) <= this.clock().getTime());
			return new StewardNarratorError(timeout ? "TIMEOUT" : "CANCELLED", timeout ? 408 : 499);
		}
		if (this.isRevisionConflict(error)) return new StewardNarratorError("REVISION_CONFLICT", 409);
		// Never put arbitrary dependency messages/codes (possibly containing message text) into audit.
		return new StewardNarratorError("OPERATION_FAILED", 500);
	}

	private isRevisionConflict(error: unknown): boolean {
		return (
			!!error &&
			typeof error === "object" &&
			"reason" in error &&
			error.reason === "REVISION_CONFLICT"
		);
	}

	private reject(code: string, status = 403): never {
		throw new StewardNarratorError(code, status);
	}
}
