import { createHash } from "node:crypto";
import { AppError } from "@server/lib/errors";
import {
	type ProviderSettingsContribution,
	type ProviderSettingsField,
	type ProviderSettingsTargetKind,
	providerSettingsContributionSchema,
	providerSettingsFieldNameSchema,
	providerSettingsFieldVisibility,
	providerSettingsStringLength,
} from "@shared/provider-settings";
import {
	isBoundedProviderSettingsData,
	PROVIDER_SETTINGS_VALUE_LIMITS,
	type ProviderSettingsConfigView,
	type ProviderSettingsValues,
	providerSettingsFingerprintSchema,
	providerSettingsRevisionSchema,
	providerSettingsSaveSchema,
	providerSettingsValueStringSchema,
} from "@shared/provider-settings-values";
import { z } from "zod";

/** Construct only from the live saved target, after the host has checked the caller's authority.
 * identityRevision tracks the core account/root binding, never a draft or a plaintext credential.
 * This pure policy does not resolve targets, authorize a caller, persist data or send requests.
 */
export interface ProviderSettingsConfigContext {
	pluginId: string;
	installationId: string;
	target: { kind: ProviderSettingsTargetKind; id: string } | null;
	identityRevision: string;
	providerRoot?: string;
}
const secretMetadataSchema = z.strictObject({
	binding: providerSettingsFingerprintSchema,
	bytes: z
		.number()
		.int()
		.min(1)
		.max(PROVIDER_SETTINGS_VALUE_LIMITS.stringChars * 4),
	characters: z.number().int().min(1).max(PROVIDER_SETTINGS_VALUE_LIMITS.stringChars),
});
export const providerSettingsStoredConfigSchema = z.strictObject({
	owner: providerSettingsFingerprintSchema,
	schemaVersion: z
		.number()
		.int()
		.min(1)
		.max(2 ** 31 - 1),
	schemaFingerprint: providerSettingsFingerprintSchema,
	revision: providerSettingsRevisionSchema.min(1),
	values: z.record(
		providerSettingsFieldNameSchema,
		z.union([providerSettingsValueStringSchema, z.number(), z.boolean()]),
	),
	/** Authenticated metadata only. Ciphertext is held separately by the atomic storage layer. */
	secrets: z.record(providerSettingsFieldNameSchema, secretMetadataSchema),
});
export type ProviderSettingsStoredConfig = z.infer<typeof providerSettingsStoredConfigSchema>;
export interface ProviderSettingsPreparedSave {
	previousRevision: number;
	config: ProviderSettingsStoredConfig;
	/** Host-private: encrypt and commit with config in the same CAS transaction; never serialize to UI/RPC. */
	secretWrites: Record<string, { operation: "set"; value: string } | { operation: "clear" }>;
}

