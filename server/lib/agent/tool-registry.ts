import { z } from "zod/v4";
import type { ToolDefinition } from "./types";

/**
 * Registry for agent tools. Converts Zod schemas to JSON Schema
 */
export class ToolRegistry {
	private tools = new Map<string, ToolDefinition>();

	register(tool: ToolDefinition): void {
		this.tools.set(tool.name, tool);
	}

	get(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}

	all(): ToolDefinition[] {
		return [...this.tools.values()];
	}

		return this.all().map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: { json: zodToJsonSchema(tool.parameters) },
			},
		}));
	}
}

// === Minimal Zod → JSON Schema converter ===

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return convertNode(schema);
}

function convertNode(schema: z.ZodType): Record<string, unknown> {
	// Unwrap optionals and defaults
	if (schema instanceof z.ZodOptional) {
		return convertNode(schema.unwrap());
	}
	if (schema instanceof z.ZodDefault) {
		const inner = convertNode(schema.removeDefault());
		return { ...inner, default: schema._zod.def.defaultValue };
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
		result = { type: "string", enum: schema._zod.def.entries };
	} else if (schema instanceof z.ZodArray) {
		result = { type: "array", items: convertNode(schema.element) };
	} else if (schema instanceof z.ZodLiteral) {
		result = { type: typeof schema._zod.def.value, const: schema._zod.def.value };
	} else if (schema instanceof z.ZodUnion) {
		const options = schema.options.map((o: z.ZodType) => convertNode(o));
		result = { anyOf: options };
	} else if (schema instanceof z.ZodRecord) {
		result = {
			type: "object",
			additionalProperties: convertNode(schema._zod.def.valueType),
		};
	} else {
		result = {};
	}

	// Propagate description from any schema type
	const desc = schema._zod?.def?.description;
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

	const result: Record<string, unknown> = { type: "object", properties };
	if (required.length > 0) result.required = required;
	return result;
}

function convertString(schema: z.ZodString): Record<string, unknown> {
	const result: Record<string, unknown> = { type: "string" };
	const checks = schema._zod.def.checks ?? [];
	for (const check of checks) {
		if (check.kind === "min") result.minLength = check.value;
		if (check.kind === "max") result.maxLength = check.value;
	}
	return result;
}

function convertNumber(schema: z.ZodNumber): Record<string, unknown> {
	const result: Record<string, unknown> = { type: "number" };
	const checks = schema._zod.def.checks ?? [];
	for (const check of checks) {
		if (check.kind === "min") result.minimum = check.value;
		if (check.kind === "max") result.maximum = check.value;
	}
	return result;
}

/** Singleton registry */
export const toolRegistry = new ToolRegistry();
