/**
 * JSON Schema → form-field projection for plugin provider config.
 *
 * Scope is deliberately narrow: this renders only the keywords the backend validator
 * in `plugin-provider-registry.ts` actually *enforces on values*. Rendering a control
 * for a keyword the server ignores would invent a guarantee, and rendering nothing for
 * a keyword the server enforces would produce a form that cannot be submitted. Both
 * failure modes are worse than showing a raw JSON editor, which is what unsupported
 * shapes fall back to.
 *
 * Enforced by the server on values (mirrored here):
 *   type, const, enum, minLength, maxLength, pattern,
 *   minimum, maximum, exclusiveMinimum, exclusiveMaximum,
 *   minItems, maxItems, items, properties, required, additionalProperties, $ref
 *
 * Walked by the server's *definition* check but NOT enforced on values:
 *   not, if/then/else, contains, propertyNames, prefixItems
 * These are treated as unsupported. A field carrying one is pushed to the raw editor
 * rather than silently rendered as an unconstrained input, because the UI cannot honour
 * a constraint the server will not check either.
 *
 * The form is a convenience layer only. Authoritative validation stays server-side; the
 * client never gates a submit on its own opinion of a value it cannot fully verify.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type SchemaNode = boolean | { [k: string]: JsonValue };

/** Control chosen for one top-level property. */
export type ConfigFieldKind =
	| "string"
	| "password"
	| "textarea"
	| "number"
	| "integer"
	| "boolean"
	| "select"
	| "multiline-list"
	| "json";

export interface ConfigFieldEnumOption {
	value: string;
	/** Original JSON value, so a non-string enum round-trips without coercion. */
	json: JsonValue;
}

export interface ConfigField {
	name: string;
	kind: ConfigFieldKind;
	label: string;
	description?: string;
	required: boolean;
	/** Present for `select`. */
	options?: ConfigFieldEnumOption[];
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	minItems?: number;
	maxItems?: number;
	/** Server-side `default`, used only to prefill an absent value. */
	defaultValue?: JsonValue;
	/** Const-valued fields are shown read-only; the server rejects anything else. */
	constValue?: JsonValue;
	/** Why this field fell back to the JSON editor, for a UI hint. */
	unsupportedReason?: string;
}

export interface ConfigFormModel {
	fields: ConfigField[];
	/**
	 * True when the whole schema cannot be projected onto fields (for example a bare
	 * `true`, a non-object root, or an unresolvable `$ref` at the root).
	 */
	rawOnly: boolean;
	rawOnlyReason?: string;
	/** Property names not declared by the schema are rejected by the server. */
	additionalPropertiesAllowed: boolean;
}

const MAX_FIELDS = 64;
const MAX_ENUM_OPTIONS = 64;
/** Longer strings get a textarea; the threshold is cosmetic, not a constraint. */
const TEXTAREA_MIN_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve a local `$ref` the same way the server does: `#`-prefixed JSON pointers only,
 * with a visited set so a cycle degrades to "unsupported" instead of hanging the render.
 */
function resolveRef(
	node: Record<string, JsonValue>,
	root: SchemaNode,
	seen: Set<string>,
): SchemaNode | undefined {
	const ref = node.$ref;
	if (typeof ref !== "string") return node;
	if (!ref.startsWith("#") || seen.has(ref)) return undefined;
	const pointer = ref.slice(1);
	let current: JsonValue | undefined = root as JsonValue;
	if (pointer.length > 0) {
		for (const rawSegment of pointer.split("/")) {
			if (rawSegment === "") continue;
			const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
			if (!isRecord(current)) return undefined;
			current = current[segment];
		}
	}
	if (current === undefined) return undefined;
	if (typeof current === "boolean") return current;
	if (!isRecord(current)) return undefined;
	// Follow chained refs, tracking the ones already visited.
	if (typeof current.$ref === "string") {
		return resolveRef(current, root, new Set(seen).add(ref));
	}
	return current;
}

/** Keywords the server walks in schema definitions but never checks against a value. */
const UNENFORCED_KEYWORDS = [
	"not",
	"if",
	"then",
	"else",
	"contains",
	"propertyNames",
	"prefixItems",
] as const;

function schemaTypes(node: Record<string, JsonValue>): string[] | undefined {
	const type = node.type;
	if (typeof type === "string") return [type];
	if (Array.isArray(type)) {
		const types = type.filter((item): item is string => typeof item === "string");
		return types.length > 0 ? types : undefined;
	}
	return undefined;
}

function enumOptions(node: Record<string, JsonValue>): ConfigFieldEnumOption[] | undefined {
	if (!Array.isArray(node.enum) || node.enum.length === 0) return undefined;
	if (node.enum.length > MAX_ENUM_OPTIONS) return undefined;
	return node.enum.map((item) => ({
		// Mantine Select needs string values; `json` carries the original back.
		value: typeof item === "string" ? item : JSON.stringify(item),
		json: item,
	}));
}

/**
 * Project one property schema onto a control.
 *
 * Anything this function cannot express faithfully returns kind `json` with a reason,
 * so the caller can offer a raw editor for just that field instead of failing the whole
 * form.
 */