function fail(code: string, status = 400): never {
	throw new AppError("Provider settings could not be validated", status, code);
}
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function compareIdentity(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
function fingerprint(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function normalizeProviderSettingsRoot(value: string): string {
	if (
		!value ||
		value.length > 2048 ||
		/[\s?#\\]/u.test(value) ||
		!/^https?:\/\/[^/]+(?:\/|$)/i.test(value)
	)
		fail("PROVIDER_SETTINGS_INVALID_DESTINATION");
	// Allow canonical UTF-8 paths, but no escaped ASCII (including slash, dot,
	// control bytes and percent used for double-decoding). Normalize hex casing.
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return fail("PROVIDER_SETTINGS_INVALID_DESTINATION");
	}
	if (
		/%[0-7][0-9a-f]/i.test(value) ||
		[...decoded].some(
			(char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
		)
	)
		fail("PROVIDER_SETTINGS_INVALID_DESTINATION");
	const path = value.replace(/^https?:\/\/[^/]+/i, "");
	if (path.split("/").some((part) => part === "." || part === ".."))
		fail("PROVIDER_SETTINGS_INVALID_DESTINATION");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return fail("PROVIDER_SETTINGS_INVALID_DESTINATION");
	}
	if (url.username || url.password || !["https:", "http:"].includes(url.protocol))
		fail("PROVIDER_SETTINGS_INVALID_DESTINATION");
	const normalized =
		url.origin +
		url.pathname.replace(/\/+$/, "").replace(/%[0-9a-f]{2}/gi, (escaped) => escaped.toUpperCase());
	if (normalized.length > 2048 || /%[0-7][0-9a-f]/i.test(normalized) || /\s/u.test(decoded))
		fail("PROVIDER_SETTINGS_INVALID_DESTINATION");
	return normalized;
}

function semanticField(field: ProviderSettingsField): Record<string, unknown> {
	const {
		title: _title,
		description: _description,
		"x-narrafork-i18n": _i18n,
		...semantic
	} = field;
	return semantic;
}
function validValue(field: ProviderSettingsField, value: unknown): boolean {
	if (field.type === "boolean") return typeof value === "boolean";
	if (field.type === "string")
		return (
			typeof value === "string" &&
			providerSettingsStringLength(value) >= (field.minLength ?? 0) &&
			providerSettingsStringLength(value) <= (field.maxLength ?? 4096) &&
			(!field.enum || field.enum.includes(value))
		);
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		(field.type !== "integer" || Number.isSafeInteger(value)) &&
		value >= (field.minimum ?? -Infinity) &&
		value <= (field.maximum ?? Infinity)
	);
}

/** Pure preparer for the future atomic store and form. No runtime/storage registration. */
export class ProviderSettingsConfigPolicy {
	private readonly declaration: ProviderSettingsContribution;
	readonly schemaFingerprint: string;
	constructor(input: unknown) {
		const parsed = providerSettingsContributionSchema.safeParse(input);
		if (!parsed.success) fail("PROVIDER_SETTINGS_INVALID_DECLARATION");
		this.declaration = parsed.data;
		this.schemaFingerprint = fingerprint({
			id: parsed.data.id,
			schemaVersion: parsed.data.schemaVersion,
			targetKinds: [...parsed.data.targetKinds].sort(),
			properties: Object.fromEntries(
				Object.entries(parsed.data.configSchema.properties).map(([key, field]) => [
					key,
					semanticField(field),
				]),
			),
			required: [...(parsed.data.configSchema.required ?? [])].sort(),
			connections: [...(parsed.data.connections ?? [])].sort((a, b) => compareIdentity(a.id, b.id)),
		});
	}

	private identity(context: ProviderSettingsConfigContext): {
		owner: string;
		bindingRevision: string;
	} {
		if (!context.target) fail("PROVIDER_SETTINGS_TARGET_MISSING", 404);
		if (!this.declaration.targetKinds.includes(context.target.kind))
			fail("PROVIDER_SETTINGS_TARGET_MISMATCH", 409);
		for (const value of [
			context.pluginId,
			context.installationId,
			context.target.id,
			context.identityRevision,
		]) {
			if (
				typeof value !== "string" ||
				!value ||
				value.length > 256 ||
				[...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
			)
				fail("PROVIDER_SETTINGS_INVALID_CONTEXT");
		}
		const owner = fingerprint({
			pluginId: context.pluginId,
			installationId: context.installationId,
			contributionId: this.declaration.id,
			kind: context.target.kind,
			id: context.target.id,
		});
		return {
			owner,
			bindingRevision: fingerprint({
				owner,
				identityRevision: context.identityRevision,
				providerRoot:
					context.providerRoot === undefined
						? null
						: normalizeProviderSettingsRoot(context.providerRoot),
			}),
		};
	}

	private stored(
		input: ProviderSettingsStoredConfig | undefined,
	): ProviderSettingsStoredConfig | undefined {
		if (input === undefined) return undefined;
		if (!isBoundedProviderSettingsData(input, PROVIDER_SETTINGS_VALUE_LIMITS.requestBytes))
			fail("PROVIDER_SETTINGS_DATA_UNAVAILABLE", 409);
		const parsed = providerSettingsStoredConfigSchema.safeParse(input);
		if (!parsed.success) fail("PROVIDER_SETTINGS_DATA_UNAVAILABLE", 409);
		this.assertBudget(parsed.data.values, parsed.data.secrets);
		if (
			parsed.data.schemaVersion === 1 &&
			parsed.data.schemaFingerprint === this.schemaFingerprint
		) {
			for (const [key, metadata] of Object.entries(parsed.data.secrets)) {
				const field = this.declaration.configSchema.properties[key];
				if (
					!field ||
					field.type !== "string" ||
					providerSettingsFieldVisibility(field) !== "secret" ||
					metadata.characters < (field.minLength ?? 0) ||
					metadata.characters > (field.maxLength ?? 4096) ||
					metadata.bytes < metadata.characters ||
					metadata.bytes > metadata.characters * 4
				)
					fail("PROVIDER_SETTINGS_DATA_UNAVAILABLE", 409);
			}
		}
		return parsed.data;
	}

	private values(input: ProviderSettingsValues): ProviderSettingsValues {
		const result: ProviderSettingsValues = {};
		for (const [key, value] of Object.entries(input)) {
			const field = this.declaration.configSchema.properties[key];
			if (
				!field ||
				providerSettingsFieldVisibility(field) === "secret" ||
				!validValue(field, value)
			)
				fail("PROVIDER_SETTINGS_INVALID_VALUES");
			if (field.type === "string" && field.format === "uri") {
				if (value === "") continue;
				const normalized = normalizeProviderSettingsRoot(value as string);
				if (!validValue(field, normalized)) fail("PROVIDER_SETTINGS_INVALID_VALUES");
				result[key] = normalized;
			} else result[key] = value;
		}
		return result;
	}

	private secretBinding(
		context: ProviderSettingsConfigContext,
		key: string,
		values: ProviderSettingsValues,
	): string {
		const rules = (this.declaration.connections ?? []).filter(
			(rule) =>
				rule.destination === "extension" && rule.auth !== "none" && rule.auth.secretField === key,
		);
		const destinations = rules
			.map((rule) => {
				if (rule.destination !== "extension") throw new Error("Unexpected settings destination");
				const root =
					values[rule.baseUrlField] ||
					(rule.whenUrlMissing === "provider-root" ? context.providerRoot : undefined);
				return {
					id: rule.id,
					root: typeof root === "string" ? normalizeProviderSettingsRoot(root) : null,
					path: rule.path,
					headers: (rule.headers ?? [])
						.map((header) => ({ name: header.name, value: values[header.field] ?? null }))
						.sort((a, b) => compareIdentity(a.name, b.name)),
				};
			})
			.sort((a, b) => compareIdentity(a.id, b.id));
		return fingerprint({
			bindingRevision: this.identity(context).bindingRevision,
			schema: this.schemaFingerprint,
			field: key,
			destinations,
		});
	}

	private complete(
		values: ProviderSettingsValues,
		secrets: ProviderSettingsStoredConfig["secrets"],
	): boolean {
		return (this.declaration.configSchema.required ?? []).every(
			(key) => Object.hasOwn(values, key) || Object.hasOwn(secrets, key),
		);
	}

	private assertBudget(
		values: ProviderSettingsValues,
		secrets: ProviderSettingsStoredConfig["secrets"],
	): void {
		const bytes =
			Buffer.byteLength(JSON.stringify(values)) +
			Buffer.byteLength(JSON.stringify(Object.keys(secrets))) +
			Object.values(secrets).reduce((sum, secret) => sum + secret.bytes, 0);
		if (bytes > PROVIDER_SETTINGS_VALUE_LIMITS.combinedBytes)
			fail("PROVIDER_SETTINGS_VALUES_TOO_LARGE", 413);
	}
	private checkRequired(
		values: ProviderSettingsValues,
		secrets: ProviderSettingsStoredConfig["secrets"],
	): void {
		if (!this.complete(values, secrets)) fail("PROVIDER_SETTINGS_REQUIRED_VALUE_MISSING");
	}

	view(
		context: ProviderSettingsConfigContext,
		input?: ProviderSettingsStoredConfig,
	): ProviderSettingsConfigView {
		const { owner, bindingRevision } = this.identity(context);
		const current = this.stored(input);
		const result: ProviderSettingsConfigView = {
			schemaVersion: 1,
			schemaFingerprint: this.schemaFingerprint,
			revision: current?.revision ?? 0,
			bindingRevision,
			status: "ready",
			values: {},
			secrets: {},
		};
		if (current && current.owner !== owner) {
			result.status = "dormant";
			return result;
		}
		if (
			current &&
			(current.schemaVersion !== 1 || current.schemaFingerprint !== this.schemaFingerprint)
		) {
			result.status = "schema-mismatch";
			return result;
		}
		result.values = current
			? this.values(current.values)
			: Object.fromEntries(
					Object.entries(this.declaration.configSchema.properties)
						.filter(
							([, field]) =>
								providerSettingsFieldVisibility(field) === "public" && field.default !== undefined,
						)
						.map(([key, field]) => [key, field.default as string | number | boolean]),
				);
		for (const [key, field] of Object.entries(this.declaration.configSchema.properties)) {
			if (providerSettingsFieldVisibility(field) !== "secret") continue;
			const secret = current?.secrets[key];
			result.secrets[key] = { isSet: secret !== undefined };
			if (secret && secret.binding !== this.secretBinding(context, key, result.values))
				result.status = "binding-changed";
		}
		if (result.status === "ready" && !this.complete(result.values, current?.secrets ?? {}))
			result.status = "incomplete";
		return result;
	}

	publicValues(
		context: ProviderSettingsConfigContext,
		current: ProviderSettingsStoredConfig,
	): ProviderSettingsValues {
		const view = this.view(context, current);
		if (view.status !== "ready") fail("PROVIDER_SETTINGS_CONFIGURATION_UNAVAILABLE", 409);
		return Object.fromEntries(
			Object.entries(view.values).filter(
				([key]) =>
					providerSettingsFieldVisibility(this.declaration.configSchema.properties[key]) ===
					"public",
			),
		);
	}

	prepare(
		context: ProviderSettingsConfigContext,
		input: unknown,
		previous?: ProviderSettingsStoredConfig,
	): ProviderSettingsPreparedSave {
		const identity = this.identity(context);
		const parsed = providerSettingsSaveSchema.safeParse(input);
		if (!parsed.success) fail("PROVIDER_SETTINGS_INVALID_REQUEST");
		const request = parsed.data;
		const current = this.stored(previous);
		if (current && current.owner !== identity.owner)
			fail("PROVIDER_SETTINGS_INSTALLATION_MISMATCH", 409);
		if (request.expectedRevision !== (current?.revision ?? 0))
			fail("PROVIDER_SETTINGS_REVISION_CONFLICT", 409);
		if (
			request.schemaFingerprint !== this.schemaFingerprint ||
			(current &&
				(current.schemaVersion !== 1 || current.schemaFingerprint !== this.schemaFingerprint))
		)
			fail("PROVIDER_SETTINGS_SCHEMA_CHANGED", 409);
		if (request.expectedBindingRevision !== identity.bindingRevision)
			fail("PROVIDER_SETTINGS_BINDING_CHANGED", 409);
		const values = this.values(request.values);
		const secrets: ProviderSettingsStoredConfig["secrets"] = {};
		const secretWrites: ProviderSettingsPreparedSave["secretWrites"] = {};
		for (const key of Object.keys(request.secrets)) {
			const field = this.declaration.configSchema.properties[key];
			if (!field || providerSettingsFieldVisibility(field) !== "secret")
				fail("PROVIDER_SETTINGS_INVALID_SECRET_FIELD");
		}
		for (const [key, field] of Object.entries(this.declaration.configSchema.properties)) {
			if (providerSettingsFieldVisibility(field) !== "secret") continue;
			const edit = request.secrets[key];
			const existing = current?.secrets[key];
			const binding = this.secretBinding(context, key, values);
			if (edit?.operation === "clear") {
				secretWrites[key] = { operation: "clear" };
				continue;
			}
			if (edit?.operation === "set") {
				if (
					!validValue(field, edit.value) ||
					edit.value === "__narrafork_secret_set__" ||
					/^(?:\*{3,}|\u2022{3,})$/u.test(edit.value)
				)
					fail("PROVIDER_SETTINGS_INVALID_SECRET_VALUE");
				secrets[key] = {
					binding,
					bytes: Buffer.byteLength(edit.value),
					characters: providerSettingsStringLength(edit.value),
				};
				secretWrites[key] = { operation: "set", value: edit.value };
			} else if (existing) {
				if (existing.binding !== binding) fail("PROVIDER_SETTINGS_SECRET_REBIND_REQUIRED", 409);
				secrets[key] = { ...existing };
			} else if (edit?.operation === "keep") fail("PROVIDER_SETTINGS_SECRET_NOT_SET", 409);
		}
		this.checkRequired(values, secrets);
		for (const rule of this.declaration.connections ?? []) {
			if (rule.destination !== "extension") continue;
			for (const header of rule.headers ?? []) {
				const value = values[header.field];
				if (
					value !== undefined &&
					(typeof value !== "string" || value.length > 128 || /[^\x20-\x7e]/u.test(value))
				)
					fail("PROVIDER_SETTINGS_INVALID_IDENTITY_HEADER");
			}
			if (rule.auth !== "none") {
				const edit = secretWrites[rule.auth.secretField];
				if (edit?.operation === "set" && /[^\x21-\x7e]/u.test(edit.value))
					fail("PROVIDER_SETTINGS_INVALID_CREDENTIAL_HEADER");
			}
		}
		this.assertBudget(values, secrets);
		const revision = (current?.revision ?? 0) + 1;
		if (!providerSettingsRevisionSchema.safeParse(revision).success)
			fail("PROVIDER_SETTINGS_REVISION_EXHAUSTED", 409);
		return {
			previousRevision: current?.revision ?? 0,
			config: {
				owner: identity.owner,
				schemaVersion: 1,
				schemaFingerprint: this.schemaFingerprint,
				revision,
				values,
				secrets,
			},
			secretWrites,
		};
	}
}
