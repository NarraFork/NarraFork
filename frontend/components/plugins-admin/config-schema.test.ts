import { describe, expect, test } from "bun:test";
import { isSecretSchemaNode } from "@server/services/plugin-provider-config-service";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import {
	buildConfigFormModel,
	type ConfigField,
	checkFieldValue,
	formatListValue,
	type JsonValue,
	parseListValue,
	type SchemaNode,
} from "./config-schema";

/**
 * These tests pin the form renderer against the *real* backend validator rather than a
 * restatement of it. The failure this guards against is drift: if the form accepts a
 * value the registry rejects, the user gets an unexplainable server error; if the form
 * rejects a value the registry accepts, a legitimate config becomes unreachable.
 */

function fieldByName(fields: ConfigField[], name: string): ConfigField {
	const field = fields.find((item) => item.name === name);
	if (!field) throw new Error(`missing field: ${name}`);
	return field;
}

/**
 * Validate a config through the actual registry, as the server would.
 *
 * `register()` validates the entry's initial config, so a `seedConfig` that satisfies
 * the schema is supplied when one is needed. Without it a schema with a `required` field
 * could not be registered at all and the harness would fail before validating anything.
 */
function serverValidate(
	schema: SchemaNode,
	config: Record<string, JsonValue>,
	seedConfig?: Record<string, JsonValue>,
): { valid: boolean; issues: string[] } {
	const registry = new PluginProviderRegistry();
	const reference = "com.example.form/demo@1.0.0:hash";
	registry.register({
		kind: "executable-plugin",
		pluginId: "com.example.form",
		localId: "demo",
		providerInstanceId: reference,
		providerPrefix: "demo",
		displayName: "Demo",
		capabilities: { chat: true },
		configSchema: schema as never,
		...(seedConfig ? { config: seedConfig } : {}),
	});
	const result = registry.validateConfig(reference, config);
	return { valid: result.valid, issues: result.issues.map((issue) => issue.message) };
}

/** Satisfies the shared `required: ["apiMode"]` so registration itself succeeds. */
const seed: Record<string, JsonValue> = { apiMode: "balanced" };

