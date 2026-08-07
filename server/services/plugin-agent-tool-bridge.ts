import { normalizeToolName, sanitizeToolNameSegment } from "@server/lib/agent/tool-name";
import {
	toolRegistry as defaultAgentToolRegistry,
	type ToolProvider,
	type ToolRegistry,
} from "@server/lib/agent/tool-registry";
import type { ToolContext, ToolDefinition } from "@server/lib/agent/types";
import { generateShortId } from "@server/lib/id";
import { z } from "zod/v4";
import type { InvocationPrincipal, InvocationScope } from "./plugin-capability-broker";
import type {
	PluginToolDescriptor,
	PluginToolInvocationOptions,
	PluginToolRegistry,
	PluginToolResult,
} from "./plugin-tool-registry";
import { PluginToolRegistryError } from "./plugin-tool-registry";

const DEFAULT_PROVIDER_NAME = "plugins";
const MAX_ERROR_MESSAGE = 1_000;

/**
 * The public Agent-facing name for a plugin tool. The mapping is intentionally kept in one place;
 * callers must use PluginAgentToolBridge.fullIdForCanonical() rather than reconstructing a full ID.
 *
 * Plugin IDs are reverse-DNS (`com.example.duo`), so the dots must be folded away: every provider
 * constrains function names to `^[a-zA-Z0-9_-]+$` and rejects the entire request — not just the
 * offending entry — when one tool violates it.
 */
export function canonicalPluginToolName(pluginId: string, contributionId: string): string {
	return normalizeToolName(
		`plugin__${sanitizeToolNameSegment(pluginId)}__${sanitizeToolNameSegment(contributionId)}`,
	);
}

/** Backwards-compatible alias used by callers that spell the operation as a conversion. */
export const pluginToolCanonicalName = canonicalPluginToolName;

function clone<T>(value: T): T {
	return structuredClone(value);
}

function validIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function boundedMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, MAX_ERROR_MESSAGE) || "Plugin tool invocation failed";
}

function errorCode(error: unknown): string | undefined {
	if (error instanceof PluginToolRegistryError) return error.code;
	if (error && typeof error === "object" && "code" in error) return String(error.code);
	return undefined;
}

function invocationFromContext(context: ToolContext): InvocationPrincipal {
	if (validIdentifier(context.userId)) {
		return {
			kind: "user",
			userId: context.userId,
			userRole: "user",
			source: "command",
		};
	}
	return { kind: "system", source: "internal" };
}

function scopeFromContext(context: ToolContext): InvocationScope {
	const scope: InvocationScope = {};
	if (validIdentifier(context.userId)) scope.userId = context.userId;
	if (validIdentifier(context.projectId)) scope.projectId = context.projectId;
	if (validIdentifier(context.chapterId)) scope.chapterId = context.chapterId;
	if (validIdentifier(context.narratorId)) scope.narratorId = context.narratorId;
	return scope;
}

function targetFromContext(context: ToolContext): PluginToolInvocationOptions["target"] {
	const target = context.executionTarget;
	if (!target) return undefined;
	if (target.backendKind === "remote") {
		return {
			kind: "device",
			deviceId: target.deviceId,
			backendKind: "remote",
		};
	}
	return { kind: "local", backendKind: "local" };
}

export interface PluginToolActivationOptions {
	reason: string;
	automatic: true;
}

export type PluginToolActivationHandler = (
	pluginId: string,
	options: PluginToolActivationOptions,
) => Promise<unknown>;

export interface PluginAgentToolBridgeOptions {
	pluginToolRegistry: PluginToolRegistry;
	agentToolRegistry?: ToolRegistry;
	providerName?: string;
	activatePlugin?: PluginToolActivationHandler;
	isRuntimeActive?: (pluginId: string) => boolean | Promise<boolean>;
	autoRegister?: boolean;
}

export interface PluginAgentToolBinding {
	pluginId: string;
	contributionId: string;
	fullId: string;
	canonicalName: string;
	descriptor: PluginToolDescriptor;
}

export class PluginAgentToolBridgeError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.name = "PluginAgentToolBridgeError";
		this.code = code;
		this.retryable = retryable;
	}
}

/**
 * Adapts the host-owned PluginToolRegistry to the core Agent ToolRegistry. The bridge owns the
 * canonical-name map and replaces one provider atomically, so refreshes never leave duplicate or
 * stale provider entries behind.
 */
