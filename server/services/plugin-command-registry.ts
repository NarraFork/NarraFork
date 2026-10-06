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

import { type Manifest, safeParseManifest } from "@server/lib/plugins/manifest";
import {
	COMMANDS_INVOKE_METHOD,
	type CommandConfigWrite,
	type CommandSecretWrite,
	commandsInvokeResultSchema,
	type JsonValue,
} from "@server/lib/plugins/protocol";

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
	handler: "server" | "ui";
}

export interface PluginCommandInvokeContext {
	requestId: string;
	correlationId?: string;
	deadlineAt?: string;
	idempotencyKey?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
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

export class PluginCommandRegistry {
	private readonly entries = new Map<string, PluginCommandDescriptor>();
	private readonly resolveRuntime?: PluginCommandRegistryOptions["resolveRuntime"];
	private readonly defaultTimeoutMs: number;
	private readonly maxTimeoutMs: number;
	private readonly maxInputBytes: number;
	private readonly maxOutputBytes: number;

	constructor(options: PluginCommandRegistryOptions = {}) {
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
			};
			this.entries.set(descriptor.fullId, descriptor);
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
}
