import { z } from "zod";

/** A settings contribution augments an existing host target; it does not register a model provider. */
export const providerSettingsTargetKindSchema = z.enum([
	"custom-api",
	"nug",
	"platform",
	"executable-plugin",
]);
export type ProviderSettingsTargetKind = z.infer<typeof providerSettingsTargetKindSchema>;

export const PROVIDER_SETTINGS_LIMITS = Object.freeze({
	contributions: 32,
	fields: 32,
	connections: 8,
	headers: 8,
	enumValues: 32,
	schemaNodes: 256,
	schemaDepth: 8,
	schemaBytes: 32 * 1024,
});

const localId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
const fieldName = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z][A-Za-z0-9_]*$/)
	.refine(
		(value) => value !== "prototype" && !Object.hasOwn(Object.prototype, value),
		"Reserved field name",
	);
export const providerSettingsFieldNameSchema = fieldName;
/** JSON Schema string bounds count Unicode code points, not UTF-16 code units. */
export function providerSettingsStringLength(value: string): number {
	return [...value].length;
}

const cleanText = (max: number) =>
	z
		.string()
		.max(max)
		.refine((s) => {
			for (const ch of s) if (ch < " " || ch === "\x7f" || ch === "<" || ch === ">") return false;
			return true;
		}, "Expected plain text");
const title = cleanText(200).min(1);
const description = cleanText(1024);
const captions = z.strictObject({ title: title.optional(), description: description.optional() });
const translations = z.strictObject({ en: captions.optional(), "zh-CN": captions.optional() });
const common = {
	title: title.optional(),
	description: description.optional(),
	"x-narrafork-i18n": translations.optional(),
};
const length = z.number().int().min(0).max(4096);
const stringField = z.strictObject({
	type: z.literal("string"),
	...common,
	minLength: length.optional(),
	maxLength: length.optional(),
	format: z.enum(["uri", "password"]).optional(),
	writeOnly: z.literal(true).optional(),
	"x-narrafork-secret": z.literal(true).optional(),
	"x-narrafork-host-only": z.literal(true).optional(),
	enum: z.array(cleanText(256)).min(1).max(PROVIDER_SETTINGS_LIMITS.enumValues).optional(),
	default: cleanText(4096).optional(),
});
const scalar = { ...common, minimum: z.number().optional(), maximum: z.number().optional() };
const field = z.discriminatedUnion("type", [
	stringField,
	z.strictObject({ type: z.literal("boolean"), ...common, default: z.boolean().optional() }),
	z.strictObject({ type: z.literal("integer"), ...scalar, default: z.number().int().optional() }),
	z.strictObject({ type: z.literal("number"), ...scalar, default: z.number().optional() }),
]);
export type ProviderSettingsField = z.infer<typeof field>;
export function providerSettingsFieldVisibility(
	f: ProviderSettingsField,
): "secret" | "host" | "public" {
	if (f.type !== "string") return "public";
	if (f.writeOnly || f["x-narrafork-secret"] || f.format === "password") return "secret";
	return f["x-narrafork-host-only"] ? "host" : "public";
}

