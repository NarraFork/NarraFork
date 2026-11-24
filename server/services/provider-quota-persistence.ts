import { existsSync, readFileSync, statSync } from "node:fs";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import {
	createPersistedCredentialCache,
	type PersistedCredentialCache,
} from "@server/lib/persisted-credential-cache";
import { providerQuotaDataSchema, QUOTA_MAX_SNAPSHOT_BYTES } from "@shared/provider-quota";
import { z } from "zod";

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 256;
const FILE_NAME = "provider-quota-cache.json";
const persistedSchema = z
	.object({
		sourceId: z.string().max(256),
		sourceRevision: z.string().max(256),
		status: z.enum(["supported", "unsupported"]),
		data: providerQuotaDataSchema.nullable(),
		cursor: z.string().max(2_048).optional(),
		fetchedAt: z.number().finite().nonnegative(),
		attemptedAt: z.number().finite().nonnegative(),
	})
	.strict();

export type PersistedProviderQuota = z.infer<typeof persistedSchema>;
export function parsePersistedProviderQuota(raw: unknown): PersistedProviderQuota | null {
	const result = persistedSchema.safeParse(raw);
	if (!result.success || Buffer.byteLength(JSON.stringify(result.data)) > QUOTA_MAX_SNAPSHOT_BYTES)
		return null;
	if (result.data.status === "supported" && result.data.data === null) return null;
	return result.data;
}

/**
 * The shared store supplies HMAC identity checks and asynchronous atomic writes. This wrapper
 * enforces the *write* byte budget too, without changing any platform cache's behaviour.
 */
export function createProviderQuotaPersistence(): PersistedCredentialCache<PersistedProviderQuota> {
	const store = createPersistedCredentialCache(FILE_NAME, parsePersistedProviderQuota);
	const sizes = new Map<string, number>();
	let loaded = false;
	const bytesFor = (key: string, value: unknown) =>
		Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(JSON.stringify(key)) + 192;
	const loadBudget = () => {
		if (loaded) return;
		loaded = true;
		try {
			const path = getNarraforkPath(FILE_NAME);
			if (!existsSync(path) || statSync(path).size > MAX_BYTES) return;
			const file = JSON.parse(readFileSync(path, "utf-8")) as {
				version?: unknown;
				salt?: unknown;
				entries?: Record<string, unknown>;
			};
			if (
				file.version !== 1 ||
				typeof file.salt !== "string" ||
				!/^[a-f0-9]{32,128}$/.test(file.salt) ||
				!file.entries ||
				typeof file.entries !== "object"
			)
				return;
			// Match the shared reader's accepted set exactly: invalid/missing fingerprint
			// rows do not consume its 256-entry budget. Raw metadata counts towards bytes.
			let accepted = 0;
			for (const [key, raw] of Object.entries(file.entries)) {
				if (accepted >= MAX_ENTRIES) break;
				if (!raw || typeof raw !== "object") continue;
				const entry = raw as { fingerprint?: unknown; savedAt?: unknown; value?: unknown };
				if (typeof entry.fingerprint !== "string") continue;
				accepted++;
				if (key.length > 256 || !parsePersistedProviderQuota(entry.value)) {
					store.remove(key);
					continue;
				}
				sizes.set(
					key,
					Buffer.byteLength(
						JSON.stringify({
							[key]: {
								fingerprint: entry.fingerprint,
								savedAt: typeof entry.savedAt === "number" ? entry.savedAt : 0,
								value: entry.value,
							},
						}),
					),
				);
			}
		} catch {
			// Corrupt caches remain unknown; the shared store rebuilds on the next write.
		}
	};
	const trim = () => {
		let total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
		while (sizes.size > MAX_ENTRIES || total > MAX_BYTES - 4_096) {
			const oldest = sizes.entries().next().value;
			if (!oldest) break;
			const [key, size] = oldest;
			sizes.delete(key);
			store.remove(key);
			total -= size;
		}
	};
	return {
		restore(key, identity) {
			loadBudget();
			trim();
			return store.restore(key, identity);
		},
		save(key, identity, value) {
			loadBudget();
			if (key.length > 256 || !parsePersistedProviderQuota(value)) return;
			sizes.delete(key);
			sizes.set(key, bytesFor(key, value));
			trim();
			if (sizes.has(key)) store.save(key, identity, value);
		},
		remove(key) {
			loadBudget();
			sizes.delete(key);
			store.remove(key);
		},
		flush: () => store.flush(),
	};
}