function fieldFor(
	name: string,
	rawNode: SchemaNode,
	required: boolean,
	root: SchemaNode,
): ConfigField {
	const base: ConfigField = { name, kind: "json", label: name, required };

	if (rawNode === true) {
		return { ...base, unsupportedReason: "schema accepts any value" };
	}
	if (rawNode === false) {
		return { ...base, unsupportedReason: "schema rejects every value" };
	}
	const node = typeof rawNode.$ref === "string" ? resolveRef(rawNode, root, new Set()) : rawNode;
	if (node === undefined || typeof node === "boolean") {
		return {
			...base,
			unsupportedReason:
				node === undefined ? "schema reference cannot be resolved" : "schema accepts any value",
		};
	}

	const label = asString(node.title) ?? name;
	const description = asString(node.description);
	const common: ConfigField = {
		...base,
		label,
		...(description ? { description } : {}),
		...(node.default !== undefined ? { defaultValue: node.default } : {}),
	};

	for (const keyword of UNENFORCED_KEYWORDS) {
		if (node[keyword] !== undefined) {
			return { ...common, unsupportedReason: `\`${keyword}\` is not enforced by the server` };
		}
	}
	// Composition keywords change what a value may be in ways a single control cannot
	// express, so they go to the raw editor rather than being approximated.
	for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
		if (node[keyword] !== undefined) {
			return { ...common, unsupportedReason: `\`${keyword}\` needs the JSON editor` };
		}
	}

	if ("const" in node) {
		return { ...common, kind: "json", constValue: node.const };
	}

	const options = enumOptions(node);
	if (options) return { ...common, kind: "select", options };
	if (Array.isArray(node.enum)) {
		return { ...common, unsupportedReason: "enum has too many values" };
	}

	const types = schemaTypes(node);
	// An untyped node with no enum/const constrains nothing the UI can render.
	if (!types) return { ...common, unsupportedReason: "schema declares no type" };
	if (types.length > 1) {
		return { ...common, unsupportedReason: "schema allows multiple types" };
	}
	const [type] = types;

	if (type === "string") {
		const minLength = asNumber(node.minLength);
		const maxLength = asNumber(node.maxLength);
		const pattern = asString(node.pattern);
		// Kept in step with `isSecretSchemaNode` in plugin-provider-config-service.ts. The
		// backend decides which fields are routed to the vault; if the form recognized
		// fewer markers it would render a credential as a plain visible text input.
		const isSecret =
			node.format === "password" || node.writeOnly === true || node["x-narrafork-secret"] === true;
		const kind: ConfigFieldKind = isSecret
			? "password"
			: (maxLength ?? 0) >= TEXTAREA_MIN_LENGTH
				? "textarea"
				: "string";
		return {
			...common,
			kind,
			...(minLength !== undefined ? { minLength } : {}),
			...(maxLength !== undefined ? { maxLength } : {}),
			...(pattern ? { pattern } : {}),
		};
	}

	if (type === "number" || type === "integer") {
		return {
			...common,
			kind: type === "integer" ? "integer" : "number",
			...(asNumber(node.minimum) !== undefined ? { minimum: asNumber(node.minimum) } : {}),
			...(asNumber(node.maximum) !== undefined ? { maximum: asNumber(node.maximum) } : {}),
			...(asNumber(node.exclusiveMinimum) !== undefined
				? { exclusiveMinimum: asNumber(node.exclusiveMinimum) }
				: {}),
			...(asNumber(node.exclusiveMaximum) !== undefined
				? { exclusiveMaximum: asNumber(node.exclusiveMaximum) }
				: {}),
		};
	}

	if (type === "boolean") return { ...common, kind: "boolean" };

	if (type === "array") {
		const items = node.items;
		const itemNode = isRecord(items)
			? typeof items.$ref === "string"
				? resolveRef(items, root, new Set())
				: items
			: undefined;
		// Only a flat list of plain strings maps cleanly onto a line-per-entry control.
		const itemTypes = isRecord(itemNode) ? schemaTypes(itemNode) : undefined;
		const itemIsPlainString =
			isRecord(itemNode) &&
			itemTypes?.length === 1 &&
			itemTypes[0] === "string" &&
			itemNode.enum === undefined &&
			itemNode.const === undefined;
		if (!itemIsPlainString) {
			return { ...common, unsupportedReason: "array items need the JSON editor" };
		}
		return {
			...common,
			kind: "multiline-list",
			...(asNumber(node.minItems) !== undefined ? { minItems: asNumber(node.minItems) } : {}),
			...(asNumber(node.maxItems) !== undefined ? { maxItems: asNumber(node.maxItems) } : {}),
		};
	}

	// Nested objects and `null` are legal config but have no flat control.
	return {
		...common,
		unsupportedReason:
			type === "object"
				? "nested object needs the JSON editor"
				: `type \`${type}\` needs the JSON editor`,
	};
}

