import { z } from "zod";
export const PROVIDER_SETTINGS_RPC_LIMITS = Object.freeze({
	references: 128,
	ttlMs: 30000,
	requestMs: 20000,
	requests: 16,
	responseBytes: 256 * 1024,
	actionBytes: 16 * 1024,
});
export const providerSettingsReferenceSchema = z.string().uuid();
export const providerSettingsGetParamsSchema = z.strictObject({
	reference: providerSettingsReferenceSchema,
});
export const providerSettingsConnectionParamsSchema = z.strictObject({
	reference: providerSettingsReferenceSchema,
	connectionId: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/),
});
export const providerSettingsActionResultSchema = z.strictObject({ text: z.string().max(8192) });
export type ProviderSettingsConnectionParams = z.infer<
	typeof providerSettingsConnectionParamsSchema
>;
export type ProviderSettingsActionResult = z.infer<typeof providerSettingsActionResultSchema>;
