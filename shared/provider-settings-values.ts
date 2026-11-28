import { z } from "zod";
import {
	type ProviderSettingsContribution,
	type ProviderSettingsTargetKind,
	providerSettingsFieldNameSchema,
	providerSettingsStringLength,
} from "./provider-settings";

export const PROVIDER_SETTINGS_VALUE_LIMITS = Object.freeze({
	combinedBytes: 32 * 1024,
	requestBytes: 48 * 1024,
	fields: 32,
	stringChars: 4096,
	nodes: 256,
	depth: 6,
});

export type ProviderSettingsValue = string | number | boolean;
export type ProviderSettingsValues = Record<string, ProviderSettingsValue>;
export const providerSettingsFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const providerSettingsRevisionSchema = z
	.number()
	.int()
	.min(0)
	.max(Number.MAX_SAFE_INTEGER - 1);

/** Validate JSON data before Zod touches properties; never run accessors or toJSON. */
export function isBoundedProviderSettingsData(value: unknown, maxBytes: number): boolean {
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > PROVIDER_SETTINGS_VALUE_LIMITS.requestBytes
	)
		return false;
	let nodes = 0;
	let chars = 0;
	const seen = new Set<object>();
	const visit = (item: unknown, depth: number): boolean => {
		if (
			++nodes > PROVIDER_SETTINGS_VALUE_LIMITS.nodes ||
			depth > PROVIDER_SETTINGS_VALUE_LIMITS.depth
		)
			return false;
		if (typeof item === "string") {
			chars += item.length;
			return chars <= maxBytes;
		}
		if (typeof item === "number") return Number.isFinite(item);
		if (typeof item === "boolean") return true;
		if (!item || typeof item !== "object" || Array.isArray(item) || seen.has(item)) return false;
		const prototype = Object.getPrototypeOf(item);
		if (prototype !== null && prototype !== Object.prototype) return false;
		seen.add(item);
		const keys = Reflect.ownKeys(item);
		if (keys.length > PROVIDER_SETTINGS_VALUE_LIMITS.fields) return false;
		for (const key of keys) {
			if (
				typeof key !== "string" ||
				key === "prototype" ||
				key === "toJSON" ||
				Object.hasOwn(Object.prototype, key)
			)
				return false;
			chars += key.length;
			const property = Object.getOwnPropertyDescriptor(item, key);
			if (
				chars > maxBytes ||
				!property?.enumerable ||
				!("value" in property) ||
				!visit(property.value, depth + 1)
			)
				return false;
		}
		return true;
	};
	return visit(value, 1) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
}

export const providerSettingsValueStringSchema = z
	.string()
	.max(PROVIDER_SETTINGS_VALUE_LIMITS.stringChars * 2)
	.refine(
		(value) => providerSettingsStringLength(value) <= PROVIDER_SETTINGS_VALUE_LIMITS.stringChars,
		"Setting string is too long",
	);
const scalar = z.union([providerSettingsValueStringSchema, z.number(), z.boolean()]);
const secretEdit = z.discriminatedUnion("operation", [
	z.strictObject({ operation: z.literal("keep") }),
	z.strictObject({ operation: z.literal("clear") }),
	z.strictObject({
		operation: z.literal("set"),
		value: providerSettingsValueStringSchema.min(1),
	}),
]);
const saveShape = z.strictObject({
	schemaVersion: z.literal(1),
	schemaFingerprint: providerSettingsFingerprintSchema,
	expectedRevision: providerSettingsRevisionSchema,
	expectedBindingRevision: providerSettingsFingerprintSchema,
	/** Complete replacement of non-secret values. Omitted secret edits mean keep. */
	values: z.record(providerSettingsFieldNameSchema, scalar),
	secrets: z.record(providerSettingsFieldNameSchema, secretEdit),
});
export const providerSettingsSaveSchema = z.preprocess((value, context) => {
	if (isBoundedProviderSettingsData(value, PROVIDER_SETTINGS_VALUE_LIMITS.requestBytes))
		return value;
	context.addIssue({ code: "custom", message: "Invalid provider settings request" });
	return z.NEVER;
}, saveShape);
export type ProviderSettingsSave = z.infer<typeof providerSettingsSaveSchema>;
export type ProviderSettingsSecretEdit = z.infer<typeof secretEdit>;

/** Host-authored DTO; secret contents and binding material never appear in it. */
export interface ProviderSettingsConfigView {
	schemaVersion: number;
	schemaFingerprint: string;
	revision: number;
	bindingRevision: string;
	status: "ready" | "incomplete" | "schema-mismatch" | "binding-changed" | "dormant";
	values: ProviderSettingsValues;
	secrets: Record<string, { isSet: boolean }>;
}

export interface ProviderSettingsExtensionView {
	pluginId: string;
	contributionId: string;
	declaration: ProviderSettingsContribution;
	target: {
		kind: ProviderSettingsTargetKind;
		id: string;
		name: string;
		disabled: boolean;
		available: boolean;
	};
	pluginState?: "disabled" | "enabled" | "uninstalling";
	compatible?: boolean;
	config?: ProviderSettingsConfigView;
	unavailable?: boolean;
}
