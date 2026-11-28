import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	COMMAND_CODE_KEY_OWNER,
	getProviderKeyStore,
	nugKeyOwner,
	TOKENDANCE_KEY_OWNER,
} from "../../lib/provider-keys";
import { saveSettings, settings } from "../../lib/settings";
import { quotaStore, STREAM_QUOTA_SOURCE } from "../../lib/sourcing/quota-store";
import { providerKeyRoutes } from "../provider-keys";

const PROVIDER = "routeP";
let saved: typeof settings;
const GROUPS = [PROVIDER, "routeN", "tokendance", "CommandCode"];
const OWNERS = [PROVIDER, nugKeyOwner("routeN"), TOKENDANCE_KEY_OWNER, COMMAND_CODE_KEY_OWNER];

function app(role: "admin" | "user" = "admin") {
	const root = new Hono();
	root.use("*", async (c, next) => {
		c.set("user" as never, { sub: "u1", sid: "s1", role } as never);
		await next();
	});
	root.route("/", providerKeyRoutes);
	root.onError((err, c) =>
		c.json(
			{ code: (err as { code?: string }).code },
			((err as { statusCode?: number }).statusCode ?? 500) as 401,
		),
	);
	return root;
}

const json = (body: unknown) => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

beforeEach(() => {
	saved = structuredClone(settings);
	saveSettings({
		...settings,
		nugProviders: [
			{
				id: "routeN",
				name: "NUG",
				prefix: "route-nug",
				baseUrl: "https://nug.example",
				apiKey: "nug-first-key",
				defaultModel: "m",
			},
		],
		tokendance: { apiKey: "td-first-key", disabled: false, generation: 1 },
		commandCode: { apiKey: "cc-first-key" },
		customApiProviders: [
			{
				id: PROVIDER,
				name: "Relay",
				prefix: "relay",
				apiKey: "sk-relay-first-key",
				baseUrl: "https://relay.example.com/v1",
				defaultModel: "m",
				protocol: "completions-compatible",
			},
		],
	});
});

afterEach(() => {
	for (const groupId of GROUPS) getProviderKeyStore().removeGroup(groupId);
	saveSettings(saved);
});

