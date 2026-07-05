import { z } from "zod/v4";
import type { ToolDefinition } from "./types";

/**
 * Interface for tool providers that supply tools to the registry.
 * Enables plugin-style registration of tool groups.
 */
export interface ToolProvider {
	/** Unique provider name (e.g. "core", "optional", "review", "mcp"). */
	name: string;
	/** Tools provided by this provider. */
	tools(): ToolDefinition[];
	/** Called when the provider is registered. */
	initialize?(): void;
	/** Called when the provider is unregistered. */
	dispose?(): void;
}

/**
 * Registry for agent tools.
 */
export class ToolRegistry {
	/** Tools registered individually (not via a provider). */
	private directTools = new Map<string, ToolDefinition>();
	private providers = new Map<string, ToolProvider>();
	/**
	 * Cache of the flattened tool set (direct + all providers'), rebuilt lazily.
	 * Null means "needs (re)materialization".
	 *
	 * Provider tools are materialized LAZILY (on first read) rather than eagerly
	 * at registerProvider() time. A provider's tools() closure typically
	 * references module-level tool bindings (editTool, bashTool, …); calling it
	 * during a re-entrant, import-time registration would read those bindings
	 * while they are still in the temporal dead zone and throw. Deferring to the
	 * first get()/all() — which only happens at request time, after all modules
	 * have finished initializing — avoids that entirely.
	 */
	private materialized: Map<string, ToolDefinition> | null = null;

	register(tool: ToolDefinition): void {
		this.directTools.set(tool.name, tool);
		this.materialized = null;
	}

	unregister(name: string): void {
		this.directTools.delete(name);
		this.materialized = null;
	}

	private ensureMaterialized(): Map<string, ToolDefinition> {
		if (this.materialized) return this.materialized;
		const flat = new Map<string, ToolDefinition>();
		// Providers first, then direct tools, so an explicitly registered tool
		// wins over a provider tool of the same name.
		for (const provider of this.providers.values()) {
			for (const tool of provider.tools()) {
				flat.set(tool.name, tool);
			}
		}
		for (const [name, tool] of this.directTools) {
			flat.set(name, tool);
		}
		this.materialized = flat;
		return flat;
	}

	get(name: string): ToolDefinition | undefined {
		return this.ensureMaterialized().get(name);
	}

	all(): ToolDefinition[] {
		return [...this.ensureMaterialized().values()];
	}

	registerProvider(provider: ToolProvider): void {
		if (this.providers.has(provider.name)) {
			this.unregisterProvider(provider.name);
		}
		this.providers.set(provider.name, provider);
		provider.initialize?.();
		// Do NOT call provider.tools() here — see `materialized` doc comment.
		this.materialized = null;
	}

	unregisterProvider(name: string): void {
		const provider = this.providers.get(name);
		if (!provider) return;
		provider.dispose?.();
		this.providers.delete(name);
		this.materialized = null;
	}
}

// === Minimal Zod → JSON Schema converter ===

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return convertNode(schema);
}

/**
 * Resolve the JSON Schema for a tool definition.
 * Prefers `rawJsonSchema` (set by MCP tools) over Zod conversion.
 */
export function resolveToolJsonSchema(tool: {
	parameters: z.ZodType;
	rawJsonSchema?: Record<string, unknown>;
}): Record<string, unknown> {
	return tool.rawJsonSchema ?? zodToJsonSchema(tool.parameters);
}

