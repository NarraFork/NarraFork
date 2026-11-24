/** Sealed unified credentials inside a v3 data export; v1/v2 readers live in legacy-transfer. */
import { type BundleContents, openBundle, sealBundle } from "../lib/credential-transfer/bundle";
import type { CredentialTransferData } from "../lib/credential-transfer/kinds";
import type { ExportedKey, ExportedKeys } from "../lib/sourcing/legacy-transfer";

export const SEALED_KEYS_ENTRY = "provider-keys.sealed.json";
export type { ExportedKey, ExportedKeys };

type ProviderSection = Record<string, unknown>;

/** The provider section as providers.json stores it: same structure, no secret anywhere. */
export function withoutKeys(providers: ProviderSection): ProviderSection {
	const blank = (list: unknown) =>
		Array.isArray(list)
			? list.map((entry) => publicWithoutSecrets(entry as Record<string, unknown>))
			: list;
	const out: ProviderSection = { ...providers };
	if ("customApiProviders" in out) out.customApiProviders = blank(out.customApiProviders);
	if ("nugProviders" in out) out.nugProviders = blank(out.nugProviders);
	if (out.tokendance && typeof out.tokendance === "object") {
		out.tokendance = publicWithoutSecrets(out.tokendance as Record<string, unknown>);
	}
	if (out.commandCode && typeof out.commandCode === "object") {
		out.commandCode = publicWithoutSecrets(out.commandCode as Record<string, unknown>);
	}
	return out;
}

function publicWithoutSecrets(config: Record<string, unknown>): Record<string, unknown> {
	const { quotaAccessToken: _token, oauthClientSecret: _oauthSecret, ...rest } = config;
	return { ...rest, apiKey: "" };
}

/** New data-export entries: one credential or one group-secrets record per item. */
export async function sealProviderTransferItems(
	items: BundleContents["items"],
	passphrase: string,
): Promise<string> {
	return sealBundle({ exportedAt: Date.now(), items }, passphrase);
}

/** Build a real v2 archive for compatibility tests and old-package migration tools. */
export async function sealProviderKeys(keys: ExportedKeys, passphrase: string): Promise<string> {
	return sealBundle(
		{
			exportedAt: Date.now(),
			items: [...keys].map(([owner, list]) => ({
				kind: "provider-keys",
				id: owner,
				label: owner,
				data: list,
			})),
		},
		passphrase,
	);
}

/** Open v3 unified entries, or convert a v2 owner-namespaced payload at the boundary. */
export async function openProviderTransferItems(
	text: string,
	passphrase: string,
	providers: ProviderSection,
): Promise<CredentialTransferData[]> {
	const contents = await openBundle(text, passphrase);
	if (contents.items.some((item) => item.kind === "credential" || item.kind === "group-secrets")) {
		const { asCredentialTransferData } = await import("../lib/credential-transfer/kinds");
		return contents.items
			.filter((item) => item.kind === "credential" || item.kind === "group-secrets")
			.map((item) => asCredentialTransferData(item.data))
			.filter((item): item is CredentialTransferData => item !== null);
	}
	return (await import("../lib/sourcing/legacy-transfer")).legacyProviderTransferItems(
		providers,
		contents.items,
	);
}
