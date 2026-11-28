import { providerSettingsContributionSchema } from "@shared/provider-settings";
import { builtinPluginCatalog, PROVIDER_QUOTA_BUILTIN_ID } from "./builtin-plugin-catalog";

// Verified against the archived cfd067361 distribution, not any package's self-reported identity.
export const LEGACY_QUOTA_PACKAGE_HASH =
	"e5385806c109df55e62a6f6a52cd4e067c5b13646fe6a0e10af9dc219a212f59";
export const QUOTA_SETTINGS_CONTRIBUTION_ID = "site-account";
/** Host-owned legacy descriptor. New releases carry the same declaration in their own manifest. */
export const LEGACY_QUOTA_SETTINGS_DECLARATION = providerSettingsContributionSchema.parse({
	id: QUOTA_SETTINGS_CONTRIBUTION_ID,
	schemaVersion: 1,
	title: "Site account balance",
	i18n: { "zh-CN": { title: "站点账户余额" } },
	targetKinds: ["custom-api"],
	configSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			useSiteAccount: {
				type: "boolean",
				default: false,
				title: "Use site account balance",
				"x-narrafork-i18n": { "zh-CN": { title: "使用站点账户查询余额" } },
			},
			siteUrl: {
				type: "string",
				format: "uri",
				maxLength: 2048,
				title: "Site URL",
				"x-narrafork-i18n": { "zh-CN": { title: "站点地址" } },
			},
			userId: {
				type: "string",
				"x-narrafork-host-only": true,
				maxLength: 128,
				title: "Account ID",
				"x-narrafork-i18n": { "zh-CN": { title: "账户 ID" } },
			},
			token: {
				type: "string",
				writeOnly: true,
				maxLength: 4096,
				title: "Account token",
				"x-narrafork-i18n": { "zh-CN": { title: "账户令牌" } },
			},
		},
	},
	connections: [
		{
			id: "balance",
			destination: "extension",
			method: "GET",
			path: "/api/user/self",
			baseUrlField: "siteUrl",
			auth: { kind: "bearer", secretField: "token" },
			headers: [{ name: "new-api-user", field: "userId" }],
		},
	],
});
export async function isTrustedQuotaSettingsPackage(
	pluginId: string,
	version: string,
	hash: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (pluginId !== PROVIDER_QUOTA_BUILTIN_ID) return false;
	if (version === "1.0.3") return hash === LEGACY_QUOTA_PACKAGE_HASH;
	const definition = builtinPluginCatalog.get(pluginId);
	if (!definition || version !== definition.version) return false;
	const artifact = await definition.load(signal);
	return artifact.packageHash !== undefined && artifact.packageHash === hash;
}