function boundedSchemaInput(value: unknown): boolean {
	let nodes = 0;
	let chars = 0;
	const seen = new Set<object>();
	const visit = (v: unknown, level: number): boolean => {
		if (
			++nodes > PROVIDER_SETTINGS_LIMITS.schemaNodes ||
			level > PROVIDER_SETTINGS_LIMITS.schemaDepth
		)
			return false;
		if (typeof v === "string") {
			chars += v.length;
			return chars <= PROVIDER_SETTINGS_LIMITS.schemaBytes;
		}
		if (typeof v === "number") return Number.isFinite(v);
		if (v === null || typeof v === "boolean") return true;
		if (!v || typeof v !== "object" || seen.has(v)) return false;
		seen.add(v);
		if (Array.isArray(v)) {
			if (
				v.length > PROVIDER_SETTINGS_LIMITS.enumValues ||
				Reflect.ownKeys(v).length !== v.length + 1
			)
				return false;
			for (let i = 0; i < v.length; i++) {
				const item = Object.getOwnPropertyDescriptor(v, String(i));
				if (!item || !("value" in item) || !visit(item.value, level + 1)) return false;
			}
			return true;
		}
		const proto = Object.getPrototypeOf(v);
		if (proto !== null && proto !== Object.prototype) return false;
		const keys = Reflect.ownKeys(v);
		if (keys.length > 64) return false;
		for (const k of keys) {
			if (
				typeof k !== "string" ||
				k === "prototype" ||
				k === "toJSON" ||
				Object.hasOwn(Object.prototype, k)
			)
				return false;
			chars += k.length;
			const property = Object.getOwnPropertyDescriptor(v, k);
			if (
				chars > PROVIDER_SETTINGS_LIMITS.schemaBytes ||
				!property?.enumerable ||
				!("value" in property) ||
				!visit(property.value, level + 1)
			)
				return false;
		}
		return true;
	};
	return (
		visit(value, 1) &&
		new TextEncoder().encode(JSON.stringify(value)).byteLength <=
			PROVIDER_SETTINGS_LIMITS.schemaBytes
	);
}
const configShape = z
	.strictObject({
		type: z.literal("object"),
		additionalProperties: z.literal(false),
		properties: z.record(fieldName, field),
		required: z.array(fieldName).max(PROVIDER_SETTINGS_LIMITS.fields).optional(),
	})
	.superRefine((schema, ctx) => {
		const add = (path: (string | number)[], message: string) =>
			ctx.addIssue({ code: "custom", path, message });
		const entries = Object.entries(schema.properties);
		if (entries.length > PROVIDER_SETTINGS_LIMITS.fields)
			add(["properties"], "Too many settings fields");
		if (
			schema.required &&
			(new Set(schema.required).size !== schema.required.length ||
				schema.required.some((k) => !Object.hasOwn(schema.properties, k)))
		)
			add(["required"], "Required fields must be distinct declared properties");
		for (const [k, f] of entries) {
			const path = ["properties", k];
			if (f.type === "string") {
				const min = f.minLength ?? 0,
					max = f.maxLength ?? 4096;
				if (min > max) add(path, "Inconsistent string bounds");
				if (
					providerSettingsFieldVisibility(f) !== "public" &&
					(f.default !== undefined ||
						f.enum ||
						(f.format === "uri" && providerSettingsFieldVisibility(f) === "secret"))
				)
					add(path, "Private fields cannot declare defaults, enumerations or secret destinations");
				if (
					f.enum &&
					(new Set(f.enum).size !== f.enum.length ||
						f.enum.some(
							(s) => providerSettingsStringLength(s) < min || providerSettingsStringLength(s) > max,
						))
				)
					add(path, "Invalid string enumeration");
				if (
					f.default !== undefined &&
					(providerSettingsStringLength(f.default) < min ||
						providerSettingsStringLength(f.default) > max ||
						(f.enum && !f.enum.includes(f.default)))
				)
					add(path, "Invalid string default");
			} else if (f.type !== "boolean") {
				const min = f.minimum ?? -Infinity,
					max = f.maximum ?? Infinity;
				if (min > max || (f.default !== undefined && (f.default < min || f.default > max)))
					add(path, "Invalid numeric bounds or default");
			}
		}
	});
export const providerSettingsConfigSchema = z.preprocess((v, ctx) => {
	if (boundedSchemaInput(v)) return v;
	ctx.addIssue({ code: "custom", message: "Invalid or oversized provider settings schema" });
	return z.NEVER;
}, configShape);

// Paths are literal suffixes appended *under* a host-selected root. No patterns, URL overrides, query or encoded separators.
const pathSuffix = z
	.string()
	.min(1)
	.max(512)
	.regex(/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?$/)
	.refine(
		(p) => !p.split("/").some((s) => s === "." || s === ".."),
		"Path must remain below the saved root",
	);