describe("provider key routes", () => {
	test("list masks secrets; add, reorder and remove change what settings shows", async () => {
		const listed = await (await app().request(`/${PROVIDER}`)).json();
		expect(listed.keys).toHaveLength(1);
		expect(JSON.stringify(listed)).not.toContain("sk-relay-first-key");

		const added = await (
			await app().request(`/${PROVIDER}`, json({ apiKey: "sk-relay-second", label: "two" }))
		).json();
		expect(added.key.label).toBe("two");
		const dup = await app().request(`/${PROVIDER}`, json({ apiKey: "sk-relay-second" }));
		expect(dup.status).toBe(409);

		await app().request(`/${PROVIDER}/order`, {
			...json({ ids: [added.key.id] }),
			method: "PUT",
		});
		expect(settings.customApiProviders?.[0]?.apiKey).toBe("sk-relay-second");

		await app().request(`/key/${added.key.id}`, { method: "DELETE" });
		expect(settings.customApiProviders?.[0]?.apiKey).toBe("sk-relay-first-key");
	});

	test("pool masks match settings placeholders without leaking short secrets", async () => {
		for (const [secret, masked] of [
			["abcd", "****"],
			["sk-long-pool-secret", "********cret"],
		]) {
			const res = await app().request(`/${PROVIDER}`, json({ apiKey: secret }));
			const body = await res.json();
			expect(body.key.masked).toBe(masked);
			expect(JSON.stringify(body)).not.toContain(secret);
		}
	});

	test("network edits are validated, keep a masked proxy password, and drop device ids", async () => {
		const id = PROVIDER;
		const bad = await app().request(`/key/${id}`, {
			...json({ network: { proxy: { mode: "custom", url: "nope" } } }),
			method: "PATCH",
		});
		expect(bad.status).toBe(400);
		expect((await bad.json()).field).toBe("proxy.url");

		const set = await (
			await app().request(`/key/${id}`, {
				...json({
					network: {
						proxy: { mode: "custom", url: "http://u:secret@proxy:8080" },
						deviceId: "11111111-2222-4333-8444-555555555555",
					},
				}),
				method: "PATCH",
			})
		).json();
		expect(set.key.network.proxy.url).toBe("http://u:***@proxy:8080");
		expect(set.key.network.deviceId).toBeUndefined();

		await app().request(`/key/${id}`, {
			...json({ network: set.key.network, label: "renamed" }),
			method: "PATCH",
		});
		expect(getProviderKeyStore().get(id)?.network?.proxy?.url).toBe("http://u:secret@proxy:8080");
	});

	for (const [index, groupId] of GROUPS.entries()) {
		test(`${groupId}: add, dedupe, edit, network, disable, order and delete the last key`, async () => {
			const store = getProviderKeyStore();
			const owner = OWNERS[index];
			if (!owner) throw new Error("Expected pool owner");
			const original = store.list(owner)[0];
			if (!original) throw new Error("Expected first key");
			const added = await (
				await app().request(`/${groupId}`, json({ apiKey: "pool-backup-key" }))
			).json();
			expect(added.key.id).toHaveLength(21);
			expect(store.listGroup(groupId)).toHaveLength(2);
			expect(store.list(owner)).toEqual(store.listGroup(groupId));
			expect(
				(await app().request(`/${groupId}`, json({ apiKey: " pool-backup-key " }))).status,
			).toBe(409);
			expect(
				(
					await app().request(`/key/${added.key.id}`, {
						...json({ apiKey: original.apiKey }),
						method: "PATCH",
					})
				).status,
			).toBe(409);
			expect(store.get(added.key.id)?.apiKey).toBe("pool-backup-key");
			const edited = await (
				await app().request(`/key/${added.key.id}`, {
					...json({
						disabled: true,
						network: { userAgentMode: "custom", customUserAgent: "pool-test" },
						label: "backup",
					}),
					method: "PATCH",
				})
			).json();
			expect(edited.key.disabledReason).toBe("manual");
			expect(edited.key.label).toBe("backup");
			expect(edited.key.network.customUserAgent).toBe("pool-test");
			await app().request(`/key/${added.key.id}`, {
				...json({ disabled: false, network: null }),
				method: "PATCH",
			});
			expect(store.get(added.key.id)?.disabled).toBeUndefined();
			expect(store.get(added.key.id)?.network).toBeUndefined();
			await app().request(`/${groupId}/order`, { ...json({ ids: [added.key.id] }), method: "PUT" });
			expect(store.firstKey(owner)).toBe("pool-backup-key");
			const projection = () =>
				groupId === PROVIDER
					? settings.customApiProviders?.[0]?.apiKey
					: groupId === "routeN"
						? settings.nugProviders?.[0]?.apiKey
						: groupId === "tokendance"
							? settings.tokendance?.apiKey
							: settings.commandCode?.apiKey;
			expect(projection()).toBe("pool-backup-key");
			await app().request(`/key/${added.key.id}`, { method: "DELETE" });
			expect(projection()).toBe(original.apiKey);
			await app().request(`/key/${original.id}`, { method: "DELETE" });
			expect((await (await app().request(`/${groupId}`)).json()).keys).toEqual([]);
			expect(projection() ?? "").toBe("");
			saveSettings(structuredClone(settings));
			expect(store.listGroup(groupId)).toEqual([]);
		});
		test(`${groupId}: identity changes and deletion drop quota, not label or disabled edits`, async () => {
			const key = getProviderKeyStore().listGroup(groupId)[0];
			if (!key) throw new Error("Expected pool key");
			const snapshot = {
				fetchedAt: Date.now(),
				scope: "key" as const,
				windows: [{ kind: "5h" as const, usedRatio: 1, resetsAt: Date.now() + 60_000 }],
				balances: [],
			};
			const seed = () => {
				quotaStore.set(key.id, "old-identity", snapshot, false);
				quotaStore.set(key.id, "old-stream", snapshot, false, STREAM_QUOTA_SOURCE);
			};
			const assertQuota = (retained: boolean) => {
				for (const source of [undefined, STREAM_QUOTA_SOURCE]) {
					expect(quotaStore.peek(key.id, source)).toBe(retained ? snapshot : undefined);
				}
			};
			const edit = async (fields: unknown) => {
				expect(
					(await app().request(`/key/${key.id}`, { ...json(fields), method: "PATCH" })).status,
				).toBe(200);
			};
			seed();
			await edit({ apiKey: key.apiKey, network: null, label: "renamed", disabled: true });
			assertQuota(true);
			await edit({ disabled: false });
			assertQuota(true);
			await edit({ network: { proxy: { mode: "direct" } } });
			assertQuota(false);
			seed();
			await edit({ network: { proxy: { mode: "direct" } } });
			assertQuota(true);
			await edit({ apiKey: "replaced-key" });
			assertQuota(false);
			seed();
			expect((await app().request(`/key/${key.id}`, { method: "DELETE" })).status).toBe(200);
			assertQuota(false);
		});
	}

	test("first singleton adds initialize missing settings holders without losing existing keys", async () => {
		const store = getProviderKeyStore();
		for (const existing of [false, true]) {
			saveSettings({ ...settings, tokendance: undefined, commandCode: undefined });
			for (const [groupId, templateId] of [
				["tokendance", "tokendance"],
				["CommandCode", "command-code"],
			] as const) {
				if (existing) store.addGroupCredential(groupId, templateId, { apiKey: "stored-first" });
				const res = await app().request(`/${groupId}`, json({ apiKey: "added-key" }));
				expect(res.status).toBe(200);
				const expected = existing ? ["stored-first", "added-key"] : ["added-key"];
				expect(store.listGroup(groupId).map((key) => key.apiKey)).toEqual(expected);
				expect(
					(groupId === "tokendance" ? settings.tokendance : settings.commandCode)?.apiKey,
				).toBe(expected[0]);
				saveSettings(structuredClone(settings));
				expect(store.listGroup(groupId).map((key) => key.apiKey)).toEqual(expected);
			}
		}
	});

	test("only inference pools can be edited, with same-group ordering", async () => {
		const store = getProviderKeyStore();
		const search = store.add("search:route-search", { apiKey: "search-secret" });
		const orphan = store.add("orphan-group", { apiKey: "orphan-secret" });
		try {
			for (const key of [search, orphan]) {
				expect(
					(await app().request(`/key/${key.id}`, { ...json({ label: "no" }), method: "PATCH" }))
						.status,
				).toBe(404);
				expect((await app().request(`/key/${key.id}`, { method: "DELETE" })).status).toBe(404);
			}
			expect((await app().request("/codex", json({ apiKey: "no" }))).status).toBe(404);
			const foreignKey = store.list(nugKeyOwner("routeN"))[0];
			if (!foreignKey) throw new Error("Expected NUG key");
			for (const ids of [["missing"], [PROVIDER, PROVIDER], [foreignKey.id]]) {
				expect(
					(await app().request(`/${PROVIDER}/order`, { ...json({ ids }), method: "PUT" })).status,
				).toBe(400);
			}
		} finally {
			store.remove(search.id);
			store.remove(orphan.id);
		}
	});

	test("non-admins are refused for every pool and CRUD operation", async () => {
		for (const [index, groupId] of GROUPS.entries()) {
			const owner = OWNERS[index];
			if (!owner) throw new Error("Expected pool owner");
			const key = getProviderKeyStore().list(owner)[0];
			if (!key) throw new Error("Expected first key");
			const keyId = key.id;
			for (const [path, options] of [
				[`/${groupId}`, undefined],
				[`/${groupId}`, json({ apiKey: "unauthorized" })],
				[`/key/${keyId}`, { ...json({ disabled: true }), method: "PATCH" }],
				[`/key/${keyId}`, { method: "DELETE" }],
				[`/${groupId}/order`, { ...json({ ids: [keyId] }), method: "PUT" }],
				[`/${groupId}/usage/refresh`, { method: "POST" }],
			] as const) {
				expect((await app("user").request(path, options)).status).toBe(403);
			}
			expect(getProviderKeyStore().listGroup(groupId)).toHaveLength(1);
		}
	});
});
