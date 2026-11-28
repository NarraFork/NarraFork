import { createHash } from "node:crypto";
import { AppError } from "@server/lib/errors";
import { secretRecordKeyId } from "@server/lib/secret-store";
import { providerSettingsTargetKindSchema } from "@shared/provider-settings";
import {
	providerSettingsFingerprintSchema,
	providerSettingsRevisionSchema,
} from "@shared/provider-settings-values";
import { z } from "zod";

export const PLUGIN_SETTINGS_STORE_LIMITS = Object.freeze({
	recordBytes: 64 * 1024,
	configBytes: 48 * 1024,
	resourceBytes: 64 * 1024,
	pluginBytes: 8 * 1024 * 1024,
	resourceCount: 4096,
	settingsCount: 4096,
	page: 50,
	operationMs: 5000,
});
const identifier = z
	.string()
	.min(1)
	.max(256)
	.refine(
		(value) =>
			value === value.trim() &&
			!["__proto__", "prototype", "constructor"].includes(value) &&
			[...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
	);
const pluginId = identifier
	.max(128)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/);
const contributionId = identifier.max(128).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
const settingAddressSchema = z.strictObject({
	pluginId,
	contributionId,
	targetKind: providerSettingsTargetKindSchema,
	targetId: identifier,
});
const resourceAddressSchema = z.strictObject({
	pluginId,
	ownerKind: z.enum(["plugin", "host-projection", "host-migration", "host-operation"]),
	scopeType: z.enum(["plugin", "provider", "credential"]),
	scopeId: identifier,
	key: identifier,
});
export type PluginSettingAddress = z.infer<typeof settingAddressSchema>;
export type PluginResourceAddress = z.infer<typeof resourceAddressSchema>;
export type PluginResourceScope = Omit<PluginResourceAddress, "key">;
export interface PluginSettingRecord extends PluginSettingAddress {
	id: string;
	installationId: string;
	state: "active" | "dormant" | "deleted" | "blocked";
	schemaVersion: number;
	schemaFingerprint: string;
	bindingFingerprint: string;
	revision: number;
	configText: string;
	secretsEnvelope: string | null;
	keyId: string | null;
	createdAt: string;
	updatedAt: string;
}
export type PluginSettingSummary = Omit<PluginSettingRecord, "configText" | "secretsEnvelope">;
export interface PluginResourceRecord extends PluginResourceAddress {
	id: string;
	installationId: string;
	bindingFingerprint: string;
	revision: number;
	state: "active" | "deleted";
	valueText: string;
	bytes: number;
	createdAt: string;
	updatedAt: string;
}
export type PluginResourceSummary = Omit<PluginResourceRecord, "valueText">;
export interface PluginSettingMutation {
	address: PluginSettingAddress;
	expectedRevision: number;
	value: Pick<
		PluginSettingRecord,
		| "installationId"
		| "state"
		| "schemaVersion"
		| "schemaFingerprint"
		| "bindingFingerprint"
		| "configText"
		| "secretsEnvelope"
		| "keyId"
	>;
}
export interface PluginResourceMutation {
	address: PluginResourceAddress;
	expectedRevision: number;
	value: Pick<
		PluginResourceRecord,
		"installationId" | "bindingFingerprint" | "state" | "valueText"
	>;
}
export interface PluginStorePage<T> {
	items: T[];
	nextCursor: string | null;
}
export interface PluginStoreOperation {
	signal?: AbortSignal;
	/** Synchronous host guard rechecked before each bounded statement and commit. */
	assertCurrent?: () => void;
}
/** Host-only data port. Public plugin surfaces must derive all owner/installation/scope values. */
export interface PluginSettingsStore {
	getSetting(
		address: PluginSettingAddress,
		options?: PluginStoreOperation,
	): Promise<PluginSettingRecord | null>;
	listSettings(
		pluginId: string,
		options?: PluginStoreOperation & { cursor?: string; limit?: number },
	): Promise<PluginStorePage<PluginSettingSummary>>;
	getResource(
		address: PluginResourceAddress,
		options?: PluginStoreOperation,
	): Promise<PluginResourceRecord | null>;
	listResources(
		scope: PluginResourceScope,
		options?: PluginStoreOperation & { cursor?: string; limit?: number },
	): Promise<PluginStorePage<PluginResourceSummary>>;
	/** One setting plus receipt, one resource, or an explicit setting move with its source tombstone. */
	commit(
		input: {
			setting?: PluginSettingMutation;
			resource?: PluginResourceMutation;
			retiredSetting?: PluginSettingMutation;
		},
		options?: PluginStoreOperation,
	): Promise<{ setting?: PluginSettingRecord; resource?: PluginResourceRecord }>;
}
export class PluginSettingsStoreError extends AppError {
	constructor(
		code:
			| "PLUGIN_SETTINGS_REVISION_CONFLICT"
			| "PLUGIN_SETTINGS_QUOTA_EXCEEDED"
			| "PLUGIN_SETTINGS_STORE_INVALID"
			| "PLUGIN_SETTINGS_STORE_UNAVAILABLE"
			| "PLUGIN_SETTINGS_DEADLINE",
	) {
		super(
			"Plugin data operation could not be completed",
			code === "PLUGIN_SETTINGS_STORE_INVALID"
				? 400
				: code === "PLUGIN_SETTINGS_REVISION_CONFLICT"
					? 409
					: code === "PLUGIN_SETTINGS_QUOTA_EXCEEDED"
						? 413
						: 503,
			code,
		);
	}
}
function invalid(): never {
	throw new PluginSettingsStoreError("PLUGIN_SETTINGS_STORE_INVALID");
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	return result.success ? result.data : invalid();
}
export function parseSettingAddress(value: unknown): PluginSettingAddress {
	return parse(settingAddressSchema, value);
}
export function parseResourceAddress(value: unknown): PluginResourceAddress {
	return parse(resourceAddressSchema, value);
}
export function parseStorePluginId(value: unknown): string {
	return parse(pluginId, value);
}
export function settingRowId(address: PluginSettingAddress): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"setting",
				address.pluginId,
				address.contributionId,
				address.targetKind,
				address.targetId,
			]),
		)
		.digest("hex");
}
export function resourceRowId(address: PluginResourceAddress): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"resource",
				address.pluginId,
				address.ownerKind,
				address.scopeType,
				address.scopeId,
				address.key,
			]),
		)
		.digest("hex");
}
function boundedText(value: unknown, maxBytes: number): string {
	if (typeof value !== "string" || value.length > maxBytes || Buffer.byteLength(value) > maxBytes)
		invalid();
	return value;
}
const settingValueSchema = z.strictObject({
	installationId: identifier,
	state: z.enum(["active", "dormant", "deleted", "blocked"]),
	schemaVersion: z
		.number()
		.int()
		.min(1)
		.max(2 ** 31 - 1),
	schemaFingerprint: providerSettingsFingerprintSchema,
	bindingFingerprint: providerSettingsFingerprintSchema,
	configText: z.string(),
	secretsEnvelope: z.string().nullable(),
	keyId: providerSettingsFingerprintSchema.nullable(),
});
const resourceValueSchema = z.strictObject({
	installationId: identifier,
	bindingFingerprint: providerSettingsFingerprintSchema,
	state: z.enum(["active", "deleted"]),
	valueText: z.string(),
});
export function prepareSettingMutation(input: PluginSettingMutation): PluginSettingMutation {
	const address = parseSettingAddress(input.address),
		expectedRevision = parse(providerSettingsRevisionSchema, input.expectedRevision),
		value = parse(settingValueSchema, input.value);
	boundedText(value.configText, PLUGIN_SETTINGS_STORE_LIMITS.configBytes);
	if ((value.secretsEnvelope === null) !== (value.keyId === null)) invalid();
	if (value.secretsEnvelope !== null) {
		boundedText(value.secretsEnvelope, PLUGIN_SETTINGS_STORE_LIMITS.recordBytes);
		try {
			if (secretRecordKeyId(value.secretsEnvelope) !== value.keyId) invalid();
		} catch {
			return invalid();
		}
	}
	if (
		Buffer.byteLength(value.configText) + Buffer.byteLength(value.secretsEnvelope ?? "") >
		PLUGIN_SETTINGS_STORE_LIMITS.recordBytes
	)
		invalid();
	if (value.state === "deleted" && (value.configText !== "" || value.secretsEnvelope !== null))
		invalid();
	if (value.state !== "deleted" && !value.configText) invalid();
	return { address, expectedRevision, value };
}
export function prepareResourceMutation(input: PluginResourceMutation): PluginResourceMutation {
	const address = parseResourceAddress(input.address),
		expectedRevision = parse(providerSettingsRevisionSchema, input.expectedRevision),
		value = parse(resourceValueSchema, input.value);
	boundedText(value.valueText, PLUGIN_SETTINGS_STORE_LIMITS.resourceBytes);
	if (value.state === "deleted" && value.valueText !== "") invalid();
	return { address, expectedRevision, value };
}
export function storePageOptions(input: { cursor?: string; limit?: number } = {}): {
	cursor: string;
	limit: number;
} {
	const limit = input.limit ?? PLUGIN_SETTINGS_STORE_LIMITS.page,
		cursor = input.cursor ?? "";
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > PLUGIN_SETTINGS_STORE_LIMITS.page ||
		(cursor !== "" && !providerSettingsFingerprintSchema.safeParse(cursor).success)
	)
		invalid();
	return { cursor, limit };
}
export function operationGuard(options: PluginStoreOperation = {}): {
	signal: AbortSignal;
	close: () => void;
	check: () => void;
} {
	const controller = new AbortController(),
		timeout = setTimeout(
			() => controller.abort(new PluginSettingsStoreError("PLUGIN_SETTINGS_DEADLINE")),
			PLUGIN_SETTINGS_STORE_LIMITS.operationMs,
		);
	const signal = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	const deadline = Date.now() + PLUGIN_SETTINGS_STORE_LIMITS.operationMs;
	return {
		signal,
		close: () => clearTimeout(timeout),
		check: () => {
			signal.throwIfAborted();
			options.assertCurrent?.();
			if (Date.now() >= deadline) throw new PluginSettingsStoreError("PLUGIN_SETTINGS_DEADLINE");
		},
	};
}