/**
 * Build the field list for a provider's `configSchema`.
 *
 * A schema this cannot project is reported via `rawOnly` so the caller shows a single
 * JSON editor. That is a deliberate escape hatch: a provider must remain configurable
 * even when its schema outruns the form renderer.
 */
export function buildConfigFormModel(schema: SchemaNode | undefined): ConfigFormModel {
	if (schema === undefined || schema === true) {
		return {
			fields: [],
			rawOnly: true,
			rawOnlyReason: "schema accepts any object",
			additionalPropertiesAllowed: true,
		};
	}
	if (schema === false) {
		return {
			fields: [],
			rawOnly: true,
			rawOnlyReason: "schema rejects every value",
			additionalPropertiesAllowed: false,
		};
	}
	if (!isRecord(schema)) {
		return {
			fields: [],
			rawOnly: true,
			rawOnlyReason: "schema is not an object",
			additionalPropertiesAllowed: true,
		};
	}

	const root: SchemaNode = schema;
	const resolved = typeof schema.$ref === "string" ? resolveRef(schema, root, new Set()) : schema;
	if (!isRecord(resolved)) {
		return {
			fields: [],
			rawOnly: true,
			rawOnlyReason: "schema root cannot be resolved",
			additionalPropertiesAllowed: true,
		};
	}

	const properties = isRecord(resolved.properties) ? resolved.properties : undefined;
	const additionalPropertiesAllowed = resolved.additionalProperties !== false;
	if (!properties || Object.keys(properties).length === 0) {
		return {
			fields: [],
			rawOnly: true,
			rawOnlyReason: "schema declares no properties",
			additionalPropertiesAllowed,
		};
	}
	if (Object.keys(properties).length > MAX_FIELDS) {
		return {
			fields: [],
			rawOnly: true,
			rawOnlyReason: "schema declares too many properties",
			additionalPropertiesAllowed,
		};
	}

	const required = new Set(
		Array.isArray(resolved.required)
			? resolved.required.filter((item): item is string => typeof item === "string")
			: [],
	);
	const fields = Object.entries(properties).map(([name, node]) =>
		fieldFor(name, node as SchemaNode, required.has(name), root),
	);
	return { fields, rawOnly: false, additionalPropertiesAllowed };
}

/** A field whose value is a secret, so the UI must mask it and never echo it. */
export function isSecretField(field: ConfigField): boolean {
	return field.kind === "password";
}

export interface FieldIssue {
	name: string;
	message: string;
}

/**
 * Client-side pre-check for a single field.
 *
 * Intentionally a subset of the server's rules and intentionally advisory: it exists to
 * catch typos before a round-trip, not to decide validity. The server re-validates
 * everything, so a value this misses is still rejected there.
 */
export function checkFieldValue(
	field: ConfigField,
	value: JsonValue | undefined,
): string | undefined {
	const absent = value === undefined || value === "" || value === null;
	if (field.required && absent) return "required";
	if (absent) return undefined;

	if (field.kind === "string" || field.kind === "textarea" || field.kind === "password") {
		if (typeof value !== "string") return "must be text";
		if (field.minLength !== undefined && value.length < field.minLength) {
			return `must have at least ${field.minLength} characters`;
		}
		if (field.maxLength !== undefined && value.length > field.maxLength) {
			return `must have at most ${field.maxLength} characters`;
		}
		if (field.pattern) {
			try {
				if (!new RegExp(field.pattern, "u").test(value))
					return "does not match the required format";
			} catch {
				// An invalid pattern is the schema's problem, not the user's input's.
				return undefined;
			}
		}
		return undefined;
	}

	if (field.kind === "number" || field.kind === "integer") {
		if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
		if (field.kind === "integer" && !Number.isInteger(value)) return "must be a whole number";
		if (field.minimum !== undefined && value < field.minimum)
			return `must be at least ${field.minimum}`;
		if (field.maximum !== undefined && value > field.maximum)
			return `must be at most ${field.maximum}`;
		if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum) {
			return `must be greater than ${field.exclusiveMinimum}`;
		}
		if (field.exclusiveMaximum !== undefined && value >= field.exclusiveMaximum) {
			return `must be less than ${field.exclusiveMaximum}`;
		}
		return undefined;
	}

	if (field.kind === "multiline-list") {
		if (!Array.isArray(value)) return "must be a list";
		if (field.minItems !== undefined && value.length < field.minItems) {
			return `must contain at least ${field.minItems} items`;
		}
		if (field.maxItems !== undefined && value.length > field.maxItems) {
			return `must contain at most ${field.maxItems} items`;
		}
		return undefined;
	}

	if (field.kind === "select") {
		const allowed = field.options ?? [];
		if (!allowed.some((option) => JSON.stringify(option.json) === JSON.stringify(value))) {
			return "must be one of the allowed values";
		}
		return undefined;
	}

	return undefined;
}

/** Parse a `multiline-list` textarea into the array the server expects. */
export function parseListValue(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/** Render a `multiline-list` value back into textarea text. */
export function formatListValue(value: JsonValue | undefined): string {
	if (!Array.isArray(value)) return "";
	return value.filter((item): item is string => typeof item === "string").join("\n");
}