export class PluginAgentToolBridge {
	readonly pluginToolRegistry: PluginToolRegistry;
	readonly agentToolRegistry: ToolRegistry;
	readonly providerName: string;

	private readonly provider: ToolProvider;
	private bindings = new Map<string, PluginAgentToolBinding>();
	private canonicalToFullId = new Map<string, string>();
	private activationHandler?: PluginToolActivationHandler;
	private runtimeActiveResolver?: PluginAgentToolBridgeOptions["isRuntimeActive"];
	private readonly activationFlights = new Map<string, Promise<unknown>>();
	private attached = false;

	constructor(options: PluginAgentToolBridgeOptions) {
		this.pluginToolRegistry = options.pluginToolRegistry;
		this.agentToolRegistry = options.agentToolRegistry ?? defaultAgentToolRegistry;
		this.providerName = options.providerName ?? DEFAULT_PROVIDER_NAME;
		this.activationHandler = options.activatePlugin;
		this.runtimeActiveResolver = options.isRuntimeActive;
		this.provider = {
			name: this.providerName,
			tools: () => this.materializeTools(),
		};
		if (options.autoRegister !== false) this.attach();
	}

	setActivationHandler(handler: PluginToolActivationHandler | undefined): void {
		this.activationHandler = handler;
	}

	setRuntimeActiveResolver(
		resolver: PluginAgentToolBridgeOptions["isRuntimeActive"] | undefined,
	): void {
		this.runtimeActiveResolver = resolver;
	}

	attach(): void {
		if (this.attached) return;
		this.agentToolRegistry.registerProvider(this.provider);
		this.attached = true;
	}

	dispose(): void {
		if (!this.attached) return;
		this.agentToolRegistry.unregisterProvider(this.providerName);
		this.attached = false;
		this.bindings = new Map();
		this.canonicalToFullId = new Map();
	}

	/** Rebuild the single mapping table from the current host-owned registry. */
	sync(): PluginAgentToolBinding[] {
		const nextBindings = new Map<string, PluginAgentToolBinding>();
		const nextCanonicalToFullId = new Map<string, string>();
		for (const descriptor of this.pluginToolRegistry.list()) {
			// UI tools are intentionally not advertised to the backend Agent. Their UI host path is
			// separate and exposing a permanently unavailable function would be misleading.
			if (descriptor.execution !== "server") continue;
			const canonicalName = canonicalPluginToolName(descriptor.pluginId, descriptor.contributionId);
			const previous = nextCanonicalToFullId.get(canonicalName);
			if (previous && previous !== descriptor.fullId) {
				throw new PluginAgentToolBridgeError(
					"CANONICAL_NAME_CONFLICT",
					`Plugin tool canonical name is ambiguous: ${canonicalName}`,
				);
			}
			nextCanonicalToFullId.set(canonicalName, descriptor.fullId);
			nextBindings.set(descriptor.fullId, {
				pluginId: descriptor.pluginId,
				contributionId: descriptor.contributionId,
				fullId: descriptor.fullId,
				canonicalName,
				descriptor,
			});
		}

		// The maps are swapped before the core registry is invalidated. The provider's lazy tools()
		// closure therefore observes either the old complete map or the new complete map, never a
		// partially updated set.
		this.bindings = nextBindings;
		this.canonicalToFullId = nextCanonicalToFullId;
		this.agentToolRegistry.registerProvider(this.provider);
		this.attached = true;
		return this.listBindings();
	}

	refresh(): PluginAgentToolBinding[] {
		return this.sync();
	}

	listBindings(): PluginAgentToolBinding[] {
		return [...this.bindings.values()]
			.sort((left, right) => left.canonicalName.localeCompare(right.canonicalName))
			.map((binding) => ({ ...binding, descriptor: clone(binding.descriptor) }));
	}

	list(): PluginAgentToolBinding[] {
		return this.listBindings();
	}

	getByFullId(fullId: string): PluginAgentToolBinding | undefined {
		const binding = this.bindings.get(fullId);
		return binding ? { ...binding, descriptor: clone(binding.descriptor) } : undefined;
	}

	getByCanonicalName(canonicalName: string): PluginAgentToolBinding | undefined {
		const fullId = this.canonicalToFullId.get(canonicalName);
		return fullId ? this.getByFullId(fullId) : undefined;
	}

