import { createHash } from "node:crypto";
import { AppError } from "@server/lib/errors";
import { resolveProxyForUrl } from "@server/lib/net/proxy";
import { getProviderKeyStore, withProviderKey } from "@server/lib/provider-keys";
import { settings } from "@server/lib/settings";
import type { ProxyOverride } from "@server/lib/settings/types";
import type { ProviderSettingsTargetKind } from "@shared/provider-settings";
import { pluginProviderRegistry } from "./plugin-provider-registry";
import type { ProviderSettingsConfigContext } from "./provider-settings-config-policy";
import { normalizeProviderSettingsRoot } from "./provider-settings-config-policy";
import {
	PROVIDER_SETTINGS_SINGLETON_IDS,
	type ProviderSettingsTarget,
	providerSettingsTargets,
} from "./provider-settings-targets";

export interface ProviderSettingsCoreContext {
	target: ProviderSettingsTarget;
	identityRevision: string;
	providerRoot?: string;
	providerKey?: string;
	resolveProxy: (url: string) => string | undefined;
	tlsRejectUnauthorized?: boolean;
}
function unavailable(): never {
	throw new AppError(
		"Saved provider settings target is unavailable",
		409,
		"PROVIDER_SETTINGS_TARGET_UNAVAILABLE",
	);
}
/** Only the host calls this; returned connection material must never be used as a DTO. */
export function readProviderSettingsCoreContext(
	kind: ProviderSettingsTargetKind,
	id: string,
): ProviderSettingsCoreContext {
	const resolved = providerSettingsTargets.resolve(kind, id);
	if (!("target" in resolved)) return unavailable();
	let providerRoot: string | undefined,
		providerKey: string | undefined,
		proxy: ProxyOverride | undefined,
		tlsRejectUnauthorized: boolean | undefined;
	let identity: unknown = [kind, id];
	if (kind === "custom-api") {
		const provider = settings.customApiProviders?.find((value) => value.id === id);
		if (!provider) return unavailable();
		const keyStore = getProviderKeyStore();
		if (!keyStore.readable) return unavailable();
		const keys = keyStore.list(id);
		if (keys.length > 1024) return unavailable();
		const key = keys.find((value) => !value.disabled),
			connection = key ? withProviderKey(provider, key) : provider;
		providerRoot = normalizeProviderSettingsRoot(provider.baseUrl);
		providerKey = key?.apiKey ?? (keys.length ? undefined : provider.apiKey);
		proxy = connection.proxy;
		tlsRejectUnauthorized = provider.tlsRejectUnauthorized;
		identity = [
			kind,
			id,
			providerRoot,
			provider.protocol,
			provider.codexAccountId ?? null,
			providerKey ?? null,
			key?.id ?? null,
			proxy ?? null,
			tlsRejectUnauthorized ?? null,
		];
	} else if (kind === "nug") {
		const provider = settings.nugProviders?.find((value) => value.id === id);
		if (!provider) return unavailable();
		providerRoot = normalizeProviderSettingsRoot(provider.baseUrl);
		providerKey = provider.apiKey;
		proxy = provider.proxy;
		identity = [
			kind,
			id,
			providerRoot,
			providerKey,
			provider.oauthClientSecret ?? null,
			proxy ?? null,
		];
	} else if (kind === "executable-plugin") {
		const provider = pluginProviderRegistry
			.list()
			.find((value) => value.kind === "executable-plugin" && value.providerInstanceId === id);
		if (!provider) return unavailable();
		const config = pluginProviderRegistry.getConfig(id);
		const encoded = JSON.stringify(config);
		if (encoded.length > 32768) return unavailable();
		identity = [kind, id, provider.pluginId, encoded];
	} else {
		// These slots never expose OAuth/core credentials. Persistent identity is
		// independent from the process-local settings revision or unrelated edits.
		const account =
			id === PROVIDER_SETTINGS_SINGLETON_IDS.commandcode
				? (settings.commandCode?.apiKey ?? null)
				: id === PROVIDER_SETTINGS_SINGLETON_IDS.tokendance
					? (settings.tokendance?.apiKey ?? null)
					: null;
		identity = [kind, id, account];
	}
	const encoded = JSON.stringify(identity);
	if (Buffer.byteLength(encoded) > 32768) return unavailable();
	return {
		target: resolved.target,
		identityRevision: createHash("sha256").update(encoded).digest("hex"),
		providerRoot,
		providerKey,
		resolveProxy: (url) => resolveProxyForUrl(url, proxy),
		tlsRejectUnauthorized,
	};
}
export function settingsConfigContext(
	pluginId: string,
	installationId: string,
	core: ProviderSettingsCoreContext,
): ProviderSettingsConfigContext {
	return {
		pluginId,
		installationId,
		target: { kind: core.target.kind, id: core.target.id },
		identityRevision: core.identityRevision,
		providerRoot: core.providerRoot,
	};
}
