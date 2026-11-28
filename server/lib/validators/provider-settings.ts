import { providerSettingsTargetKindSchema } from "@shared/provider-settings";
import {
	providerSettingsFingerprintSchema,
	providerSettingsRevisionSchema,
} from "@shared/provider-settings-values";
import { z } from "zod";
import { contributionIdSchema, pluginIdSchema } from "../plugins/manifest";

export const providerSettingsTargetQuerySchema = z.strictObject({
	kind: providerSettingsTargetKindSchema,
	id: z.string().min(1).max(256),
});
export const providerSettingsRetainedQuerySchema = providerSettingsTargetQuerySchema.extend({
	cursor: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});
export const providerSettingsAddressParamsSchema = z.strictObject({
	pluginId: pluginIdSchema,
	contributionId: contributionIdSchema,
});
export const providerSettingsDeleteSchema = z.strictObject({
	expectedRevision: providerSettingsRevisionSchema,
});
export const providerSettingsRebindSchema = z.strictObject({
	expectedRevision: providerSettingsRevisionSchema,
	schemaFingerprint: providerSettingsFingerprintSchema,
	expectedBindingRevision: providerSettingsFingerprintSchema,
	source: z
		.strictObject({
			targetId: z.string().min(1).max(256),
			expectedRevision: providerSettingsRevisionSchema,
		})
		.optional(),
});
