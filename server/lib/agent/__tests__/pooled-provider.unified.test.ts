import { afterAll, expect, test } from "bun:test";
import { seedUnifiedCredentials } from "../../../../tests/unified-credentials";
import { getProviderKeyStore, resetProviderKeyStoreForTests } from "../../provider-keys";
import { PooledProvider, resetProviderKeyRuntimeForTests } from "../pooled-provider";
import type { ProviderAdapter } from "../provider";

const credentials = seedUnifiedCredentials();
const owner = "unified-pool-boundary";
afterAll(() => {
	getProviderKeyStore().removeProvider(owner);
	resetProviderKeyRuntimeForTests();
});

test("a rebuilt unified pool selects the persisted key and network identity", async () => {
	const store = getProviderKeyStore();
	const first = store.add(owner, { apiKey: "first-unified-key" });
	const second = store.add(owner, {
		apiKey: "second-unified-key",
		network: { extraHeaders: { "X-Key": "second" } },
	});
	store.update(first.id, { disabled: true });
	store.reorder(owner, [second.id, first.id]);
	resetProviderKeyStoreForTests();
	expect(getProviderKeyStore().list(owner)).toEqual([
		expect.objectContaining({ id: second.id, network: second.network }),
		expect.objectContaining({ id: first.id, disabled: true }),
	]);
	const pool = new PooledProvider(
		owner,
		(key): ProviderAdapter => ({
			formatTools: () => [],
			buildHistory: async () => ({ history: [] }) as never,
			injectSystemPrompt: () => {},
			async *chat() {},
			generate: async () => key.apiKey,
			generateWithHistory: async () => key.apiKey,
			generateWithMeta: async () => ({
				text: key.network?.extraHeaders?.["X-Key"] ?? "wrong key",
			}),
		}),
	);
	expect(await pool.generateWithMeta("hello", "model")).toEqual({
		text: "second",
		credentialId: second.id,
	});
	expect(credentials.written()).toBe(true);
});
