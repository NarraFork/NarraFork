/**
 * API keys of a multi-credential source group (admin only, like the group config).
 *
 * Changes apply immediately, outside the settings draft. The provider's first key is
 * also what settings shows as its API key, so a change to the first key or the order
 * is reflected there too (see settings/provider-keys-projection.ts).
 */
import { isDeepStrictEqual } from "node:util";
import {
	CredentialNetworkError,
	normalizeCredentialNetwork,
	publicCredentialNetwork,
	restoreMaskedProxy,
} from "@shared/credential-network";
import { Hono } from "hono";
import { z } from "zod";
import { clearKeyCooldown, keyCooldown } from "../lib/agent/pooled-provider";
import { maskSecret } from "../lib/auth-settings";
import { AppError, zodValidationError } from "../lib/errors";
import {
	isKimiCustomApiProvider,
	purgeKimiUsageCache,
	refreshKimiKeyUsage,
} from "../lib/kimi-usage-cache";
import { isOpencodeCustomApiProvider, refreshOpencodeKeyUsage } from "../lib/opencode-usage-cache";
import {
	COMMAND_CODE_KEY_OWNER,
	getProviderKeyStore,
	keyOwnerGroup,
	nugKeyOwner,
	type ProviderKey,
	TOKENDANCE_KEY_OWNER,
} from "../lib/provider-keys";
import { saveSettings, settings } from "../lib/settings";
import { quotaStore, STREAM_QUOTA_SOURCE } from "../lib/sourcing/quota-store";
import { getSourceGroup, type SourceGroupView } from "../lib/sourcing/source-groups";
import { getServiceTemplate } from "../lib/sourcing/templates";
import { requireAdmin } from "../middleware/auth";

export const providerKeyRoutes = new Hono();
providerKeyRoutes.use("*", requireAdmin);

function publicKey(key: ProviderKey) {
	return {
		id: key.id,
		label: key.label ?? null,
		masked: maskSecret(key.apiKey),
		priority: key.priority,
		disabled: !!key.disabled,
		disabledReason: key.disabledReason ?? null,
		network: publicCredentialNetwork(key.network),
		cooldown: keyCooldown(key.id) ?? null,
	};
}

function providerOr404(providerId: string) {
	const group = getSourceGroup(providerId);
	const template = group && getServiceTemplate(group.templateId);
	if (!group || !template?.multiCredential || !template.authKinds.includes("api_key")) {
		throw new AppError("Provider not found", 404, "NOT_FOUND");
	}
	return group;
}

/** Keep the old facade's owner spelling until S5; unified stores map it to the group. */
function keyOwner(group: SourceGroupView): string {
	if (group.templateId === "nug") return nugKeyOwner(group.id);
	if (group.templateId === "tokendance") return TOKENDANCE_KEY_OWNER;
	if (group.templateId === "command-code") return COMMAND_CODE_KEY_OWNER;
	return group.id;
}

function keyOr404(id: string) {
	const key = getProviderKeyStore().get(id);
	if (!key) throw new AppError("Key not found", 404, "NOT_FOUND");
	// Search keys, group secrets and orphaned keys are not inference pool credentials.
	providerOr404(keyOwnerGroup(key.providerId));
	return key;
}

function assertUniqueKey(groupId: string, apiKey: string, exceptId?: string): void {
	if (
		getProviderKeyStore()
			.listGroup(groupId)
			.some((k) => k.id !== exceptId && k.apiKey === apiKey)
	) {
		throw new AppError("This key is already added", 409, "KEY_DUPLICATE");
	}
}

function refreshUsage(providerId: string, keyId: string): Promise<unknown> {
	const provider = settings.customApiProviders?.find((p) => p.id === providerId);
	if (provider && isKimiCustomApiProvider(provider)) return refreshKimiKeyUsage(keyId);
	if (provider && isOpencodeCustomApiProvider(provider)) return refreshOpencodeKeyUsage(keyId);
	return Promise.resolve();
}

/** API keys never carry a device id; the rest follows the shared network rules. */
function parseNetwork(input: unknown) {
	if (input === null) return null;
	const { deviceId: _ignored, ...network } = normalizeCredentialNetwork(input);
	return network;
}

const addSchema = z.object({
	apiKey: z.string().trim().min(1).max(4000),
	label: z.string().trim().max(80).optional(),
});
const updateSchema = z.object({
	apiKey: z.string().trim().min(1).max(4000).optional(),
	label: z.string().trim().max(80).optional(),
	disabled: z.boolean().optional(),
	network: z.unknown().optional(),
});
const orderSchema = z.object({ ids: z.array(z.string().min(1).max(100)).max(500) });

