import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { seedUnifiedCredentials } from "../../../tests/unified-credentials";
import { sqlite } from "../../db";
import { getCredentialStore } from "../../lib/credential-store";
import { getProviderKeyStore } from "../../lib/provider-keys";
import { saveSettings, settings } from "../../lib/settings";
import { applyImport, exportData, previewImport } from "../data-portability";

seedUnifiedCredentials();

test("unified import remaps colliding groups, credentials and imported sessions together", async () => {
	const provider = (apiKey: string, baseUrl: string) => ({
		id: "collision",
		name: "Relay",
		prefix: "relay",
		protocol: "completions-compatible" as const,
		baseUrl,
		apiKey,
		defaultModel: "",
	});
	const session = (id: string, model: string) =>
		sqlite.run(
			"INSERT INTO narrators (id, type, model, pending_model_restore, created_at, updated_at) VALUES (?, 'primary', ?, ?, '2026-10-01', '2026-10-01')",
			[id, model, `__agg__:${model}`],
		);
	saveSettings({
		...settings,
		customApiProviders: [provider("remote-key", "https://remote.example/v1")],
	});
	session("incoming", "relay:model");
	session("kept", "relay:old");
	const passphrase = "unified archive passphrase";
	const zip = await readFile(
		(await exportData({ requests: false, sessions: true, providers: true }, { passphrase }))
			.zipPath,
	);
	const preview = await previewImport(
		zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer,
		"unified.zip",
	);
	sqlite.run("DELETE FROM narrators");
	session("kept", "relay:local");
	const keys = getProviderKeyStore();
	keys.removeGroup("collision");
	saveSettings({
		...settings,
		customApiProviders: [provider("local-key", "https://local.example/v1")],
	});
	await applyImport(preview.token, { conflictDefault: "skip", passphrase });
	const imported = settings.customApiProviders?.find((p) => p.prefix === "relay-2");
	expect(imported).toBeDefined();
	expect(imported?.id).not.toBe("collision");
	expect(imported?.apiKey).toBe("remote-key");
	expect(keys.firstGroupKey("collision")).toBe("local-key");
	const credential = getCredentialStore()
		.keyCredentials()
		.credentials.find((c) => c.target.groupId === imported?.id);
	expect(credential?.auth).toEqual({ kind: "api_key", apiKey: "remote-key" });
	expect(
		sqlite
			.query("SELECT model, pending_model_restore AS restore FROM narrators WHERE id = 'incoming'")
			.get(),
	).toEqual({ model: "relay-2:model", restore: "__agg__:relay-2:model" });
	expect(sqlite.query("SELECT model FROM narrators WHERE id = 'kept'").get()).toEqual({
		model: "relay:local",
	});
});
