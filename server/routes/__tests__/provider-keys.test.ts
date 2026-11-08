import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getProviderKeyStore } from "../../lib/provider-keys";
import { saveSettings, settings } from "../../lib/settings";
import { providerKeyRoutes } from "../provider-keys";

const PROVIDER = "routeP";
let saved: typeof settings.customApiProviders;

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
	saved = structuredClone(settings.customApiProviders);
	saveSettings({
		...settings,
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
	saveSettings({ ...settings, customApiProviders: saved });
	getProviderKeyStore().removeProvider(PROVIDER);
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

	test("non-admins are refused", async () => {
		const res = await app("user").request(`/${PROVIDER}`);
		expect(res.status).toBe(403);
	});
});
