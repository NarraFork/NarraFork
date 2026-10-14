/**
 * Dispatches manifest command contributions to the plugin backend.
 *
 * ## The gap this fills
 *
 * A manifest may declare `commands[].handler: "server"`, and the schema has carried that
 * field since the contract was written — but nothing consumed it. `commands.execute` (the
 * method a plugin UI calls) resolves against the *host's* `CommandRegistry`, whose entries
 * are host functions, so a command declared by a plugin was simply unreachable. Any plugin
 * that shipped one had dead code.
 *
 * This registry is the missing half. It is shaped after `PluginToolRegistry`, which already
 * solves the same problem for tools: keep the descriptor host-side, resolve the runtime
 * lazily, and forward the call as a Host→Plugin RPC with a timeout and byte caps.
 *
 * ## Why `handler: "ui"` is registered but not dispatchable
 *
 * A `ui` command is handled inside the plugin's iframe; there is no backend to call. Such
 * contributions are still recorded so the host can tell "this command exists but belongs to
 * the UI" apart from "no such command", which produces a far more useful error than a bare
 * not-found.
 *
 * ## Secret writes
 *
 * A command result may carry `secretWrites`. This registry validates the *shape* and hands
 * the entries to the caller; it deliberately does not apply them. Applying them requires the
 * provider registry (to know which keys the plugin may write) and the vault, and keeping
 * that policy in one place — `plugin-command-secret-writes.ts` — means the limits cannot
 * drift between call sites.
 */

import { generateShortId } from "@server/lib/id";
import {
	isContributionId,
	isPluginId,
	type Manifest,
	safeParseManifest,
} from "@server/lib/plugins/manifest";
import type { Capability, InvocationScope } from "@server/lib/plugins/permissions";
import {
	COMMANDS_INVOKE_METHOD,
	type CommandConfigWrite,
	type CommandSecretWrite,
	commandsInvokeResultSchema,
	type JsonValue,
} from "@server/lib/plugins/protocol";
import {
	type HostCallContext,
	type InvocationPrincipal,
	invocationPrincipalSchema,
	invocationScopeSchema,
	type PluginPrincipal,
	pluginPrincipalSchema,
} from "./plugin-capability-broker";
import {
	type PluginHostHandlerRegistration,
	type PluginToolCapabilityBroker,
	validatePluginContributionInput,
} from "./plugin-tool-registry";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
/** Generous: a status command returns a credential list, which is kilobytes. */
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface PluginCommandRuntime {
	request(
		method: string,
		params?: unknown,
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<unknown>;
}

export interface PluginCommandDescriptor {
	pluginId: string;
	version: string;
	contributionId: string;
	fullId: string;
	title: string;
	description?: string;
	handler: "server" | "ui" | "host";
	inputSchema?: Record<string, unknown>;
}

export interface PluginCommandInvokeContext {
	requestId: string;
	correlationId?: string;
	deadlineAt?: string;
	idempotencyKey?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Trusted in-process context from the UI host; plugin identity is still re-derived. */
	hostContext?: HostCallContext;
	/** Authenticated host caller context; never copy these fields from plugin input. */
	invocation?: InvocationPrincipal;
	scope?: InvocationScope;
}

export interface PluginCommandHandlerContext {
	descriptor: PluginCommandDescriptor;
	host: HostCallContext;
	invocation: InvocationPrincipal;
	scope: InvocationScope;
	signal: AbortSignal;
	idempotencyKey?: string;
}

export type PluginCommandHostHandler = (
	input: JsonValue | undefined,
	context: PluginCommandHandlerContext,
) => unknown | Promise<unknown>;

export interface PluginCommandAuditEntry {
	pluginId: string;
	contributionId: string;
	requestId: string;
	correlationId?: string;
	runtimeId?: string;
	principalKind?: InvocationPrincipal["kind"];
	userId?: string;
	narratorId?: string;
	methodId: "commands.invoke";
	capability: string;
	outcome: "succeeded" | "failed" | "denied" | "timeout" | "cancelled" | "unavailable";
	durationMs: number;
	requestBytes: number;
	responseBytes: number;
	errorCode?: string;
}

export interface PluginCommandInvokeResult {
	output: JsonValue | undefined;
	/** Requested secret mutations, still unvalidated against the key whitelist. */
	secretWrites: CommandSecretWrite[];
	/** Requested non-secret config mutations, likewise still unvalidated. */
	configWrites: CommandConfigWrite[];
}

export class PluginCommandRegistryError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.name = "PluginCommandRegistryError";
		this.code = code;
		this.retryable = retryable;
	}
}

