import { createHmac, randomBytes } from "node:crypto";
import { logger } from "@server/lib/logger";
import type { PersistedCredentialCache } from "@server/lib/persisted-credential-cache";
import { providerQuotaDataSchema, QUOTA_MAX_SNAPSHOT_BYTES } from "@shared/provider-quota";
import { z } from "zod";
import type {
	PluginResourceAddress,
	PluginResourceRecord,
	PluginSettingsStore,
} from "./plugin-settings-store";
import { getPluginSettingsStore } from "./plugin-settings-store-provider";
import { readLegacyQuotaCache } from "./provider-quota-legacy-cache";

const persistedSchema = z
	.object({
		sourceId: z.string().max(256),
		sourceRevision: z.string().max(256),
		status: z.enum(["supported", "unsupported"]),
		data: providerQuotaDataSchema.nullable(),
		cursor: z.string().max(2048).optional(),
		fetchedAt: z.number().finite().nonnegative(),
		attemptedAt: z.number().finite().nonnegative(),
		/** Host migration provenance; never part of the plugin result or public DTO. */
		legacyDisplayOnly: z.literal(true).optional(),
	})
	.strict();
export type PersistedProviderQuota = z.infer<typeof persistedSchema>;
export function parsePersistedProviderQuota(raw: unknown): PersistedProviderQuota | null {
	const result = persistedSchema.safeParse(raw);
	if (
		!result.success ||
		Buffer.byteLength(JSON.stringify(result.data)) > QUOTA_MAX_SNAPSHOT_BYTES ||
		(result.data.status === "supported" && result.data.data === null)
	)
		return null;
	return result.data;
}
export interface ProviderQuotaPersistenceContext {
	pluginId: string;
	installationId: string;
	sourceId: string;
	sourceRevision: string;
	providerId: string;
	credentialId?: string;
	isCurrent?: () => boolean;
}
export interface ProviderQuotaPersistence extends PersistedCredentialCache<PersistedProviderQuota> {
	load(
		key: string,
		identity: string,
		context: ProviderQuotaPersistenceContext,
	): Promise<PersistedProviderQuota | undefined>;
	save(
		key: string,
		identity: string,
		value: PersistedProviderQuota,
		context?: ProviderQuotaPersistenceContext,
	): void;
}
interface Memory {
	identity: string;
	value: PersistedProviderQuota;
	context: ProviderQuotaPersistenceContext;
	bytes: number;
}
const MAX_MEMORY_BYTES = 1024 * 1024,
	MAX_ENTRIES = 256;
