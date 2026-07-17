import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@server/lib/settings/types";
import {
	type CapabilityBroker,
	capabilityBroker as defaultCapabilityBroker,
	type HostCallContext,
	type InvocationScope,
} from "./plugin-capability-broker";
import type { PluginContributionRegistry } from "./plugin-contribution-registry";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const SECRET_KEY_PATTERN =
	/(secret|token|password|passwd|credential|private[_-]?key|api[_-]?key|auth|cookie)/i;
const SECRET_VALUE_PATTERN = /(secret|token|password|private key|BEGIN [A-Z ]+ KEY)/i;
const SHELL_CHARACTER_PATTERN = /[;&|`$<>]/;

export const MCP_BRIDGE_CAPABILITY = "process.spawn.allowlist" as const;
export const MCP_SERVER_CAPABILITY = "process.spawn.allowlist" as const;
export const MCP_NETWORK_CAPABILITY = "network.egress.allowlist" as const;

export type JsonSchema = Record<string, unknown>;

export interface PluginMcpBridgeResult {
	content: Array<{
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
		resource?: unknown;
	}>;
	isError?: boolean;
}

export interface PluginMcpBridgeTool {
	pluginId: string;
	contributionId: string;
	fullId?: string;
	title: string;
	description?: string;
	inputSchema: JsonSchema;
	capability?: string;
	scope?: InvocationScope;
	timeoutMs?: number;
	maxOutputBytes?: number;
	available?: boolean | (() => boolean | Promise<boolean>);
	handler: (
		args: Record<string, unknown>,
		signal: AbortSignal,
		context: HostCallContext,
	) => Promise<PluginMcpBridgeResult>;
}

export interface PluginMcpBridgeDescriptor extends Tool {
	name: string;
	description: string;
	inputSchema: Tool["inputSchema"];
	pluginId: string;
	contributionId: string;
	fullId: string;
	available: boolean;
	unavailableReason?: string;
}

export interface PluginMcpServerContribution {
	pluginId: string;
	contributionId: string;
	name: string;
	transport: McpServerConfig["transport"];
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	defaultBehavior?: McpServerConfig["defaultBehavior"];
	toolPermissions?: McpServerConfig["toolPermissions"];
	enabled?: boolean;
}

export interface PluginMcpServerPolicy {
	allowedCommands?: readonly string[];
	allowedArgs?: readonly string[];
	allowedCwds?: readonly string[];
	allowedEnvKeys?: readonly string[];
	allowedUrls?: readonly string[];
	allowedHeaderKeys?: readonly string[];
	allowRemoteUrls?: boolean;
}

export interface PluginMcpServerConfigSummary {
	pluginId: string;
	contributionId: string;
	serverId: string;
	name: string;
	transport: McpServerConfig["transport"];
	enabled: boolean;
	redactedEnvKeys: string[];
	redactedHeaderKeys: string[];
}

export interface PluginMcpServerConfigResult {
	config: McpServerConfig;
	summary: PluginMcpServerConfigSummary;
}

export interface PluginMcpAdapterOptions {
	registry?: PluginContributionRegistry;
	capabilityBroker?: Pick<CapabilityBroker, "require">;
	serverPolicy?: PluginMcpServerPolicy;
	onToolsChanged?: () => void | Promise<void>;
}

export type PluginMcpAdapterErrorCode =
	| "INVALID_CONTRIBUTION"
	| "NOT_FOUND"
	| "UNAVAILABLE"
	| "PLUGIN_DISABLED"
	| "PERMISSION_DENIED"
	| "TIMEOUT"
	| "CANCELLED"
	| "OUTPUT_LIMIT"
	| "CONFIG_DENIED";

export class PluginMcpAdapterError extends Error {
	readonly code: PluginMcpAdapterErrorCode;
	readonly pluginId?: string;
	readonly contributionId?: string;

	constructor(
		code: PluginMcpAdapterErrorCode,
		message: string,
		metadata: { pluginId?: string; contributionId?: string } = {},
	) {
		super(message);
		this.name = "PluginMcpAdapterError";
		this.code = code;
		this.pluginId = metadata.pluginId;
		this.contributionId = metadata.contributionId;
	}
}

interface BridgeRecord {
	tool: PluginMcpBridgeTool;
	descriptor: PluginMcpBridgeDescriptor;
	available: boolean;
	unavailableReason?: string;
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(value ?? fallback)));
}

function safeName(value: string): string {
	const normalized = value.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return normalized || "unknown";
}

function bridgeName(pluginId: string, contributionId: string): string {
	return `plugin__${safeName(pluginId)}__${safeName(contributionId)}`;
}

function hasUnsafeText(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint === 0x7f) return true;
	}
	return SHELL_CHARACTER_PATTERN.test(value);
}

function isAllowedValue(value: string, allowlist: readonly string[] | undefined): boolean {
	return !!allowlist?.some((allowed) => allowed === value);
}

function isPathAllowed(value: string, allowlist: readonly string[] | undefined): boolean {
	if (!allowlist?.length) return false;
	return allowlist.some((allowed) => {
		if (value === allowed) return true;
		const prefix = allowed.endsWith("/") ? allowed : `${allowed}/`;
		return value.startsWith(prefix) && !value.includes("..") && !value.includes("\\..\\");
	});
}

function assertKnownKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowedKeys.includes(key)) {
			throw new PluginMcpAdapterError("CONFIG_DENIED", `Unknown MCP server field: ${key}`);
		}
	}
}

function assertSafeMap(
	values: Record<string, string> | undefined,
	allowedKeys: readonly string[] | undefined,
	kind: "env" | "header",
): void {
	for (const [key, value] of Object.entries(values ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) || hasUnsafeText(key) || hasUnsafeText(value)) {
			throw new PluginMcpAdapterError("CONFIG_DENIED", `Unsafe ${kind} key or value: ${key}`);
		}
		if (SECRET_KEY_PATTERN.test(key) || SECRET_VALUE_PATTERN.test(value)) {
			throw new PluginMcpAdapterError(
				"CONFIG_DENIED",
				`Secret-like ${kind} value is not allowed: ${key}`,
			);
		}
		if (!isAllowedValue(key, allowedKeys)) {
			throw new PluginMcpAdapterError("CONFIG_DENIED", `${kind} key is not host-approved: ${key}`);
		}
	}
}

function cloneSchema(schema: JsonSchema): JsonSchema {
	return structuredClone(schema);
}

function normalizeSchema(schema: JsonSchema): Tool["inputSchema"] {
	const copy = cloneSchema(schema);
	if (copy.type !== "object") copy.type = "object";
	if (!copy.properties || typeof copy.properties !== "object") copy.properties = {};
	return copy as Tool["inputSchema"];
}

function unavailableError(record: BridgeRecord): PluginMcpAdapterError {
	return new PluginMcpAdapterError(
		record.unavailableReason === "plugin disabled" ? "PLUGIN_DISABLED" : "UNAVAILABLE",
		record.unavailableReason ?? "Plugin MCP contribution is unavailable",
		{ pluginId: record.tool.pluginId, contributionId: record.tool.contributionId },
	);
}

export class PluginMcpAdapter {
	private readonly registry?: PluginContributionRegistry;
	private readonly capabilityBroker: Pick<CapabilityBroker, "require">;
	private readonly serverPolicy: PluginMcpServerPolicy;
	private readonly onToolsChanged?: () => void | Promise<void>;
	private readonly bridges = new Map<string, BridgeRecord>();
	private readonly serverConfigs = new Map<string, PluginMcpServerConfigResult>();

	constructor(options: PluginMcpAdapterOptions = {}) {
		this.registry = options.registry;
		this.capabilityBroker = options.capabilityBroker ?? defaultCapabilityBroker;
		this.serverPolicy = options.serverPolicy ?? {};
		this.onToolsChanged = options.onToolsChanged;
	}

	registerBridge(tool: PluginMcpBridgeTool): PluginMcpBridgeDescriptor {
		const fullId = tool.fullId ?? `${tool.pluginId}/${tool.contributionId}`;
		const entry = this.registry?.get(fullId);
		if (entry?.kind && entry.kind !== "tool") {
			throw new PluginMcpAdapterError(
				"INVALID_CONTRIBUTION",
				"MCP bridge contribution must reference a declared tool",
				{ pluginId: tool.pluginId, contributionId: tool.contributionId },
			);
		}
		if (
			!tool.pluginId ||
			!tool.contributionId ||
			!tool.title ||
			!tool.inputSchema ||
			!tool.handler
		) {
			throw new PluginMcpAdapterError(
				"INVALID_CONTRIBUTION",
				"MCP bridge tool declaration is incomplete",
			);
		}
		const name = bridgeName(tool.pluginId, tool.contributionId);
		const unavailableReason =
			entry?.status === "unavailable"
				? (entry.unavailableReason ?? "Plugin contribution is unavailable")
				: undefined;
		const initiallyAvailable = tool.available !== false && !unavailableReason;
		const descriptor: PluginMcpBridgeDescriptor = {
			name,
			description: tool.description ? `[Plugin: ${tool.title}] ${tool.description}` : tool.title,
			inputSchema: normalizeSchema(tool.inputSchema),
			pluginId: tool.pluginId,
			contributionId: tool.contributionId,
			fullId,
			available: initiallyAvailable,
			unavailableReason,
		};
		const record: BridgeRecord = {
			tool,
			descriptor,
			available: initiallyAvailable,
			unavailableReason,
		};
		this.bridges.set(fullId, record);
		return { ...descriptor, inputSchema: normalizeSchema(descriptor.inputSchema as JsonSchema) };
	}

	registerBridgeTool(tool: PluginMcpBridgeTool): PluginMcpBridgeDescriptor {
		return this.registerBridge(tool);
	}

	listBridgeTools(): PluginMcpBridgeDescriptor[] {
		return [...this.bridges.values()]
			.sort((a, b) => a.descriptor.fullId.localeCompare(b.descriptor.fullId))
			.map(({ descriptor, available, unavailableReason }) => ({
				...descriptor,
				available,
				unavailableReason,
				inputSchema: normalizeSchema(descriptor.inputSchema as JsonSchema),
			}));
	}

	getBridgeTools(): PluginMcpBridgeDescriptor[] {
		return this.listBridgeTools();
	}

	async callBridgeTool(
		fullId: string,
		args: Record<string, unknown>,
		context: HostCallContext,
		signal?: AbortSignal,
	): Promise<PluginMcpBridgeResult> {
		const record = this.bridges.get(fullId);
		if (!record) throw new PluginMcpAdapterError("NOT_FOUND", `Unknown MCP bridge tool: ${fullId}`);
		if (!record.available) throw unavailableError(record);
		if (typeof record.tool.available === "function" && !(await record.tool.available())) {
			record.available = false;
			record.unavailableReason = "Plugin runtime unavailable";
			record.descriptor.available = false;
			record.descriptor.unavailableReason = record.unavailableReason;
			throw unavailableError(record);
		}
		if (signal?.aborted)
			throw new PluginMcpAdapterError("CANCELLED", "MCP bridge call was cancelled");

		const capability = record.tool.capability ?? MCP_BRIDGE_CAPABILITY;
		try {
			await this.capabilityBroker.require({
				context,
				capability,
				methodId: `mcp.bridge.${fullId}`,
				scope: record.tool.scope,
				constraints: {
					maxBytes: boundedInteger(
						record.tool.maxOutputBytes,
						DEFAULT_OUTPUT_LIMIT_BYTES,
						MAX_OUTPUT_LIMIT_BYTES,
					),
				},
			});
		} catch (error) {
			if (error instanceof PluginMcpAdapterError) throw error;
			throw new PluginMcpAdapterError(
				"PERMISSION_DENIED",
				error instanceof Error ? error.message : "Plugin MCP bridge authorization denied",
				{ pluginId: record.tool.pluginId, contributionId: record.tool.contributionId },
			);
		}

		const timeoutMs = Math.min(
			boundedInteger(record.tool.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
			Math.max(1, Date.parse(context.deadlineAt) - Date.now()),
		);
		const outputLimit = boundedInteger(
			record.tool.maxOutputBytes,
			DEFAULT_OUTPUT_LIMIT_BYTES,
			MAX_OUTPUT_LIMIT_BYTES,
		);
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new PluginMcpAdapterError("TIMEOUT", "MCP bridge call timed out"));
			}, timeoutMs);
		});
		try {
			const result = await Promise.race([
				record.tool.handler(args, controller.signal, context),
				timeout,
			]);
			if (signal?.aborted || controller.signal.aborted) {
				throw new PluginMcpAdapterError("CANCELLED", "MCP bridge call was cancelled");
			}
			if (byteLength(result) > outputLimit) {
				throw new PluginMcpAdapterError(
					"OUTPUT_LIMIT",
					"MCP bridge output exceeded the host limit",
				);
			}
			return structuredClone(result);
		} catch (error) {
			if (error instanceof PluginMcpAdapterError) throw error;
			throw new PluginMcpAdapterError(
				"UNAVAILABLE",
				error instanceof Error ? error.message : "Plugin MCP bridge handler failed",
				{ pluginId: record.tool.pluginId, contributionId: record.tool.contributionId },
			);
		} finally {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	markUnavailable(pluginId: string, reason = "plugin unavailable"): number {
		let changed = 0;
		for (const record of this.bridges.values()) {
			if (record.tool.pluginId !== pluginId) continue;
			record.available = false;
			record.unavailableReason = reason;
			record.descriptor.available = false;
			record.descriptor.unavailableReason = reason;
			changed += 1;
		}
		this.notifyToolsChanged();
		return changed;
	}

	markPluginDisabled(pluginId: string): number {
		return this.markUnavailable(pluginId, "plugin disabled");
	}

	markPluginCrashed(pluginId: string): number {
		return this.markUnavailable(pluginId, "plugin crashed");
	}

	markAvailable(pluginId: string): number {
		let changed = 0;
		for (const record of this.bridges.values()) {
			if (record.tool.pluginId !== pluginId) continue;
			record.available = true;
			record.unavailableReason = undefined;
			record.descriptor.available = true;
			record.descriptor.unavailableReason = undefined;
			changed += 1;
		}
		this.notifyToolsChanged();
		return changed;
	}

	toolListChanged(pluginId: string, tools?: PluginMcpBridgeTool[]): PluginMcpBridgeDescriptor[] {
		if (tools) {
			for (const fullId of [...this.bridges.keys()]) {
				if (fullId.startsWith(`${pluginId}/`)) this.bridges.delete(fullId);
			}
			for (const tool of tools) this.registerBridge(tool);
		}
		this.notifyToolsChanged();
		return this.listBridgeTools().filter((tool) => tool.pluginId === pluginId);
	}

	generateServerConfig(
		contribution: PluginMcpServerContribution,
		policy: PluginMcpServerPolicy = this.serverPolicy,
	): PluginMcpServerConfigResult {
		if (!contribution.pluginId || !contribution.contributionId || !contribution.name) {
			throw new PluginMcpAdapterError(
				"INVALID_CONTRIBUTION",
				"MCP server contribution is incomplete",
			);
		}
		assertKnownKeys(contribution as unknown as Record<string, unknown>, [
			"pluginId",
			"contributionId",
			"name",
			"transport",
			"command",
			"args",
			"cwd",
			"env",
			"url",
			"headers",
			"defaultBehavior",
			"toolPermissions",
			"enabled",
		]);
		if (contribution.transport === "stdio") {
			if (!contribution.command || !isAllowedValue(contribution.command, policy.allowedCommands)) {
				throw new PluginMcpAdapterError("CONFIG_DENIED", "MCP server command is not host-approved");
			}
			if (
				(contribution.args ?? []).some(
					(arg) => hasUnsafeText(arg) || !isAllowedValue(arg, policy.allowedArgs),
				)
			) {
				throw new PluginMcpAdapterError(
					"CONFIG_DENIED",
					"MCP server argument is not host-approved",
				);
			}
			if (!contribution.cwd || !isPathAllowed(contribution.cwd, policy.allowedCwds)) {
				throw new PluginMcpAdapterError("CONFIG_DENIED", "MCP server cwd is not host-approved");
			}
			if (contribution.url || contribution.headers) {
				throw new PluginMcpAdapterError(
					"CONFIG_DENIED",
					"stdio MCP server cannot contain URL or headers",
				);
			}
		} else {
			if (
				!contribution.url ||
				!policy.allowRemoteUrls ||
				!isAllowedValue(contribution.url, policy.allowedUrls)
			) {
				throw new PluginMcpAdapterError("CONFIG_DENIED", "Remote MCP URL is not host-approved");
			}
			if (!contribution.url.startsWith("https://")) {
				throw new PluginMcpAdapterError("CONFIG_DENIED", "MCP remote URL must use https");
			}
			if (contribution.command || contribution.args || contribution.cwd) {
				throw new PluginMcpAdapterError(
					"CONFIG_DENIED",
					"Remote MCP server cannot contain process fields",
				);
			}
		}
		assertSafeMap(contribution.env, policy.allowedEnvKeys, "env");
		assertSafeMap(contribution.headers, policy.allowedHeaderKeys, "header");
		const serverId = `plugin_${safeName(contribution.pluginId)}_${safeName(contribution.contributionId)}`;
		const config: McpServerConfig = {
			id: serverId,
			name: contribution.name,
			transport: contribution.transport,
			command: contribution.command,
			args: contribution.args ? [...contribution.args] : undefined,
			cwd: contribution.cwd,
			env: contribution.env ? { ...contribution.env } : undefined,
			url: contribution.url,
			headers: contribution.headers ? { ...contribution.headers } : undefined,
			enabled: contribution.enabled ?? true,
			defaultBehavior: contribution.defaultBehavior,
			toolPermissions: contribution.toolPermissions,
		};
		const summary: PluginMcpServerConfigSummary = {
			pluginId: contribution.pluginId,
			contributionId: contribution.contributionId,
			serverId,
			name: contribution.name,
			transport: contribution.transport,
			enabled: config.enabled,
			redactedEnvKeys: Object.keys(contribution.env ?? {}).sort(),
			redactedHeaderKeys: Object.keys(contribution.headers ?? {}).sort(),
		};
		const result = { config, summary };
		this.serverConfigs.set(`${contribution.pluginId}/${contribution.contributionId}`, result);
		return structuredClone(result);
	}

	buildServerConfig(
		contribution: PluginMcpServerContribution,
		policy?: PluginMcpServerPolicy,
	): PluginMcpServerConfigResult {
		return this.generateServerConfig(contribution, policy);
	}

	getServerConfigs(): PluginMcpServerConfigResult[] {
		return [...this.serverConfigs.values()].map((item) => structuredClone(item));
	}

	private notifyToolsChanged(): void {
		if (!this.onToolsChanged) return;
		try {
			void Promise.resolve(this.onToolsChanged()).catch(() => undefined);
		} catch {
			// A listener is advisory; one broken consumer must not affect other MCP servers.
		}
	}
}

export const McpContributionAdapter = PluginMcpAdapter;
export const PluginMcpContributionAdapter = PluginMcpAdapter;
