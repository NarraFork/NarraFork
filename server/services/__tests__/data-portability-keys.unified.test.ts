import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import archiver from "archiver";
import { seedUnifiedCredentials } from "../../../tests/unified-credentials";
import { sqlite } from "../../db";
import { getCredentialStore } from "../../lib/credential-store";
import { getProviderKeyStore, nugKeyOwner } from "../../lib/provider-keys";
import { saveSettings, settings } from "../../lib/settings";
import { applyImport, exportData, getPreview, previewImport } from "../data-portability";
import { SEALED_KEYS_ENTRY, sealProviderKeys } from "../data-portability-keys";

seedUnifiedCredentials();
const PASSPHRASE = "unified archive passphrase";
const providersOnly = { requests: false, sessions: false, providers: true };
const bufferOf = (zip: Buffer) =>
	zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
const nug = (apiKey: string) => ({
	id: "gateway",
	prefix: "gw",
	name: "Gateway",
	apiKey,
	baseUrl: "https://gateway.example",
	defaultModel: "",
	oauthClientSecret: "oauth-secret",
});

async function legacyArchive(version: number) {
	const archive = archiver("zip");
	const chunks: Buffer[] = [];
	archive.on("data", (chunk: Buffer) => chunks.push(chunk));
	const done = new Promise<void>((resolve, reject) => {
		archive.on("end", resolve);
		archive.on("error", reject);
	});
	archive.append(JSON.stringify({ version }), { name: "manifest.json" });
	archive.append(JSON.stringify({ nugProviders: [nug(version === 1 ? "legacy-key" : "")] }), {
		name: "providers.json",
	});
	if (version === 2)
		archive.append(
			await sealProviderKeys(
				new Map([[nugKeyOwner("gateway"), [{ apiKey: "legacy-key" }]]]),
				PASSPHRASE,
			),
			{ name: SEALED_KEYS_ENTRY },
		);
	void archive.finalize();
	await done;
	return Buffer.concat(chunks);
}

function emptyProviders() {
	getProviderKeyStore().removeGroup("gateway");
	saveSettings({
		...settings,
		customApiProviders: [],
		nugProviders: [],
		tokendance: undefined,
		commandCode: undefined,
	});
}

test("v1 inline and v2 sealed provider keys restore to unified credentials and group secrets", async () => {
	for (const version of [1, 2]) {
		emptyProviders();
		const preview = await previewImport(bufferOf(await legacyArchive(version)), `v${version}.zip`);
		await applyImport(preview.token, {
			conflictDefault: "skip",
			...(version === 2 ? { passphrase: PASSPHRASE } : {}),
		});
		expect(settings.nugProviders?.[0]?.apiKey).toBe("legacy-key");
		expect(settings.nugProviders?.[0]?.oauthClientSecret).toBe("oauth-secret");
		const store = getCredentialStore();
		expect(store.unified).toBe(true);
		expect(store.keyCredentials().credentials[0]?.auth).toEqual({
			kind: "api_key",
			apiKey: "legacy-key",
		});
		expect(store.keyCredentials().groupSecrets.gateway).toEqual({
			oauthClientSecret: "oauth-secret",
		});
	}
});

test("v3 restores key metadata and group secrets; a wrong or missing passphrase writes nothing", async () => {
	emptyProviders();
	saveSettings({ ...settings, nugProviders: [nug("first-key")] });
	const keys = getProviderKeyStore();
	const backup = keys.addGroupCredential("gateway", "nug", {
		apiKey: "backup-key",
		label: "Backup",
	});
	keys.update(backup.id, { disabled: true, disabledReason: "manual" });
	const zip = await readFile((await exportData(providersOnly, { passphrase: PASSPHRASE })).zipPath);
	const initial = await previewImport(bufferOf(zip), "v3.zip");
	expect(getPreview(initial.token).version).toBe(3);
	emptyProviders();
	const path = getCredentialStore().path;
	const bytes = readFileSync(path);
	const before = structuredClone(settings.nugProviders);
	for (const passphrase of [undefined, "wrong passphrase"]) {
		const preview = await previewImport(bufferOf(zip), "bad-passphrase.zip");
		await expect(
			applyImport(preview.token, {
				conflictDefault: "skip",
				...(passphrase ? { passphrase } : {}),
			}),
		).rejects.toThrow();
		expect(readFileSync(path)).toEqual(bytes);
		expect(settings.nugProviders).toEqual(before);
		expect(sqlite.query("SELECT id FROM narrators").all()).toEqual([]);
	}
	const preview = await previewImport(bufferOf(zip), "correct.zip");
	await applyImport(preview.token, { conflictDefault: "skip", passphrase: PASSPHRASE });
	expect(keys.listGroup("gateway").map((key) => [key.apiKey, key.label, !!key.disabled])).toEqual([
		["first-key", undefined, false],
		["backup-key", "Backup", true],
	]);
	expect(keys.groupSecrets("gateway")).toEqual({ oauthClientSecret: "oauth-secret" });
	expect(getCredentialStore().keyCredentials().credentials).toHaveLength(2);
});