providerKeyRoutes.get("/:providerId", (c) => {
	const providerId = c.req.param("providerId");
	providerOr404(providerId);
	return c.json({ keys: getProviderKeyStore().listGroup(providerId).map(publicKey) });
});

providerKeyRoutes.post("/:providerId", async (c) => {
	const providerId = c.req.param("providerId");
	const group = providerOr404(providerId);
	const parsed = addSchema.safeParse(await c.req.json());
	if (!parsed.success) throw zodValidationError(parsed.error);
	assertUniqueKey(providerId, parsed.data.apiKey);
	const store = getProviderKeyStore();
	// Singleton views exist before their optional settings holder. Persist the holder
	// first so adding a key can hydrate it, and a later draft save cannot clear it.
	if (group.templateId === "tokendance" && !settings.tokendance) {
		saveSettings({
			...settings,
			tokendance: { apiKey: store.firstGroupKey(group.id) ?? "", disabled: false, generation: 0 },
		});
	} else if (group.templateId === "command-code" && !settings.commandCode) {
		saveSettings({ ...settings, commandCode: { apiKey: store.firstGroupKey(group.id) ?? "" } });
	}
	const key = store.add(keyOwner(group), parsed.data);
	void refreshUsage(providerId, key.id).catch(() => {});
	return c.json({ key: publicKey(key) });
});

providerKeyRoutes.patch("/key/:id", async (c) => {
	const key = keyOr404(c.req.param("id"));
	const parsed = updateSchema.safeParse(await c.req.json());
	if (!parsed.success) throw zodValidationError(parsed.error);
	const { network, ...fields } = parsed.data;
	if (fields.apiKey !== undefined) {
		assertUniqueKey(keyOwnerGroup(key.providerId), fields.apiKey, key.id);
	}
	let next: ReturnType<typeof parseNetwork> | undefined;
	try {
		next = network === undefined ? undefined : parseNetwork(network);
	} catch (error) {
		if (!(error instanceof CredentialNetworkError)) throw error;
		return c.json({ error: error.message, code: "INVALID_NETWORK", field: error.field }, 400);
	}
	const networkValue = next && restoreMaskedProxy(next, key.network);
	const secretChanged = fields.apiKey !== undefined && fields.apiKey !== key.apiKey;
	const networkChanged =
		next !== undefined && !isDeepStrictEqual(networkValue ?? {}, key.network ?? {});
	const updated = getProviderKeyStore().update(key.id, {
		...fields,
		...(next === undefined ? {} : { network: networkValue }),
	});
	// A changed secret or route is a fresh start: forget failures and stale usage.
	if (secretChanged || networkChanged || fields.disabled === false) {
		clearKeyCooldown(key.id);
		if (secretChanged || networkChanged) {
			purgeKimiUsageCache([key.id]);
			quotaStore.remove(key.id);
			quotaStore.remove(key.id, STREAM_QUOTA_SOURCE);
		}
		void refreshUsage(key.providerId, key.id).catch(() => {});
	}
	return c.json({ key: publicKey(updated) });
});

providerKeyRoutes.delete("/key/:id", (c) => {
	const key = keyOr404(c.req.param("id"));
	getProviderKeyStore().remove(key.id);
	clearKeyCooldown(key.id);
	purgeKimiUsageCache([]);
	quotaStore.remove(key.id);
	quotaStore.remove(key.id, STREAM_QUOTA_SOURCE);
	return c.json({ ok: true });
});

providerKeyRoutes.put("/:providerId/order", async (c) => {
	const providerId = c.req.param("providerId");
	const group = providerOr404(providerId);
	const parsed = orderSchema.safeParse(await c.req.json());
	if (!parsed.success) throw zodValidationError(parsed.error);
	const keys = getProviderKeyStore().listGroup(providerId);
	const ids = new Set(parsed.data.ids);
	if (
		ids.size !== parsed.data.ids.length ||
		[...ids].some((id) => !keys.some((k) => k.id === id))
	) {
		throw new AppError("Order contains duplicate or foreign keys", 400, "INVALID_KEY_ORDER");
	}
	getProviderKeyStore().reorder(keyOwner(group), parsed.data.ids);
	return c.json({ keys: getProviderKeyStore().listGroup(providerId).map(publicKey) });
});
