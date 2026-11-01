import { describe, expect, test } from "bun:test";
import { settings } from "../../../settings";
import { withDeviceParam } from "../../execution/device-schema";
import { resolveToolJsonSchema, toolRegistry } from "../../tool-registry";
import "../index";

describe("static built-in tool definitions", () => {
	test("every registered tool has data properties, not config or settings getters", () => {
		const tools = toolRegistry.all();
		expect(tools.length).toBeGreaterThan(40);
		for (const tool of tools) {
			expect(typeof tool.description, tool.name).toBe("string");
			expect(tool, tool.name).not.toHaveProperty("getRawJsonSchema");
			for (const field of ["description", "parameters", "rawJsonSchema"]) {
				expect(
					Object.getOwnPropertyDescriptor(tool, field)?.get,
					`${tool.name}.${field}`,
				).toBeUndefined();
			}
		}
	});

	test("model pool changes do not change tool definitions or rebuild schemas", () => {
		const tools = toolRegistry.all();
		const before = tools.map((tool) => ({
			description: tool.description,
			parameters: tool.parameters,
			raw: tool.rawJsonSchema,
			schema: JSON.stringify(resolveToolJsonSchema(tool)),
		}));
		const oldModels = settings.agent.customModels;
		const oldPools = settings.agent.subagentAllowedModels;
		const oldEfforts = settings.agent.subagentModelReasoningEfforts;
		try {
			settings.agent.customModels = [{ value: "static-test:new", label: "New candidate" }];
			settings.agent.subagentAllowedModels = {
				general: ["static-test:new"],
				explore: [],
				plan: [],
			};
			settings.agent.subagentModelReasoningEfforts = { general: { "static-test:new": "high" } };
			for (const [index, tool] of tools.entries()) {
				const previous = before[index];
				expect(tool.description, tool.name).toBe(previous.description);
				expect(tool.parameters, tool.name).toBe(previous.parameters);
				expect(tool.rawJsonSchema, tool.name).toBe(previous.raw);
				expect(JSON.stringify(resolveToolJsonSchema(tool)), tool.name).toBe(previous.schema);
			}
		} finally {
			settings.agent.customModels = oldModels;
			settings.agent.subagentAllowedModels = oldPools;
			settings.agent.subagentModelReasoningEfforts = oldEfforts;
		}
	});

	test("filesystem and command tools always advertise an optional plain device string", () => {
		for (const name of [
			"Bash",
			"Read",
			"Write",
			"Edit",
			"Glob",
			"Grep",
			"StructView",
			"StructSed",
		]) {
			const tool = toolRegistry.get(name);
			expect(tool, name).toBeDefined();
			if (!tool) throw new Error(`Missing ${name}`);
			const schema = resolveToolJsonSchema(tool);
			const device = (schema.properties as Record<string, { type: string; enum?: string[] }>)
				.device;
			expect(device.type, name).toBe("string");
			expect(device.enum, name).toBeUndefined();
			expect((schema.required ?? []) as string[], name).not.toContain("device");
		}
		const base = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
		const schema = withDeviceParam(base);
		expect(base.properties).not.toHaveProperty("device");
		expect(schema.required).toBe(base.required);
	});

	test("device switching, transfer and model overrides retain unrestricted string shapes", () => {
		for (const [name, field] of [
			["SwitchDevice", "device"],
			["TransferFile", "device"],
			["Agent", "model"],
			["Send", "model"],
			["ForkNarrator", "model"],
		]) {
			const tool = toolRegistry.get(name);
			if (!tool) throw new Error(`Missing ${name}`);
			const properties = resolveToolJsonSchema(tool).properties as Record<
				string,
				{ type: string; enum?: string[] }
			>;
			expect(properties[field].type).toBe("string");
			expect(properties[field].enum).toBeUndefined();
		}
	});

	test("ExitPlanMode statically advertises every source while requiring a declaration", () => {
		const schema = toolRegistry.get("ExitPlanMode")?.rawJsonSchema;
		expect(schema?.required).toEqual(["mode"]);
		expect(schema?.properties).toMatchObject({
			mode: { type: "string", enum: ["inline", "file"] },
			inline_plan: { type: "string" },
			plan_file_path: { type: "string" },
		});
	});
});