describe("plugin config schema projection", () => {
	test("maps the enforced keyword set onto concrete controls", () => {
		const model = buildConfigFormModel({
			type: "object",
			properties: {
				apiMode: { type: "string", enum: ["balanced", "fast"] },
				apiKey: { type: "string", format: "password" },
				label: { type: "string", minLength: 2, maxLength: 40 },
				notes: { type: "string", maxLength: 400 },
				retries: { type: "integer", minimum: 0, maximum: 9 },
				ratio: { type: "number", exclusiveMinimum: 0 },
				verbose: { type: "boolean" },
				hosts: { type: "array", items: { type: "string" }, maxItems: 4 },
			},
			required: ["apiMode"],
		});

		expect(model.rawOnly).toBe(false);
		expect(fieldByName(model.fields, "apiMode").kind).toBe("select");
		expect(fieldByName(model.fields, "apiMode").required).toBe(true);
		expect(fieldByName(model.fields, "apiKey").kind).toBe("password");
		expect(fieldByName(model.fields, "label").kind).toBe("string");
		// A long maxLength earns a textarea; this is presentation, not a constraint.
		expect(fieldByName(model.fields, "notes").kind).toBe("textarea");
		expect(fieldByName(model.fields, "retries").kind).toBe("integer");
		expect(fieldByName(model.fields, "ratio").kind).toBe("number");
		expect(fieldByName(model.fields, "verbose").kind).toBe("boolean");
		expect(fieldByName(model.fields, "hosts").kind).toBe("multiline-list");
		expect(fieldByName(model.fields, "hosts").maxItems).toBe(4);
	});

	test("carries title, description and default through to the field", () => {
		const model = buildConfigFormModel({
			type: "object",
			properties: {
				apiMode: {
					type: "string",
					title: "API mode",
					description: "Load-balancing strategy.",
					default: "balanced",
				},
			},
		});
		const field = fieldByName(model.fields, "apiMode");
		expect(field.label).toBe("API mode");
		expect(field.description).toBe("Load-balancing strategy.");
		expect(field.defaultValue).toBe("balanced");
	});

	test("resolves a local $ref the way the server does", () => {
		const model = buildConfigFormModel({
			type: "object",
			properties: { mode: { $ref: "#/$defs/mode" } },
			$defs: { mode: { type: "string", enum: ["a", "b"] } },
		});
		const field = fieldByName(model.fields, "mode");
		expect(field.kind).toBe("select");
		expect(field.options?.map((option) => option.value)).toEqual(["a", "b"]);
	});

	test("falls back to the JSON editor for a cyclic or unresolvable $ref", () => {
		const cyclic = buildConfigFormModel({
			type: "object",
			properties: { loop: { $ref: "#/$defs/loop" } },
			$defs: { loop: { $ref: "#/$defs/loop" } },
		});
		expect(fieldByName(cyclic.fields, "loop").kind).toBe("json");
		expect(fieldByName(cyclic.fields, "loop").unsupportedReason).toBeDefined();

		const missing = buildConfigFormModel({
			type: "object",
			properties: { gone: { $ref: "#/$defs/absent" } },
		});
		expect(fieldByName(missing.fields, "gone").kind).toBe("json");
	});

	test("routes keywords the server does not enforce to the JSON editor", () => {
		// The registry walks these in schema *definitions* but never checks them against a
		// value. Rendering a normal input would imply a constraint nobody enforces.
		for (const keyword of ["not", "if", "contains", "propertyNames", "prefixItems"] as const) {
			const model = buildConfigFormModel({
				type: "object",
				properties: { risky: { type: "string", [keyword]: { type: "string" } } },
			});
			const field = fieldByName(model.fields, "risky");
			expect(field.kind).toBe("json");
			expect(field.unsupportedReason).toContain(keyword);
		}
	});

	test("routes composition and nested objects to the JSON editor", () => {
		const model = buildConfigFormModel({
			type: "object",
			properties: {
				composed: { anyOf: [{ type: "string" }, { type: "number" }] },
				nested: { type: "object", properties: { inner: { type: "string" } } },
				multi: { type: ["string", "number"] },
				untyped: { description: "no type at all" },
				objects: { type: "array", items: { type: "object" } },
			},
		});
		for (const name of ["composed", "nested", "multi", "untyped", "objects"]) {
			expect(fieldByName(model.fields, name).kind).toBe("json");
			expect(fieldByName(model.fields, name).unsupportedReason).toBeDefined();
		}
	});

	test("marks const fields read-only rather than editable", () => {
		const model = buildConfigFormModel({
			type: "object",
			properties: { version: { const: 1 } },
		});
		const field = fieldByName(model.fields, "version");
		expect(field.constValue).toBe(1);
		expect(field.kind).toBe("json");
	});

	test("reports rawOnly for schemas with no projectable properties", () => {
		expect(buildConfigFormModel(true).rawOnly).toBe(true);
		expect(buildConfigFormModel(false).rawOnly).toBe(true);
		expect(buildConfigFormModel(undefined).rawOnly).toBe(true);
		expect(buildConfigFormModel({ type: "object" }).rawOnly).toBe(true);
		const model = buildConfigFormModel({ type: "object", properties: {} });
		expect(model.rawOnly).toBe(true);
		expect(model.rawOnlyReason).toBeDefined();
	});

	test("surfaces additionalProperties:false so the UI can warn about unknown keys", () => {
		const closed = buildConfigFormModel({
			type: "object",
			properties: { a: { type: "string" } },
			additionalProperties: false,
		});
		expect(closed.additionalPropertiesAllowed).toBe(false);
		const open = buildConfigFormModel({ type: "object", properties: { a: { type: "string" } } });
		expect(open.additionalPropertiesAllowed).toBe(true);
	});
});