export interface PluginCommandRegistryOptions {
	capabilityBroker?: PluginToolCapabilityBroker;
	resolvePrincipal?: (
		pluginId: string,
		contributionId: string,
	) => PluginPrincipal | undefined | Promise<PluginPrincipal | undefined>;
	authorizationCapability?: Capability;
	capabilityForCommand?: (descriptor: PluginCommandDescriptor) => Capability;
	auditSink?:
		| ((entry: PluginCommandAuditEntry) => void | Promise<void>)
		| { write(entry: PluginCommandAuditEntry): void | Promise<void> };
	resolveRuntime?: (
		pluginId: string,
		contributionId: string,
	) => PluginCommandRuntime | undefined | Promise<PluginCommandRuntime | undefined>;
	defaultTimeoutMs?: number;
	maxTimeoutMs?: number;
	maxInputBytes?: number;
	maxOutputBytes?: number;
}

function byteLength(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
	} catch {
		throw new PluginCommandRegistryError("INVALID_PARAMS", "Command payload is not serializable");
	}
}

/** `<pluginId>/<contributionId>`, matching how tools namespace their ids. */
export function commandFullId(pluginId: string, contributionId: string): string {
	return `${pluginId}/${contributionId}`;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

interface HostCommandRegistration {
	handler: PluginCommandHostHandler;
	options: PluginHostHandlerRegistration;
}

export class PluginCommandRegistry {
	private readonly hostHandlers = new Map<string, HostCommandRegistration>();
	private readonly hostOptions: PluginCommandRegistryOptions;
	private readonly auditEntries: PluginCommandAuditEntry[] = [];
	private readonly entries = new Map<string, PluginCommandDescriptor>();
	private readonly resolveRuntime?: PluginCommandRegistryOptions["resolveRuntime"];
	private readonly defaultTimeoutMs: number;
	private readonly maxTimeoutMs: number;
	private readonly maxInputBytes: number;
	private readonly maxOutputBytes: number;

	constructor(options: PluginCommandRegistryOptions = {}) {
		this.hostOptions = { ...options };
		this.resolveRuntime = options.resolveRuntime;
		this.maxTimeoutMs = Math.max(1, Math.floor(options.maxTimeoutMs ?? MAX_TIMEOUT_MS));
		this.defaultTimeoutMs = Math.min(
			this.maxTimeoutMs,
			Math.max(1, Math.floor(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS)),
		);
		this.maxInputBytes = Math.max(1, Math.floor(options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES));
		this.maxOutputBytes = Math.max(
			1,
			Math.floor(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
		);
	}

	/** Register only from trusted host bootstrap, pinning the current installed package. */
	registerHostHandler(
		pluginId: string,
		contributionId: string,
		handler: PluginCommandHostHandler,
		options: PluginHostHandlerRegistration,
	): () => void {
		const principal = pluginPrincipalSchema.safeParse(options.principal);
		if (
			!isPluginId(pluginId) ||
			!isContributionId(contributionId) ||
			!principal.success ||
			principal.data.pluginId !== pluginId ||
			typeof options.isTrusted !== "function" ||
			typeof handler !== "function"
		) {
			throw new PluginCommandRegistryError("INVALID_PARAMS", "Invalid host handler registration");
		}
		const fullId = commandFullId(pluginId, contributionId);
		if (this.hostHandlers.has(fullId)) {
			throw new PluginCommandRegistryError(
				"CONFLICT",
				`Host handler is already registered: ${fullId}`,
			);
		}
		const registration: HostCommandRegistration = {
			handler,
			options: Object.freeze({
				...options,
				principal: deepFreeze({ ...principal.data, contributionId }),
			}),
		};
		this.hostHandlers.set(fullId, registration);
		return () => {
			if (this.hostHandlers.get(fullId) === registration) this.hostHandlers.delete(fullId);
		};
	}

	getAuditEntries(): PluginCommandAuditEntry[] {
		return this.auditEntries.map((entry) => ({ ...entry }));
	}

	/** Register every command a manifest contributes. Replaces any prior generation. */
	registerManifest(manifestInput: Manifest | unknown): PluginCommandDescriptor[] {
		const parsed = safeParseManifest(manifestInput);
		if (!parsed.success) {
			throw new PluginCommandRegistryError(
				"INVALID_PARAMS",
				"Plugin Manifest failed strict validation",
			);
		}
		const manifest = parsed.data;
		// Re-registration replaces: a manifest generation change must not leave a stale
		// command pointing at a contribution the new package no longer declares.
		this.removePlugin(manifest.pluginId);
		const descriptors: PluginCommandDescriptor[] = [];
		for (const command of manifest.contributes.commands) {
			const descriptor: PluginCommandDescriptor = {
				pluginId: manifest.pluginId,
				version: manifest.version,
				contributionId: command.id,
				fullId: commandFullId(manifest.pluginId, command.id),
				title: command.title,
				...(command.description ? { description: command.description } : {}),
				handler: command.handler,
				...(command.inputSchema ? { inputSchema: structuredClone(command.inputSchema) } : {}),
			};
			this.entries.set(descriptor.fullId, deepFreeze(descriptor));
			descriptors.push(descriptor);
		}
		return descriptors;
	}

	removePlugin(pluginId: string): number {
		let removed = 0;
		for (const [fullId, descriptor] of [...this.entries.entries()]) {
			if (descriptor.pluginId !== pluginId) continue;
			this.entries.delete(fullId);
			removed += 1;
		}
		return removed;
	}

	list(): PluginCommandDescriptor[] {
		return [...this.entries.values()].sort((left, right) =>
			left.fullId.localeCompare(right.fullId),
		);
	}

	/**
	 * Look a command up by full id, or by bare contribution id when the plugin is known.
	 *
	 * The UI passes a bare `commandId` (it only ever addresses its own plugin), while host
	 * callers use the namespaced form.
	 */
	find(commandId: string, pluginId?: string): PluginCommandDescriptor | undefined {
		const direct = this.entries.get(commandId);
		if (direct) return direct;
		if (!pluginId) return undefined;
		return this.entries.get(commandFullId(pluginId, commandId));
	}

	has(commandId: string, pluginId?: string): boolean {
		return this.find(commandId, pluginId) !== undefined;
	}

	/** Dispatch a `handler: "server"` command to the plugin process. */
	async invoke(
		commandId: string,
		pluginId: string,
		input: JsonValue | undefined,
		context: PluginCommandInvokeContext,
	): Promise<PluginCommandInvokeResult> {
		const descriptor = this.find(commandId, pluginId);
		if (!descriptor) {
			throw new PluginCommandRegistryError(
				"METHOD_NOT_FOUND",
				`Plugin command is not registered: ${commandId}`,
			);
		}
		if (descriptor.pluginId !== pluginId) {
			// Guards against a UI session addressing another plugin's command by full id.
			throw new PluginCommandRegistryError(
				"PERMISSION_DENIED",
				`Command belongs to another plugin: ${commandId}`,
			);
		}
		if (descriptor.handler === "host") return this.invokeHost(descriptor, input, context);
		if (descriptor.handler !== "server") {
			throw new PluginCommandRegistryError(
				"INVALID_STATE",
				`Command ${descriptor.fullId} is handled in the plugin UI and has no backend`,
			);
		}
		if (input !== undefined && byteLength(input) > this.maxInputBytes) {
			throw new PluginCommandRegistryError("OUTPUT_LIMIT", "Command input exceeds the byte limit");
		}

		const runtime = await this.resolveRuntime?.(descriptor.pluginId, descriptor.contributionId);
		if (!runtime) {
			throw new PluginCommandRegistryError(
				"HOST_UNAVAILABLE",
				"Plugin runtime is unavailable",
				true,
			);
		}

		const timeoutMs = Math.min(
			this.maxTimeoutMs,
			Math.max(1, Math.floor(context.timeoutMs ?? this.defaultTimeoutMs)),
		);
		const raw = await runtime.request(
			COMMANDS_INVOKE_METHOD,
			{
				contributionId: descriptor.contributionId,
				...(input === undefined ? {} : { input }),
				context: {
					requestId: context.requestId,
					...(context.correlationId ? { correlationId: context.correlationId } : {}),
					...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
					...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
				},
			},
			{ ...(context.signal ? { signal: context.signal } : {}), timeoutMs },
		);

		if (byteLength(raw) > this.maxOutputBytes) {
			throw new PluginCommandRegistryError("OUTPUT_LIMIT", "Command output exceeds the byte limit");
		}
		const result = commandsInvokeResultSchema.safeParse(raw ?? {});
		if (!result.success) {
			throw new PluginCommandRegistryError(
				"INVALID_RESPONSE",
				"Command result does not match the contract",
			);
		}
		return {
			output: result.data.output,
			secretWrites: result.data.secretWrites ?? [],
			configWrites: result.data.configWrites ?? [],
		};
	}

	private async invokeHost(
		descriptor: PluginCommandDescriptor,
		input: JsonValue | undefined,
		context: PluginCommandInvokeContext,
	): Promise<PluginCommandInvokeResult> {
		if (context.hostContext) {
			context = {
				...context,
				requestId: context.hostContext.requestId,
				correlationId: context.hostContext.correlationId,
				deadlineAt: context.hostContext.deadlineAt,
			};
		}
		const startedAt = Date.now();
		const registration = this.hostHandlers.get(descriptor.fullId);
		const capability =
			registration?.options.capability ??
			this.hostOptions.capabilityForCommand?.(descriptor) ??
			this.hostOptions.authorizationCapability ??
			"provider.use";
		const controller = new AbortController();
		const forwardAbort = (): void => controller.abort(context.signal?.reason ?? "caller-cancelled");
		if (context.signal?.aborted) forwardAbort();
		else context.signal?.addEventListener("abort", forwardAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let host: HostCallContext | undefined;
		let requestBytes = 0;
		let responseBytes = 0;
		const parsedInvocation = invocationPrincipalSchema.safeParse(
			context.hostContext?.invocation ??
				context.invocation ?? { kind: "plugin_background", source: "command" },
		);
		let outcome: PluginCommandAuditEntry["outcome"] = "succeeded";
		let code: string | undefined;
		try {
			const timeoutMs = Math.min(
				this.maxTimeoutMs,
				Math.max(1, Math.floor(context.timeoutMs ?? this.defaultTimeoutMs)),
			);
			const requestedDeadline = context.deadlineAt ? Date.parse(context.deadlineAt) : Infinity;
			if (Number.isNaN(requestedDeadline) || requestedDeadline <= Date.now()) {
				throw new PluginCommandRegistryError("TIMEOUT", "Command deadline has expired", true);
			}
			const deadlineAt = new Date(
				Math.min(Date.now() + timeoutMs, requestedDeadline),
			).toISOString();
			const execution = Promise.resolve().then(async () => {
				if (controller.signal.aborted)
					throw new DOMException("Command was cancelled", "AbortError");
				if (!registration)
					throw new PluginCommandRegistryError(
						"HOST_UNAVAILABLE",
						"Host command handler is not registered",
					);
				if (!parsedInvocation.success)
					throw new PluginCommandRegistryError(
						"CONTEXT_UNAVAILABLE",
						"Invalid command invocation principal",
					);
				if (parsedInvocation.data.kind !== "user")
					throw new PluginCommandRegistryError(
						"PERMISSION_DENIED",
						"Host command requires a user invocation",
					);
				const parsedScope = invocationScopeSchema.safeParse(
					context.hostContext?.scope ?? context.scope ?? {},
				);
				if (!parsedScope.success)
					throw new PluginCommandRegistryError(
						"CONTEXT_UNAVAILABLE",
						"Invalid command invocation scope",
					);
				if (
					parsedScope.data.userId !== undefined &&
					parsedScope.data.userId !== parsedInvocation.data.userId
				) {
					throw new PluginCommandRegistryError(
						"PERMISSION_DENIED",
						"Command user scope is inconsistent",
					);
				}
				if (
					parsedInvocation.data.narratorId !== undefined &&
					parsedInvocation.data.narratorId !== parsedScope.data.narratorId
				) {
					throw new PluginCommandRegistryError(
						"PERMISSION_DENIED",
						"Command narrator scope is inconsistent",
					);
				}
				requestBytes = input === undefined ? 0 : byteLength(input);
				if (requestBytes > this.maxInputBytes)
					throw new PluginCommandRegistryError(
						"OUTPUT_LIMIT",
						"Command input exceeds the byte limit",
					);
				const parsedInput =
					input === undefined && !descriptor.inputSchema
						? undefined
						: validatePluginContributionInput(input ?? {}, descriptor.inputSchema ?? {});
				if (!(await registration.options.isTrusted()))
					throw new PluginCommandRegistryError(
						"PERMISSION_DENIED",
						"Installed host contribution is not trusted",
					);
				const resolved = registration.options.resolvePrincipal
					? await registration.options.resolvePrincipal()
					: await this.hostOptions.resolvePrincipal?.(
							descriptor.pluginId,
							descriptor.contributionId,
						);
				const principal = pluginPrincipalSchema.safeParse(resolved);
				if (!principal.success)
					throw new PluginCommandRegistryError(
						"CONTEXT_UNAVAILABLE",
						"Host command installation principal is unavailable",
					);
				const pinned = registration.options.principal;
				if (
					principal.data.pluginId !== descriptor.pluginId ||
					principal.data.packageVersion !== descriptor.version ||
					principal.data.packageVersion !== pinned.packageVersion ||
					(!registration.options.followInstallation &&
						principal.data.installationId !== pinned.installationId) ||
					principal.data.runtimeId !== pinned.runtimeId ||
					(!registration.options.followInstallation &&
						principal.data.runtimeGeneration !== pinned.runtimeGeneration) ||
					(principal.data.contributionId !== undefined &&
						principal.data.contributionId !== descriptor.contributionId)
				)
					throw new PluginCommandRegistryError(
						"PERMISSION_DENIED",
						"Host contribution installation identity changed",
					);
				const broker = this.hostOptions.capabilityBroker;
				if (!broker)
					throw new PluginCommandRegistryError(
						"CONTEXT_UNAVAILABLE",
						"Host command capability broker is unavailable",
					);
				const contextInput = {
					plugin: { ...principal.data, contributionId: descriptor.contributionId },
					invocation: parsedInvocation.data,
					scope: parsedScope.data,
					requestId: context.requestId,
					correlationId: context.correlationId ?? `command_corr_${generateShortId(16)}`,
					deadlineAt,
				};
				host = deepFreeze(structuredClone(broker.withCallContext?.(contextInput) ?? contextInput));
				const authorization = await broker.authorize({
					context: host,
					capability,
					methodId: `commands.invoke:${descriptor.fullId}`,
					scope: host.scope,
					requestBytes,
					responseBytes: 0,
				});
				if (!authorization.allowed)
					throw new PluginCommandRegistryError(
						authorization.error?.code ?? "PERMISSION_DENIED",
						"Capability broker denied the host command",
					);
				if (!(await registration.options.isTrusted()))
					throw new PluginCommandRegistryError(
						"PERMISSION_DENIED",
						"Host package trust changed during authorization",
					);
				const current = pluginPrincipalSchema.safeParse(
					registration.options.resolvePrincipal
						? await registration.options.resolvePrincipal()
						: await this.hostOptions.resolvePrincipal?.(
								descriptor.pluginId,
								descriptor.contributionId,
							),
				);
				if (
					!current.success ||
					current.data.pluginId !== host.plugin.pluginId ||
					current.data.packageVersion !== host.plugin.packageVersion ||
					current.data.installationId !== host.plugin.installationId ||
					current.data.runtimeId !== host.plugin.runtimeId ||
					current.data.runtimeGeneration !== host.plugin.runtimeGeneration ||
					(current.data.contributionId !== undefined &&
						current.data.contributionId !== descriptor.contributionId)
				) {
					throw new PluginCommandRegistryError(
						"PERMISSION_DENIED",
						"Host installation changed during authorization",
					);
				}
				if (controller.signal.aborted)
					throw new DOMException("Command was cancelled", "AbortError");
				if (
					this.hostHandlers.get(descriptor.fullId) !== registration ||
					this.entries.get(descriptor.fullId) !== descriptor
				) {
					throw new PluginCommandRegistryError(
						"HOST_UNAVAILABLE",
						"Host command binding changed during authorization",
					);
				}
				const raw = await registration.handler(parsedInput, {
					descriptor,
					host,
					invocation: host.invocation,
					scope: host.scope,
					signal: controller.signal,
					idempotencyKey: context.idempotencyKey,
				});
				responseBytes = byteLength(raw);
				if (responseBytes > this.maxOutputBytes)
					throw new PluginCommandRegistryError(
						"OUTPUT_LIMIT",
						"Command output exceeds the byte limit",
					);
				const result = commandsInvokeResultSchema.safeParse(raw ?? {});
				if (!result.success)
					throw new PluginCommandRegistryError(
						"INVALID_RESPONSE",
						"Command result does not match the contract",
					);
				return {
					output: result.data.output,
					secretWrites: result.data.secretWrites ?? [],
					configWrites: result.data.configWrites ?? [],
				};
			});
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => {
						reject(
							new PluginCommandRegistryError("TIMEOUT", "Host command execution timed out", true),
						);
						controller.abort("command-timeout");
					},
					Math.max(1, Date.parse(deadlineAt) - Date.now()),
				);
			});
			const cancelled = new Promise<never>((_, reject) => {
				if (controller.signal.aborted)
					reject(new DOMException("Command was cancelled", "AbortError"));
				else
					controller.signal.addEventListener(
						"abort",
						() => reject(new DOMException("Command was cancelled", "AbortError")),
						{ once: true },
					);
			});
			return await Promise.race([execution, timeout, cancelled]);
		} catch (error) {
			code =
				error instanceof Error && error.name === "AbortError"
					? "CANCELLED"
					: error && typeof error === "object" && "code" in error
						? String(error.code)
						: "INTERNAL_ERROR";
			outcome =
				code === "TIMEOUT"
					? "timeout"
					: code === "CANCELLED"
						? "cancelled"
						: code === "PERMISSION_DENIED"
							? "denied"
							: code === "HOST_UNAVAILABLE" || code === "CONTEXT_UNAVAILABLE"
								? "unavailable"
								: "failed";
			if (error instanceof PluginCommandRegistryError || error instanceof DOMException) throw error;
			throw new PluginCommandRegistryError(
				code,
				error instanceof Error ? error.message : "Host command failed",
			);
		} finally {
			if (timer) clearTimeout(timer);
			context.signal?.removeEventListener("abort", forwardAbort);
			const audit: PluginCommandAuditEntry = {
				pluginId: descriptor.pluginId,
				contributionId: descriptor.contributionId,
				requestId: context.requestId,
				correlationId: host?.correlationId ?? context.correlationId,
				runtimeId: host?.plugin.runtimeId,
				principalKind: parsedInvocation.success ? parsedInvocation.data.kind : undefined,
				userId: parsedInvocation.success ? parsedInvocation.data.userId : undefined,
				narratorId: host?.scope.narratorId,
				methodId: "commands.invoke",
				capability,
				outcome,
				durationMs: Math.max(0, Date.now() - startedAt),
				requestBytes,
				responseBytes,
				errorCode: code,
			};
			this.auditEntries.push(audit);
			if (this.auditEntries.length > 1_000) this.auditEntries.shift();
			try {
				const sink = this.hostOptions.auditSink;
				if (typeof sink === "function") await sink({ ...audit });
				else await sink?.write({ ...audit });
			} catch {
				/* Audit failures cannot change the already determined command result. */
			}
		}
	}
}
