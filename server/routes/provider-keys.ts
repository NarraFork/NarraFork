/**
 * The keys of a custom API provider (admin only, like the provider config itself).
 *
 * Changes apply immediately, outside the settings draft. The provider's first key is
 * also what settings shows as its API key, so a change to the first key or the order
 * is reflected there too (see settings/provider-keys-projection.ts).
 */
import {
	CredentialNetworkError,
	normalizeCredentialNetwork,
	publicCredentialNetwork,
	restoreMaskedProxy,
} from "@shared/credential-network";
import { Hono } from "hono";
import { z } from "zod";
import { clearKeyCooldown, keyCooldown } from "../lib/agent/pooled-provider";
import { AppError, zodValidationError } from "../lib/errors";
import {
	getKimiKeyUsages,
	isKimiCustomApiProvider,
	type KimiUsageWindow,
	purgeKimiUsageCache,
	refreshKimiKeyUsage,
} from "../lib/kimi-usage-cache";
import {
	getOpencodeKeyUsages,
	isOpencodeCustomApiProvider,
	type OpencodeUsageWindow,
	refreshOpencodeKeyUsage,
} from "../lib/opencode-usage-cache";
import { getProviderKeyStore, type ProviderKey } from "../lib/provider-keys";
import { settings } from "../lib/settings";
import { requireAdmin } from "../middleware/auth";

export const providerKeyRoutes = new Hono();
providerKeyRoutes.use("*", requireAdmin);

/** One allowance window, the same shape for every provider family. */
export interface KeyUsageWindow {
	/** "5h", "weekly", "monthly", or the upstream's own label. */
	label: string;
	/** 0..1, when known. */
	usedRatio: number | null;
	resetsAt: string | null;
}

function kimiWindow(label: string, w: KimiUsageWindow | null): KeyUsageWindow | null {
	if (!w) return null;
	const ratio =
		w.limit && w.limit > 0 && w.used != null
			? w.used / w.limit
			: w.limit && w.limit > 0 && w.remaining != null
				? 1 - w.remaining / w.limit
				: null;
	return { label, usedRatio: ratio, resetsAt: w.resetTime };
}

function opencodeWindow(label: string, w: OpencodeUsageWindow | null): KeyUsageWindow | null {
	if (!w) return null;
	return { label, usedRatio: w.percent == null ? null : w.percent / 100, resetsAt: w.resetsAt };
}

function usageOf(providerId: string, keyId: string) {
	const provider = settings.customApiProviders?.find((p) => p.id === providerId);
	if (!provider) return undefined;
	if (isKimiCustomApiProvider(provider)) {
		const cache = getKimiKeyUsages()[keyId];
		if (!cache) return undefined;
		return {
			fetchedAt: cache.fetchedAt,
			error: cache.error,
			windows: [
				kimiWindow("5h", cache.fiveHour),
				kimiWindow("weekly", cache.weekly),
				kimiWindow("monthly", cache.monthly),
				...cache.extraWindows.map((w) => kimiWindow(w.label, w)),
			].filter((w): w is KeyUsageWindow => !!w),
		};
	}
	if (isOpencodeCustomApiProvider(provider)) {
		const cache = getOpencodeKeyUsages()[keyId];
		if (!cache) return undefined;
		return {
			fetchedAt: cache.fetchedAt,
			error: cache.error,
			windows: [
				opencodeWindow("5h", cache.rolling),
				opencodeWindow("weekly", cache.weekly),
				opencodeWindow("monthly", cache.monthly),
			].filter((w): w is KeyUsageWindow => !!w),
		};
	}
	return undefined;
}

function maskKey(apiKey: string): string {
	return apiKey.length > 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : "…";
}

function publicKey(key: ProviderKey) {
	return {
		id: key.id,
		label: key.label ?? null,
		masked: maskKey(key.apiKey),
		priority: key.priority,
		disabled: !!key.disabled,
		disabledReason: key.disabledReason ?? null,
		network: publicCredentialNetwork(key.network),
		cooldown: keyCooldown(key.id) ?? null,
		usage: usageOf(key.providerId, key.id) ?? null,
	};
}

function providerOr404(providerId: string) {
	const provider = settings.customApiProviders?.find((p) => p.id === providerId);
	if (!provider) throw new AppError("Provider not found", 404, "NOT_FOUND");
	return provider;
}

function keyOr404(id: string) {
	const key = getProviderKeyStore().get(id);
	if (!key) throw new AppError("Key not found", 404, "NOT_FOUND");
	return key;
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
	return c.json({ keys: getProviderKeyStore().list(providerId).map(publicKey) });
});

providerKeyRoutes.post("/:providerId", async (c) => {
	const providerId = c.req.param("providerId");
	providerOr404(providerId);
	const parsed = addSchema.safeParse(await c.req.json());
	if (!parsed.success) throw zodValidationError(parsed.error);
	const store = getProviderKeyStore();
	if (store.list(providerId).some((key) => key.apiKey === parsed.data.apiKey)) {
		throw new AppError("This key is already added", 409, "KEY_DUPLICATE");
	}
	const key = store.add(providerId, parsed.data);
	void refreshUsage(providerId, key.id).catch(() => {});
	return c.json({ key: publicKey(key) });
});

providerKeyRoutes.patch("/key/:id", async (c) => {
	const key = keyOr404(c.req.param("id"));
	const parsed = updateSchema.safeParse(await c.req.json());
	if (!parsed.success) throw zodValidationError(parsed.error);
	const { network, ...fields } = parsed.data;
	let next: ReturnType<typeof parseNetwork> | undefined;
	try {
		next = network === undefined ? undefined : parseNetwork(network);
	} catch (error) {
		if (!(error instanceof CredentialNetworkError)) throw error;
		return c.json({ error: error.message, code: "INVALID_NETWORK", field: error.field }, 400);
	}
	const updated = getProviderKeyStore().update(key.id, {
		...fields,
		...(next === undefined ? {} : { network: next && restoreMaskedProxy(next, key.network) }),
	});
	// A changed secret or route is a fresh start: forget failures and stale usage.
	if (fields.apiKey !== undefined || next !== undefined || fields.disabled === false) {
		clearKeyCooldown(key.id);
		if (fields.apiKey !== undefined || next !== undefined) purgeKimiUsageCache([key.id]);
		void refreshUsage(key.providerId, key.id).catch(() => {});
	}
	return c.json({ key: publicKey(updated) });
});

providerKeyRoutes.delete("/key/:id", (c) => {
	const key = keyOr404(c.req.param("id"));
	getProviderKeyStore().remove(key.id);
	clearKeyCooldown(key.id);
	purgeKimiUsageCache([]);
	return c.json({ ok: true });
});

providerKeyRoutes.put("/:providerId/order", async (c) => {
	const providerId = c.req.param("providerId");
	providerOr404(providerId);
	const parsed = orderSchema.safeParse(await c.req.json());
	if (!parsed.success) throw zodValidationError(parsed.error);
	getProviderKeyStore().reorder(providerId, parsed.data.ids);
	return c.json({ keys: getProviderKeyStore().list(providerId).map(publicKey) });
});

/** Re-read every key's allowance (Kimi Code, OpenCode Go); waits for the answers. */
providerKeyRoutes.post("/:providerId/usage/refresh", async (c) => {
	const providerId = c.req.param("providerId");
	providerOr404(providerId);
	const keys = getProviderKeyStore().list(providerId);
	await Promise.allSettled(keys.map((key) => refreshUsage(providerId, key.id)));
	return c.json({ keys: getProviderKeyStore().list(providerId).map(publicKey) });
});