describe("plugin config client checks agree with the server validator", () => {
	const schema: SchemaNode = {
		type: "object",
		properties: {
			apiMode: { type: "string", enum: ["balanced", "fast"] },
			label: { type: "string", minLength: 2, maxLength: 6 },
			slug: { type: "string", pattern: "^[a-z]+$" },
			retries: { type: "integer", minimum: 1, maximum: 3 },
			ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
			hosts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
		},
		required: ["apiMode"],
	};

	const cases: Array<{ name: string; config: Record<string, JsonValue> }> = [
		{ name: "valid baseline", config: { apiMode: "balanced" } },
		{ name: "enum outside the list", config: { apiMode: "turbo" } },
		{ name: "string too short", config: { apiMode: "fast", label: "a" } },
		{ name: "string too long", config: { apiMode: "fast", label: "abcdefg" } },
		{ name: "pattern mismatch", config: { apiMode: "fast", slug: "Nope1" } },
		{ name: "integer below minimum", config: { apiMode: "fast", retries: 0 } },
		{ name: "integer above maximum", config: { apiMode: "fast", retries: 4 } },
		{ name: "non-integer for integer field", config: { apiMode: "fast", retries: 1.5 } },
		{ name: "exclusive bound hit exactly", config: { apiMode: "fast", ratio: 0 } },
		{ name: "too few items", config: { apiMode: "fast", hosts: [] } },
		{ name: "too many items", config: { apiMode: "fast", hosts: ["a", "b", "c"] } },
		{ name: "wrong type for number", config: { apiMode: "fast", ratio: "high" } },
	];

	test("client field checks never disagree with the registry on the same value", () => {
		const model = buildConfigFormModel(schema);
		for (const { name, config } of cases) {
			const server = serverValidate(schema, config, seed);
			const clientIssues: string[] = [];
			for (const field of model.fields) {
				const issue = checkFieldValue(field, config[field.name]);
				if (issue) clientIssues.push(`${field.name}: ${issue}`);
			}
			// The client is allowed to be *quieter* than the server (it is advisory), but it
			// must never claim a value is bad when the server accepts it.
			if (server.valid) {
				expect(clientIssues).toEqual([]);
			} else {
				expect(clientIssues.length).toBeGreaterThan(0);
			}
			// Keep the case name in the failure output.
			expect({ name, serverValid: server.valid }).toBeDefined();
		}
	});

	test("required-but-missing is caught before a round-trip", () => {
		const model = buildConfigFormModel(schema);
		expect(checkFieldValue(fieldByName(model.fields, "apiMode"), undefined)).toBe("required");
		expect(serverValidate(schema, {}, seed).valid).toBe(false);
	});

	test("an empty optional value is not treated as an error", () => {
		const model = buildConfigFormModel(schema);
		expect(checkFieldValue(fieldByName(model.fields, "label"), "")).toBeUndefined();
		expect(checkFieldValue(fieldByName(model.fields, "label"), undefined)).toBeUndefined();
	});
});

/**
 * The form's notion of "this is a secret" must match the backend's, because the backend
 * decides which fields are diverted to the vault. If the form recognized fewer markers, a
 * credential would be rendered as an ordinary visible text input and echoed back into the
 * form — so this asserts against `isSecretSchemaNode`, the function the server actually
 * uses, rather than against a copy of its rules.
 */
describe("plugin config secret marker parity", () => {
	const markers: Array<Record<string, JsonValue>> = [
		{ format: "password" },
		{ writeOnly: true },
		{ "x-narrafork-secret": true },
		{ writeOnly: true, "x-narrafork-secret": true },
	];

	test("every marker the backend calls secret renders as a password field", () => {
		for (const marker of markers) {
			const node = { type: "string", ...marker };
			const label = JSON.stringify(marker);
			expect(isSecretSchemaNode(node), label).toBe(true);
			const model = buildConfigFormModel({
				type: "object",
				properties: { apiKey: node as SchemaNode },
			});
			expect(fieldByName(model.fields, "apiKey").kind, label).toBe("password");
		}
	});

	test("a plain string field is secret on neither side", () => {
		const node = { type: "string" };
		expect(isSecretSchemaNode(node)).toBe(false);
		const model = buildConfigFormModel({
			type: "object",
			properties: { label: node as SchemaNode },
		});
		expect(fieldByName(model.fields, "label").kind).toBe("string");
	});
});

describe("plugin config list value round-trip", () => {
	test("parses lines, trimming blanks", () => {
		expect(parseListValue("a\n  b  \n\n c\n")).toEqual(["a", "b", "c"]);
		expect(parseListValue("")).toEqual([]);
	});

	test("formats an array back to text and ignores non-strings", () => {
		expect(formatListValue(["a", "b"])).toBe("a\nb");
		expect(formatListValue(["a", 2 as unknown as string])).toBe("a");
		expect(formatListValue(undefined)).toBe("");
		expect(formatListValue("not a list")).toBe("");
	});

	test("round-trips without mutating the value", () => {
		const original = ["alpha", "beta"];
		expect(parseListValue(formatListValue(original))).toEqual(original);
	});
});
