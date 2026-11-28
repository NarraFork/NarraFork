import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { SQL } from "bun";
import { withPostgres } from "../../../tests/db/pg-test-harness";
import type { PluginResourceMutation, PluginSettingMutation } from "../plugin-settings-store";
import { createPostgresPluginSettingsStore } from "../postgres-plugin-settings-store";

const enabled = process.env.PG_INTEGRATION === "1";
test.skipIf(!enabled)(
	"real PostgreSQL plugin settings transactions preserve CAS, budgets and rollback",
	async () => {
		const result = await withPostgres(async ({ port, credentials, exec }) => {
			const migration = await readFile(
				new URL("../../../drizzle-postgres/0079_plugin_provider_settings.sql", import.meta.url),
				"utf8",
			);
			const applied = await exec(migration);
			expect(applied.code).toBe(0);
			const client = new SQL(
				`postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/${credentials.database}`,
				{ max: 4, connectTimeout: 2, idleTimeout: 1 },
			);
			try {
				const store = createPostgresPluginSettingsStore(client),
					pluginId = "com.example.pgsettings";
				const s: PluginSettingMutation = {
					address: {
						pluginId,
						contributionId: "test",
						targetKind: "custom-api",
						targetId: "provider-1",
					},
					expectedRevision: 0,
					value: {
						installationId: "installation-1",
						state: "active",
						schemaVersion: 1,
						schemaFingerprint: "a".repeat(64),
						bindingFingerprint: "b".repeat(64),
						configText: '{"label":"fixture"}',
						keyId: null,
						secretsEnvelope: null,
					},
				};
				const r: PluginResourceMutation = {
					address: {
						pluginId,
						ownerKind: "host-migration",
						scopeType: "provider",
						scopeId: "provider-1",
						key: "receipt",
					},
					expectedRevision: 0,
					value: {
						installationId: "installation-1",
						bindingFingerprint: "b".repeat(64),
						state: "active",
						valueText: '{"done":true}',
					},
				};
				const saved = await store.commit({ setting: s, resource: r });
				expect(await store.getSetting(s.address)).toEqual(saved.setting ?? null);
				expect(await store.getResource(r.address)).toEqual(saved.resource ?? null);
				const race = await Promise.allSettled(
					["first", "second"].map((label) =>
						store.commit({
							setting: {
								...s,
								expectedRevision: 1,
								value: { ...s.value, configText: JSON.stringify({ label }) },
							},
						}),
					),
				);
				expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
				expect(race.filter((r) => r.status === "rejected")).toHaveLength(1);
				const before = await store.getSetting(s.address);
				await expect(
					store.commit({ setting: { ...s, expectedRevision: 2 }, resource: r }),
				).rejects.toMatchObject({ code: "PLUGIN_SETTINGS_REVISION_CONFLICT" });
				expect(await store.getSetting(s.address)).toEqual(before);
				const trigger = await exec(
					"CREATE FUNCTION reject_fixture_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER reject_fixture_receipt BEFORE UPDATE ON plugin_resource_entries FOR EACH ROW EXECUTE FUNCTION reject_fixture_receipt();",
				);
				expect(trigger.code).toBe(0);
				await expect(
					store.commit({
						setting: { ...s, expectedRevision: 2 },
						resource: { ...r, expectedRevision: 1 },
					}),
				).rejects.toMatchObject({ code: "PLUGIN_SETTINGS_STORE_UNAVAILABLE" });
				expect(await store.getSetting(s.address)).toEqual(before);
				await exec("DROP TRIGGER reject_fixture_receipt ON plugin_resource_entries");
				await client.unsafe(
					"UPDATE plugin_resource_entries SET revision = 2147483648 WHERE plugin_id = $1",
					[pluginId],
				);
				expect(
					(await store.commit({ resource: { ...r, expectedRevision: 2147483648 } })).resource
						?.revision,
				).toBe(2147483649);
				const page = await store.listSettings(pluginId);
				expect(page.items).toHaveLength(1);
				expect(page.items[0]).not.toHaveProperty("configText");
				const budget = await client.unsafe(
					"SELECT resource_count,settings_count FROM plugin_resource_budgets WHERE plugin_id = $1",
					[pluginId],
				);
				expect(budget[0]).toMatchObject({ resource_count: 1, settings_count: 1 });
				const destination = { ...s.address, targetId: "provider-2" };
				const retired = {
					...s,
					expectedRevision: 2,
					value: { ...s.value, state: "deleted" as const, configText: "" },
				};
				await store.commit({ setting: { ...s, address: destination }, retiredSetting: retired });
				expect(await store.getSetting(s.address)).toMatchObject({ state: "deleted", revision: 3 });
				expect(await store.getSetting(destination)).toMatchObject({ state: "active", revision: 1 });
				await expect(
					store.commit({
						setting: { ...s, address: destination, expectedRevision: 1 },
						retiredSetting: retired,
					}),
				).rejects.toMatchObject({ code: "PLUGIN_SETTINGS_REVISION_CONFLICT" });
				expect(await store.getSetting(destination)).toMatchObject({ revision: 1 });
				return { status: "verified" as const };
			} catch (error) {
				console.error("PostgreSQL fixture callback failure", error);
				throw error;
			} finally {
				await client.close();
			}
		});
		if (result.status !== "verified")
			throw new Error(
				`PostgreSQL validation did not run: ${"reason" in result ? result.reason : result.status}`,
			);
	},
	120000,
);