const connectionBase = { id: localId, method: z.literal("GET"), path: pathSuffix };
// v1 only permits bounded identity headers, not arbitrary proxy, routing or authentication overrides.
const identityHeader = z
	.string()
	.min(1)
	.max(64)
	.regex(
		/^(?!proxy-|sec-|x-forwarded-|forwarded-|x-original-|x-rewrite-|x-http-|x-envoy-|cf-)[a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:user|account|tenant)(?:-id)?$/,
	);
const extensionAuth = z.union([
	z.literal("none"),
	z.strictObject({ kind: z.literal("bearer"), secretField: fieldName }),
	z.strictObject({
		kind: z.literal("header"),
		name: z.enum(["x-api-key", "api-key"]),
		secretField: fieldName,
	}),
]);
export const providerSettingsConnectionSchema = z.discriminatedUnion("destination", [
	z.strictObject({
		...connectionBase,
		destination: z.literal("provider"),
		auth: z.enum(["none", "provider-key"]),
	}),
	z.strictObject({
		...connectionBase,
		destination: z.literal("extension"),
		baseUrlField: fieldName,
		whenUrlMissing: z.enum(["unavailable", "provider-root"]).optional(),
		auth: extensionAuth,
		headers: z
			.array(z.strictObject({ name: identityHeader, field: fieldName }))
			.max(PROVIDER_SETTINGS_LIMITS.headers)
			.optional(),
	}),
]);
export type ProviderSettingsConnection = z.infer<typeof providerSettingsConnectionSchema>;

/** Strict additive manifest declaration. No field can select another plugin's namespace, a target ID, an installation, or a credential owner. */
export const providerSettingsContributionSchema = z
	.strictObject({
		id: localId,
		schemaVersion: z.literal(1),
		title,
		description: description.optional(),
		i18n: translations.optional(),
		targetKinds: z.array(providerSettingsTargetKindSchema).min(1).max(4),
		configSchema: providerSettingsConfigSchema,
		action: z
			.strictObject({ title, description: description.optional(), i18n: translations.optional() })
			.optional(),
		connections: z
			.array(providerSettingsConnectionSchema)
			.max(PROVIDER_SETTINGS_LIMITS.connections)
			.optional(),
	})
	.superRefine((declaration, ctx) => {
		if (new Set(declaration.targetKinds).size !== declaration.targetKinds.length)
			ctx.addIssue({ code: "custom", path: ["targetKinds"], message: "Duplicate target kind" });
		const ids = new Set<string>(),
			fields = declaration.configSchema.properties;
		const lookup = (k: string) => (Object.hasOwn(fields, k) ? fields[k] : undefined);
		for (const [i, rule] of (declaration.connections ?? []).entries()) {
			const add = (at: string, msg: string) =>
				ctx.addIssue({ code: "custom", path: ["connections", i, at], message: msg });
			if (ids.has(rule.id)) add("id", "Duplicate connection id");
			ids.add(rule.id);
			if (rule.destination !== "extension") continue;
			const url = lookup(rule.baseUrlField);
			if (
				url?.type !== "string" ||
				url.format !== "uri" ||
				providerSettingsFieldVisibility(url) === "secret" ||
				url.default !== undefined ||
				url.enum
			)
				add("baseUrlField", "Extension root must be an explicitly saved URI field");
			if (rule.auth !== "none") {
				const secret = lookup(rule.auth.secretField);
				if (!secret || providerSettingsFieldVisibility(secret) !== "secret")
					add("auth", "Credential must refer to this contribution's secret field");
			}
			const names = new Set<string>();
			for (const header of rule.headers ?? []) {
				const source = lookup(header.field);
				if (
					names.has(header.name) ||
					!source ||
					source.type !== "string" ||
					providerSettingsFieldVisibility(source) === "secret" ||
					header.field === rule.baseUrlField ||
					source.default !== undefined
				)
					add(
						"headers",
						"Identity headers must be unique and refer to saved, non-secret string fields",
					);
				names.add(header.name);
			}
		}
	});
export type ProviderSettingsContribution = z.infer<typeof providerSettingsContributionSchema>;