	canonicalNameForFullId(fullId: string): string | undefined {
		return this.bindings.get(fullId)?.canonicalName;
	}

	fullIdForCanonical(canonicalName: string): string | undefined {
		return this.canonicalToFullId.get(canonicalName);
	}

	async invokeCanonical(
		canonicalName: string,
		input: Record<string, unknown>,
		context: ToolContext,
	): Promise<PluginToolResult> {
		const fullId = this.canonicalToFullId.get(canonicalName);
		if (!fullId) {
			throw new PluginAgentToolBridgeError(
				"NOT_FOUND",
				`Unknown plugin Agent tool: ${canonicalName}`,
			);
		}
		return this.invokeFullId(fullId, input, context);
	}

	async invokeFullId(
		fullId: string,
		input: Record<string, unknown>,
		context: ToolContext,
	): Promise<PluginToolResult> {
		const binding = this.bindings.get(fullId);
		if (!binding) {
			throw new PluginAgentToolBridgeError("NOT_FOUND", `Unknown plugin Agent tool: ${fullId}`);
		}
		const descriptor = this.pluginToolRegistry.get(fullId);
		if (!descriptor) {
			throw new PluginAgentToolBridgeError("NOT_FOUND", `Unknown plugin tool: ${fullId}`);
		}
		if (descriptor.status !== "available") {
			throw new PluginAgentToolBridgeError(
				descriptor.unavailableReason?.includes("disabled") ? "PLUGIN_DISABLED" : "HOST_UNAVAILABLE",
				descriptor.unavailableReason ?? "Plugin tool is unavailable",
				true,
			);
		}

		await this.ensureActivated(binding, context.signal);
		const invocation = invocationFromContext(context);
		const scope = scopeFromContext(context);
		const requestId = validIdentifier(context.currentToolUseId)
			? context.currentToolUseId
			: `agent_tool_${generateShortId(16)}`;
		const options: PluginToolInvocationOptions = {
			invocation,
			scope,
			target: targetFromContext(context),
			permission: { behavior: "allow" },
			signal: context.signal,
			requestId,
			correlationId: `agent_corr_${generateShortId(16)}`,
		};
		return this.pluginToolRegistry.invoke(fullId, input, options);
	}

	private async ensureActivated(
		binding: PluginAgentToolBinding,
		signal: AbortSignal,
	): Promise<void> {
		if (signal.aborted) throw new DOMException("Tool activation was cancelled", "AbortError");
		if (this.runtimeActiveResolver && (await this.runtimeActiveResolver(binding.pluginId))) return;
		if (!this.activationHandler) return;
		const existing = this.activationFlights.get(binding.pluginId);
		if (existing) {
			await existing;
			return;
		}
		const flight = this.activationHandler(binding.pluginId, {
			reason: `onTool:${binding.fullId}`,
			automatic: true,
		});
		this.activationFlights.set(binding.pluginId, flight);
		try {
			await flight;
		} finally {
			if (this.activationFlights.get(binding.pluginId) === flight) {
				this.activationFlights.delete(binding.pluginId);
			}
		}
	}

	private materializeTools(): ToolDefinition[] {
		return this.listBindings().map((binding) => {
			const name = binding.canonicalName;
			return {
				name,
				description: binding.descriptor.description
					? `[Plugin: ${binding.descriptor.title}] ${binding.descriptor.description}`
					: `[Plugin: ${binding.descriptor.title}]`,
				parameters: zodObjectFallback(),
				rawJsonSchema: clone(binding.descriptor.inputSchema) as Record<string, unknown>,
				isAvailable: () => this.pluginToolRegistry.get(binding.fullId)?.status === "available",
				metadata: { readOnly: false },
				execute: async (args, context) => {
					try {
						return await this.invokeFullId(binding.fullId, args, context);
					} catch (error) {
						const code = errorCode(error);
						return {
							output: `${code ? `${code}: ` : ""}${boundedMessage(error)}`,
							isError: true,
							...(code ? { metadata: { code } } : {}),
						};
					}
				},
			};
		});
	}
}

/**
 * Keep the Agent executor's local Zod check deliberately shallow. The authoritative strict JSON
 * Schema validation remains in PluginToolRegistry, which is the Host-owned execution boundary.
 */
function zodObjectFallback() {
	return z.record(z.string(), z.unknown());
}
