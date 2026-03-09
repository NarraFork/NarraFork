import { z } from "zod/v4";
import type { ToolDefinition } from "./types";

/**
 * Registry for agent tools.
 */
export class ToolRegistry {
	private tools = new Map<string, ToolDefinition>();

	register(tool: ToolDefinition): void {
		this.tools.set(tool.name, tool);
	}

	unregister(name: string): void {
		this.tools.delete(name);
	}

	get(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}

	all(): ToolDefinition[] {
		return [...this.tools.values()];
	}
}

// === Minimal Zod → JSON Schema converter ===

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return convertNode(schema);
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

/** Singleton registry */
export const toolRegistry = new ToolRegistry();