function address(context: ProviderQuotaPersistenceContext, cursor = false): PluginResourceAddress {
	return {
		pluginId: context.pluginId,
		ownerKind: cursor ? "plugin" : "host-projection",
		scopeType: context.credentialId ? "credential" : "provider",
		scopeId: JSON.stringify(["custom-api", context.providerId, context.credentialId ?? null]),
		key: `${cursor ? "quota-cursor" : "quota"}:${context.sourceId.slice(context.pluginId.length + 1)}`,
	};
}
function matches(context: ProviderQuotaPersistenceContext, value: PersistedProviderQuota): boolean {
	return value.sourceId === context.sourceId && value.sourceRevision === context.sourceRevision;
}
function validContext(context: ProviderQuotaPersistenceContext): boolean {
	return (
		!!context.installationId &&
		context.installationId.length <= 256 &&
		context.sourceId.startsWith(`${context.pluginId}/`) &&
		context.sourceId.length <= 256 &&
		context.isCurrent?.() !== false
	);
}
export function createProviderQuotaPersistence(
	options: {
		store?: () => Promise<PluginSettingsStore>;
		legacyRead?: typeof readLegacyQuotaCache;
	} = {},
): ProviderQuotaPersistence {
	const memory = new Map<string, Memory>(),
		pending = new Map<string, () => Promise<void>>(),
		epochs = new Map<string, object>(),
		loading = new Map<string, { context: ProviderQuotaPersistenceContext; token: object }>(),
		loadWaiters = new Set<() => void>();
	let draining: Promise<void> | undefined,
		memoryBytes = 0,
		activeLoads = 0;
	const getStore = options.store ?? getPluginSettingsStore,
		legacyRead = options.legacyRead ?? readLegacyQuotaCache;
	const erase = (key: string) => {
		const old = memory.get(key);
		if (old) memoryBytes -= old.bytes;
		memory.delete(key);
	};
	const remember = (
		key: string,
		identity: string,
		value: PersistedProviderQuota,
		context: ProviderQuotaPersistenceContext,
	) => {
		erase(key);
		const bytes = Buffer.byteLength(identity) + Buffer.byteLength(JSON.stringify(value));
		while (memory.size >= MAX_ENTRIES || memoryBytes + bytes > MAX_MEMORY_BYTES) {
			const oldest = memory.keys().next().value;
			if (oldest === undefined) return false;
			erase(oldest);
		}
		memory.set(key, { identity, value, context, bytes });
		memoryBytes += bytes;
		return true;
	};
	const epoch = (key: string) => {
		const token = {};
		epochs.delete(key);
		epochs.set(key, token);
		while (epochs.size > 512) epochs.delete(epochs.keys().next().value as string);
		return token;
	};
	const enqueue = (key: string, task: () => Promise<void>) => {
		if (!pending.has(key) && pending.size >= MAX_ENTRIES) {
			logger.warn("Quota persistence queue is full");
			return;
		}
		pending.set(key, task);
		if (!draining)
			draining = (async () => {
				while (pending.size) {
					const item = pending.entries().next().value;
					if (!item) break;
					pending.delete(item[0]);
					try {
						await item[1]();
					} catch {
						logger.warn("Quota resource persistence did not complete");
					}
				}
			})().finally(() => {
				draining = undefined;
			});
	};
	const tombstone = async (
		store: PluginSettingsStore,
		where: PluginResourceAddress,
		old: PluginResourceRecord | null,
		context: ProviderQuotaPersistenceContext,
		assertCurrent: () => void,
	) => {
		if (old?.state !== "deleted")
			await store.commit(
				{
					resource: {
						address: where,
						expectedRevision: old?.revision ?? 0,
						value: {
							installationId: context.installationId,
							bindingFingerprint: old?.bindingFingerprint ?? "0".repeat(64),
							state: "deleted",
							valueText: "",
						},
					},
				},
				{ assertCurrent },
			);
	};
	const persist = async (
		key: string,
		identity: string,
		value: PersistedProviderQuota,
		context: ProviderQuotaPersistenceContext,
		token: object,
	) => {
		const current = () =>
			epochs.get(key) === token && memory.get(key)?.value === value && validContext(context);
		if (!current()) return;
		const store = await getStore(),
			where = address(context),
			old = await store.getResource(where);
		const salt = randomBytes(32).toString("hex"),
			fingerprint = createHmac("sha256", salt).update(identity).digest("hex");
		if (!current()) return;
		const { cursor, ...projection } = value;
		await store.commit(
			{
				resource: {
					address: where,
					expectedRevision: old?.revision ?? 0,
					value: {
						installationId: context.installationId,
						bindingFingerprint: fingerprint,
						state: "active",
						valueText: JSON.stringify({ version: 1, salt, fingerprint, value: projection }),
					},
				},
			},
			{
				assertCurrent: () => {
					if (!current()) throw Error("Quota persistence identity changed");
				},
			},
		);
		if (!current()) return;
		const cursorAddress = address(context, true),
			previousCursor = await store.getResource(cursorAddress);
		if (!current()) return;
		if (cursor)
			await store.commit(
				{
					resource: {
						address: cursorAddress,
						expectedRevision: previousCursor?.revision ?? 0,
						value: {
							installationId: context.installationId,
							bindingFingerprint: fingerprint,
							state: "active",
							valueText: JSON.stringify({
								cursor,
								sourceRevision: context.sourceRevision,
								fetchedAt: value.fetchedAt,
							}),
						},
					},
				},
				{
					assertCurrent: () => {
						if (!current()) throw Error("Quota cursor identity changed");
					},
				},
			);
		else if (previousCursor)
			await tombstone(store, cursorAddress, previousCursor, context, () => {
				if (!current()) throw Error("Quota cursor identity changed");
			});
	};
	return {
		restore(key, identity) {
			const item = memory.get(key);
			return item?.identity === identity && validContext(item.context)
				? structuredClone(item.value)
				: undefined;
		},
		async load(key, identity, context) {
			if (
				key.length > 256 ||
				Buffer.byteLength(identity) > 32768 ||
				!validContext(context) ||
				activeLoads >= MAX_ENTRIES
			)
				return;
			const token = epoch(key);
			loading.set(key, { context, token });
			activeLoads++;
			try {
				const store = await getStore(),
					where = address(context),
					row = await store.getResource(where);
				let value: PersistedProviderQuota | null = null;
				if (row) {
					if (row.state !== "active" || row.installationId !== context.installationId) return;
					const raw = JSON.parse(row.valueText) as {
						version?: unknown;
						salt?: unknown;
						fingerprint?: unknown;
						value?: unknown;
					};
					if (
						raw.version !== 1 ||
						typeof raw.salt !== "string" ||
						!/^[a-f0-9]{64}$/.test(raw.salt) ||
						raw.fingerprint !== row.bindingFingerprint ||
						createHmac("sha256", raw.salt).update(identity).digest("hex") !== raw.fingerprint
					)
						return;
					value = parsePersistedProviderQuota(raw.value);
					const cursor = await store.getResource(address(context, true));
					if (
						value &&
						cursor?.state === "active" &&
						cursor.installationId === context.installationId &&
						cursor.bindingFingerprint === row.bindingFingerprint
					) {
						const rawCursor = JSON.parse(cursor.valueText);
						if (
							typeof rawCursor.cursor === "string" &&
							rawCursor.cursor.length <= 2048 &&
							rawCursor.sourceRevision === context.sourceRevision &&
							rawCursor.fetchedAt === value.fetchedAt
						)
							value = { ...value, cursor: rawCursor.cursor };
					}
				} else
					value = parsePersistedProviderQuota(await legacyRead(key, identity, undefined, context));
				if (
					!value ||
					!matches(context, value) ||
					!validContext(context) ||
					epochs.get(key) !== token
				)
					return;
				if (!remember(key, identity, value, context)) return;
				if (!row)
					enqueue(key, () =>
						persist(key, identity, value as PersistedProviderQuota, context, token),
					);
				return structuredClone(value);
			} catch {
				return undefined;
			} finally {
				activeLoads--;
				if (loading.get(key)?.token === token) loading.delete(key);
				if (activeLoads === 0) {
					for (const resolve of loadWaiters) resolve();
					loadWaiters.clear();
				}
			}
		},
		save(key, identity, raw, context) {
			const value = parsePersistedProviderQuota(raw);
			if (
				!value ||
				!context ||
				!validContext(context) ||
				!matches(context, value) ||
				key.length > 256 ||
				Buffer.byteLength(identity) > 32768
			)
				return;
			const token = epoch(key);
			if (!remember(key, identity, value, context)) return;
			enqueue(key, () => persist(key, identity, value, context, token));
		},
		remove(key) {
			const contexts = [memory.get(key)?.context, loading.get(key)?.context].filter(
				(context): context is ProviderQuotaPersistenceContext => !!context,
			);
			if (!contexts.length) return;
			const token = epoch(key);
			erase(key);
			loading.delete(key);
			pending.delete(key);
			enqueue(key, async () => {
				const store = await getStore();
				const assertCurrent = () => {
					if (epochs.get(key) !== token) throw Error("Quota deletion identity changed");
				};
				for (const context of contexts) {
					for (const cursor of [false, true]) {
						assertCurrent();
						const where = address(context, cursor),
							old = await store.getResource(where);
						assertCurrent();
						if (!old || old.installationId === context.installationId)
							await tombstone(store, where, old, context, assertCurrent);
					}
				}
			});
		},
		async flush() {
			while (activeLoads || draining) {
				if (activeLoads) await new Promise<void>((resolve) => loadWaiters.add(resolve));
				if (draining) await draining;
			}
		},
	};
}