function convertNode(schema: z.ZodType): Record<string, unknown> {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const def = (schema as any)._zod?.def;
	const typeName: string | undefined = def?.typeName;

	// Unwrap optionals and defaults, preserving description from wrapper
	if (typeName === "ZodOptional" || schema instanceof z.ZodOptional) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const inner = convertNode((schema as z.ZodOptional<any>).unwrap());
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const desc = (schema as any).description;
		if (desc && !inner.description) inner.description = desc;
		return inner;
	}
	if (typeName === "ZodDefault" || schema instanceof z.ZodDefault) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const inner = convertNode((schema as z.ZodDefault<any>).removeDefault());
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const desc = (schema as any).description;
		if (desc && !inner.description) inner.description = desc;
		return { ...inner, default: def?.defaultValue };
	}

	let result: Record<string, unknown>;

	if (schema instanceof z.ZodObject) {
		result = convertObject(schema);
	} else if (schema instanceof z.ZodString) {
		result = convertString(schema);
	} else if (schema instanceof z.ZodNumber) {
		result = convertNumber(schema);
	} else if (schema instanceof z.ZodBoolean) {
		result = { type: "boolean" };
	} else if (schema instanceof z.ZodEnum) {
		// Zod v4 internal: _zod.def.entries is an object, not an array
		result = { type: "string", enum: Object.values(def.entries) };
	} else if (schema instanceof z.ZodArray) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		result = { type: "array", items: convertNode((schema as any).element) };
	} else if (schema instanceof z.ZodLiteral) {
		const values = def.values;
		const val = Array.isArray(values) ? values[0] : values;
		result = { type: typeof val, const: val };
	} else if (schema instanceof z.ZodUnion) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const options = ((schema as any).options as any[]).map((o: any) => convertNode(o));
		result = { anyOf: options };
	} else if (schema instanceof z.ZodRecord) {
		result = {
			type: "object",
			additionalProperties: convertNode(def.valueType),
		};
	} else if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
		// z.any() / z.unknown() — emit a permissive type so providers don't reject
		result = { type: "string" };
	} else if (schema instanceof z.ZodNullable) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const inner = convertNode((schema as any).unwrap());
		result = { anyOf: [inner, { type: "null" }] };
	} else {
		result = {};
	}

	// Propagate description from any schema type
	// Zod v4 stores .describe() on the schema instance directly, not in _zod.def
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const desc = (schema as any).description ?? def?.description;
	if (desc) result.description = desc;

	return result;
}

function convertObject(schema: z.ZodObject): Record<string, unknown> {
	const shape = schema.shape;
	const properties: Record<string, unknown> = {};
	const required: string[] = [];

	for (const [key, value] of Object.entries(shape)) {
		const fieldSchema = value as z.ZodType;
		properties[key] = convertNode(fieldSchema);

		// Field is required unless it's optional
		if (!(fieldSchema instanceof z.ZodOptional)) {
			required.push(key);
		}
	}

	const result: Record<string, unknown> = {
		type: "object",
		properties,
		additionalProperties: false,
	};
	if (required.length > 0) result.required = required;
	return result;
}

function convertString(schema: z.ZodString): Record<string, unknown> {
	const result: Record<string, unknown> = { type: "string" };
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const checks: any[] = (schema as any)._zod?.def?.checks ?? [];
	for (const check of checks) {
		if (check.kind === "min") result.minLength = check.value;
		if (check.kind === "max") result.maxLength = check.value;
	}
	return result;
}

function convertNumber(schema: z.ZodNumber): Record<string, unknown> {
	const result: Record<string, unknown> = { type: "number" };
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const checks: any[] = (schema as any)._zod?.def?.checks ?? [];
	for (const check of checks) {
		if (check.kind === "min") result.minimum = check.value;
		if (check.kind === "max") result.maximum = check.value;
	}
	return result;
}

/**
 * Ensure a JSON Schema has at least one required property.
 * parameters, so we inject a dummy `confirm` property when needed.
 */
export function ensureNonEmptySchema(schema: Record<string, unknown>): Record<string, unknown> {
	const props = schema.properties as Record<string, unknown> | undefined;
	const required = schema.required as string[] | undefined;

	// Already has required params — nothing to do
	if (required && required.length > 0) return schema;

	// Has no properties at all — inject a dummy
	if (!props || Object.keys(props).length === 0) {
		return {
			...schema,
			properties: {
				confirm: {
					type: "boolean",
					description: "Dummy parameter (always pass true)",
					const: true,
					default: true,
				},
			},
			required: ["confirm"],
		};
	}

	// Has properties but none required — pick the first one and make it required
	return {
		...schema,
		required: [Object.keys(props)[0]],
	};
}

/** Singleton registry */
export const toolRegistry = new ToolRegistry();
