import { afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { seedUnifiedCredentials } from "../../../tests/unified-credentials";
import { getProviderKeyStore, resetProviderKeyStoreForTests } from "../../lib/provider-keys";
import { saveSettings, settings } from "../../lib/settings";
import { providerKeyRoutes } from "../provider-keys";

const credentials = seedUnifiedCredentials();
const saved = structuredClone(settings);
const groups = ["unified-route", "unified-nug-route", "tokendance", "CommandCode"];
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user" as never, { sub: "u1", sid: "s1", role: "admin" } as never);
	await next();
});
app.route("/", providerKeyRoutes);
afterAll(() => {
	for (const group of groups) getProviderKeyStore().removeGroup(group);
	saveSettings(saved);
});
const body = (value: unknown) => ({
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(value),
});

test("route writes survive unified store reconstruction for each source family", async () => {
	saveSettings({
		...settings,
		customApiProviders: [
			{
				id: groups[0],
				name: "Route",
				prefix: "unified-route",
				apiKey: "",
				baseUrl: "https://route.invalid/v1",
				defaultModel: "m",
				protocol: "completions-compatible",
			},
		],
		nugProviders: [
			{
				id: groups[1],
				name: "NUG",
				prefix: "unified-nug-route",
				apiKey: "",
				baseUrl: "https://nug.invalid",
				defaultModel: "m",
			},
		],
		tokendance: { apiKey: "", generation: 1, disabled: false },
		commandCode: { apiKey: "" },
	});
	for (const group of groups) {
		getProviderKeyStore().removeGroup(group);
		const response = await app.request(`/${group}`, {
			method: "POST",
			...body({ apiKey: `persisted-secret-${group}` }),
		});
		expect(response.status).toBe(200);
		const { key } = await response.json();
		const updated = await app.request(`/key/${key.id}`, {
			method: "PATCH",
			...body({
				disabled: true,
				network: { userAgentMode: "custom", customUserAgent: "persisted-agent" },
			}),
		});
		expect(updated.status).toBe(200);
		resetProviderKeyStoreForTests();
		const listed = await (await app.request(`/${group}`)).json();
		expect(listed.keys).toHaveLength(1);
		expect(listed.keys[0]).toMatchObject({
			id: key.id,
			disabled: true,
			network: { userAgentMode: "custom", customUserAgent: "persisted-agent" },
		});
		expect(JSON.stringify(listed)).not.toContain(`persisted-secret-${group}`);
		expect(getProviderKeyStore().listGroup(group)[0]?.apiKey).toBe(`persisted-secret-${group}`);
	}
	expect(credentials.written()).toBe(true);
});
