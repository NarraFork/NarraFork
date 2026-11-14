import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Provider keys in a data export: providers.json has none, the sealed file has all of them.
const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-portability-keys-"));
process.env.NARRAFORK_HOME = testHome;

const { sqlite } = await import("../../db");
const { reloadSettings, saveSettings, settings } = await import("../../lib/settings");
const { getProviderKeyStore } = await import("../../lib/provider-keys");
const { applyImport, clearData, exportData, getPreview, previewImport } = await import(
	"../data-portability"
);
const { nugKeyOwner, nugOAuthKeyOwner, quotaKeyOwner } = await import(
	"../../lib/settings/provider-keys-projection"
);
const { sealProviderKeys, SEALED_KEYS_ENTRY } = await import("../data-portability-keys");
const archiver = (await import("archiver")).default;

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	try {
		rmSync(testHome, { recursive: true, force: true });
	} catch {
		// Windows may still hold a handle
	}
});

const PASSPHRASE = "correct horse battery";
const providersOnly = { requests: false, sessions: false, providers: true };

const apiProvider = (
	id: string,
	prefix: string,
	apiKey: string,
	baseUrl: string,
	quotaAccessToken?: string,
) => ({
	id,
	name: prefix,
	prefix,
	protocol: "completions-compatible" as const,
	baseUrl,
	apiKey,
	defaultModel: "",
	...(quotaAccessToken ? { quotaAccessToken } : {}),
});
const nug = (id: string, prefix: string, apiKey: string, oauthClientSecret?: string) => ({
	id,
	name: prefix,
	prefix,
	apiKey,
	baseUrl: "http://nug.example",
	defaultModel: "kiro:claude-opus-4.6",
	...(oauthClientSecret ? { oauthClientSecret } : {}),
});

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
	return buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength,
	) as ArrayBuffer;
}

const keysOf = (providerId: string) =>
	getProviderKeyStore()
		.list(providerId)
		.map((key) => ({ apiKey: key.apiKey, label: key.label, disabled: key.disabled }));

function setProviders(next: {
	customApiProviders?: ReturnType<typeof apiProvider>[];
	nugProviders?: ReturnType<typeof nug>[];
	tokendance?: string;
}) {
	for (const key of getProviderKeyStore().all())
		getProviderKeyStore().removeProvider(key.providerId);
	const draft = structuredClone(settings);
	draft.customApiProviders = next.customApiProviders ?? [];
	draft.nugProviders = next.nugProviders ?? [];
	draft.codex = undefined;
	draft.commandCode = undefined;
	draft.tokendance = next.tokendance
		? { apiKey: next.tokendance, disabled: false, generation: 1 }
		: undefined;
	(draft.agent as unknown as Record<string, unknown>).platformInstances = [];
	saveSettings(draft);
}

/** An exporting instance: one relay with three keys, one NUG gateway, TokenDance. */
async function exportFromSource(): Promise<Buffer> {
	setProviders({
		customApiProviders: [
			apiProvider("relay-id", "relay", "sk-first", "https://relay.example/v1", "site-relay-secret"),
		],
		nugProviders: [nug("nug-id", "gw", "nug-secret", "oauth-secret")],
		tokendance: "td-secret",
	});
	const store = getProviderKeyStore();
	const second = store.add("relay-id", { apiKey: "sk-second", label: "backup" });
	store.add("relay-id", { apiKey: "sk-third" });
	store.update(second.id, { disabled: true, disabledReason: "manual" });
	return readFile((await exportData(providersOnly, { passphrase: PASSPHRASE })).zipPath);
}

/** A real version-1 archive from before sealed credentials and site-token projection. */
async function legacyExport(
	providers: ReturnType<typeof apiProvider>[],
	nugProviders: ReturnType<typeof nug>[] = [],
	version = 1,
): Promise<Buffer> {
	const path = join(testHome, "legacy-providers.zip");
	const sealed =
		version === 2
			? await sealProviderKeys(
					new Map(nugProviders.map((p) => [nugKeyOwner(p.id), [{ apiKey: p.apiKey }]])),
					PASSPHRASE,
				)
			: undefined;
	await new Promise<void>((resolve, reject) => {
		const output = createWriteStream(path);
		const archive = archiver("zip");
		output.on("close", resolve);
		output.on("error", reject);
		archive.on("error", reject);
		archive.pipe(output);
		archive.append(JSON.stringify({ version }), { name: "manifest.json" });
		archive.append(
			JSON.stringify({
				customApiProviders: providers,
				nugProviders: nugProviders.map((p) => ({ ...p, apiKey: sealed ? "" : p.apiKey })),
			}),
			{ name: "providers.json" },
		);
		if (sealed) archive.append(sealed, { name: SEALED_KEYS_ENTRY });
		void archive.finalize();
	});
	return readFile(path);
}

beforeEach(() => {
	sqlite.run("DELETE FROM narrators");
});

describe("provider keys in a data export", () => {
	test("old v1/v2 archives with inline NUG OAuth secrets remain importable", async () => {
		for (const version of [1, 2]) {
			setProviders({});
			const zip = await legacyExport(
				[],
				[nug("legacy-nug", "legacygw", "legacy-nug-api", "legacy-oauth")],
				version,
			);
			const preview = await previewImport(toArrayBuffer(zip), "legacy-nug.zip");
			await applyImport(preview.token, {
				conflictDefault: "skip",
				...(version === 2 ? { passphrase: PASSPHRASE } : {}),
			});
			expect(settings.nugProviders?.[0]?.apiKey).toBe("legacy-nug-api");
			expect(settings.nugProviders?.[0]?.oauthClientSecret).toBe("legacy-oauth");
			expect(getProviderKeyStore().firstKey(nugOAuthKeyOwner("legacy-nug"))).toBe("legacy-oauth");
		}
	});

	test("NUG OAuth secrets follow ID/prefix remaps but never overwrite skipped local providers", async () => {
		const zip = await exportFromSource();
		for (const apiKey of ["nug-secret", "local-nug-key"]) {
			setProviders({ nugProviders: [nug("nug-id", "gw", apiKey, "oauth-local")] });
			const preview = await previewImport(toArrayBuffer(zip), "remapped-nug.zip");
			await applyImport(preview.token, { conflictDefault: "skip", passphrase: PASSPHRASE });
			const local = settings.nugProviders?.find((p) => p.id === "nug-id");
			expect(local?.oauthClientSecret).toBe("oauth-local");
			expect(getProviderKeyStore().firstKey(nugOAuthKeyOwner("nug-id"))).toBe("oauth-local");
			const imported = settings.nugProviders?.find((p) => p.prefix === "gw-2");
			if (apiKey === "nug-secret") {
				expect(imported).toBeUndefined();
			} else {
				if (!imported) throw new Error("Expected the remapped NUG provider");
				expect(imported.id).not.toBe("nug-id");
				expect(imported.oauthClientSecret).toBe("oauth-secret");
				expect(getProviderKeyStore().firstKey(nugOAuthKeyOwner(imported.id))).toBe("oauth-secret");
			}
		}
	});

	test("clearing model providers removes NUG OAuth owners without touching surviving search secrets", async () => {
		const savedSearch = structuredClone(settings.search);
		try {
			for (const target of ["providers", "all"] as const) {
				setProviders({ nugProviders: [nug("clear-nug", "cleargw", "clear-api", "clear-oauth")] });
				saveSettings({
					...settings,
					search: {
						channels: [],
						...settings.search,
						customProviders: [
							{
								id: "keep-search",
								name: "Keep",
								protocol: "tavily",
								baseUrl: "https://search.example",
								apiKey: "search-keep-key",
								headers: { Authorization: "search-keep-secret" },
							},
						],
					},
				});
				await clearData(target);
				expect(getProviderKeyStore().list(nugOAuthKeyOwner("clear-nug"))).toEqual([]);
				expect(settings.nugProviders).toEqual([]);
				expect(reloadSettings().search?.customProviders[0].headers).toEqual({
					Authorization: "search-keep-secret",
				});
				expect(settings.search?.customProviders[0].apiKey).toBe("search-keep-key");
			}
		} finally {
			saveSettings({ ...settings, search: savedSearch });
		}
	});

	test("providers.json carries no key; the archive is version 2 with sealed keys", async () => {
		const zip = await exportFromSource();
		const preview = await previewImport(toArrayBuffer(zip), "keys.zip");
		const stored = getPreview(preview.token);
		const text = JSON.stringify(stored.providers);
		for (const secret of [
			"sk-first",
			"sk-second",
			"sk-third",
			"nug-secret",
			"oauth-secret",
			"td-secret",
			"site-relay-secret",
		]) {
			expect(text).not.toContain(secret);
			// The sealed file is ciphertext; no key appears in it either.
			expect(stored.sealedKeys ?? "").not.toContain(secret);
		}
		expect(stored.version).toBe(2);
		expect(stored.sealedKeyCount).toBe(5);
		expect((stored.providers.nugProviders as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
			"oauthClientSecret",
		);
		expect(
			(stored.providers.customApiProviders as Array<Record<string, unknown>>)[0],
		).not.toHaveProperty("quotaAccessToken");
	});

	test("without a passphrase, providers go out without keys and the archive stays version 1", async () => {
		setProviders({
			customApiProviders: [
				apiProvider(
					"relay-id",
					"relay",
					"sk-first",
					"https://relay.example/v1",
					"site-unsealed-secret",
				),
			],
			nugProviders: [nug("plain-nug", "plainnug", "nug-unsealed", "oauth-unsealed")],
		});
		const zip = await readFile((await exportData(providersOnly)).zipPath);
		const stored = getPreview((await previewImport(toArrayBuffer(zip), "plain.zip")).token);
		expect(JSON.stringify(stored.providers)).not.toContain("sk-first");
		expect(JSON.stringify(stored.providers)).not.toContain("site-unsealed-secret");
		expect(JSON.stringify(stored.providers)).not.toContain("oauth-unsealed");
		expect(stored.sealedKeys).toBeUndefined();
		expect(stored.version).toBe(1);
		setProviders({});
		const preview = await previewImport(toArrayBuffer(zip), "plain-again.zip");
		const result = await applyImport(preview.token, { conflictDefault: "skip" });
		expect(settings.customApiProviders?.[0]).not.toHaveProperty("quotaAccessToken");
		expect(getProviderKeyStore().list(quotaKeyOwner("relay-id"))).toEqual([]);
		expect(settings.nugProviders?.[0]).not.toHaveProperty("oauthClientSecret");
		expect(getProviderKeyStore().list(nugOAuthKeyOwner("plain-nug"))).toEqual([]);
		expect(result.keysImported).toBe(0);
	});

	test("the right passphrase brings back every key, in order, with its label and switch", async () => {
		const zip = await exportFromSource();
		setProviders({});
		const preview = await previewImport(toArrayBuffer(zip), "keys.zip");
		const result = await applyImport(preview.token, {
			conflictDefault: "skip",
			passphrase: PASSPHRASE,
		});
		const relay = (settings.customApiProviders ?? []).find((p) => p.prefix === "relay");
		expect(relay?.apiKey).toBe("sk-first");
		expect(relay?.quotaAccessToken).toBe("site-relay-secret");
		expect(keysOf(quotaKeyOwner(relay?.id ?? "")).map((key) => key.apiKey)).toEqual([
			"site-relay-secret",
		]);
		expect(keysOf(relay?.id ?? "")).toEqual([
			{ apiKey: "sk-first", label: undefined, disabled: undefined },
			{ apiKey: "sk-second", label: "backup", disabled: true },
			{ apiKey: "sk-third", label: undefined, disabled: undefined },
		]);
		expect(settings.nugProviders?.find((p) => p.prefix === "gw")?.apiKey).toBe("nug-secret");
		expect(settings.tokendance?.apiKey).toBe("td-secret");
		expect(settings.nugProviders?.find((p) => p.prefix === "gw")?.oauthClientSecret).toBe(
			"oauth-secret",
		);
		expect(keysOf(nugOAuthKeyOwner("nug-id")).map((key) => key.apiKey)).toEqual(["oauth-secret"]);
		expect(result.keysImported).toBe(7);
		expect(result.keysFailed).toBe(0);
	});

	test("a site-only credential round-trips without creating an inference key", async () => {
		setProviders({
			customApiProviders: [
				apiProvider(
					"site-only",
					"siteonly",
					"",
					"https://site-only.example/v1",
					"site-only-secret",
				),
				apiProvider(
					"inference-only",
					"inferenceonly",
					"sk-separate",
					"https://inference.example/v1",
				),
			],
		});
		const zip = await readFile(
			(await exportData(providersOnly, { passphrase: PASSPHRASE })).zipPath,
		);
		setProviders({});
		const preview = await previewImport(toArrayBuffer(zip), "site-only.zip");
		const result = await applyImport(preview.token, {
			conflictDefault: "skip",
			passphrase: PASSPHRASE,
		});
		const site = settings.customApiProviders?.find((p) => p.id === "site-only");
		const inference = settings.customApiProviders?.find((p) => p.id === "inference-only");
		expect(site?.quotaAccessToken).toBe("site-only-secret");
		expect(site?.apiKey).toBe("");
		expect(keysOf("site-only")).toEqual([]);
		expect(getProviderKeyStore().firstKey(quotaKeyOwner("site-only"))).toBe("site-only-secret");
		expect(inference?.apiKey).toBe("sk-separate");
		expect(inference).not.toHaveProperty("quotaAccessToken");
		expect(keysOf(quotaKeyOwner("inference-only"))).toEqual([]);
		expect(result.keysImported).toBe(2);
	});

	test("version-1 providers with plaintext or absent site tokens remain importable", async () => {
		for (const token of [undefined, "site-legacy-secret"]) {
			setProviders({});
			const zip = await legacyExport([
				apiProvider("legacy-relay", "legacyrelay", "sk-legacy", "https://legacy.example/v1", token),
			]);
			const preview = await previewImport(toArrayBuffer(zip), "legacy.zip");
			await applyImport(preview.token, { conflictDefault: "skip" });
			expect(settings.customApiProviders?.[0]?.apiKey).toBe("sk-legacy");
			expect(settings.customApiProviders?.[0]?.quotaAccessToken).toBe(token);
			expect(getProviderKeyStore().firstKey(quotaKeyOwner("legacy-relay"))).toBe(token);
			expect(keysOf("legacy-relay").map((key) => key.apiKey)).toEqual(["sk-legacy"]);
		}
	});

	test("clearing providers removes site tokens as well as all inference keys", async () => {
		setProviders({
			customApiProviders: [
				apiProvider(
					"clear-relay",
					"clearrelay",
					"sk-clear",
					"https://clear.example/v1",
					"site-clear",
				),
			],
		});
		getProviderKeyStore().add("clear-relay", { apiKey: "sk-clear-backup" });
		await clearData("providers");
		expect(settings.customApiProviders).toEqual([]);
		expect(keysOf("clear-relay")).toEqual([]);
		expect(keysOf(quotaKeyOwner("clear-relay"))).toEqual([]);
		// Reusing the cleared id must not revive its old account token.
		saveSettings({
			...settings,
			customApiProviders: [
				apiProvider("clear-relay", "clearrelay", "sk-new", "https://clear.example/v1"),
			],
		});
		expect(settings.customApiProviders?.[0]).not.toHaveProperty("quotaAccessToken");
		expect(keysOf(quotaKeyOwner("clear-relay"))).toEqual([]);
	});

	test("a wrong or missing passphrase writes nothing; sessions alone need none", async () => {
		const zip = await exportFromSource();
		setProviders({});
		const wrong = await previewImport(toArrayBuffer(zip), "keys.zip");
		await expect(
			applyImport(wrong.token, { conflictDefault: "skip", passphrase: "not the passphrase" }),
		).rejects.toMatchObject({ code: "BUNDLE_PASSPHRASE" });
		await expect(applyImport(wrong.token, { conflictDefault: "skip" })).rejects.toMatchObject({
			code: "IMPORT_PASSPHRASE_REQUIRED",
		});
		expect(settings.customApiProviders ?? []).toEqual([]);
		expect(getProviderKeyStore().all()).toEqual([]);
		// Leaving providers out of the import needs no passphrase.
		await applyImport(wrong.token, {
			conflictDefault: "skip",
			include: { requests: true, sessions: true, providers: false },
		});
		expect(settings.customApiProviders ?? []).toEqual([]);
	});

	test("a provider already here (same key and URL) is recognized and keeps its local keys", async () => {
		const zip = await exportFromSource();
		setProviders({
			customApiProviders: [
				apiProvider("local-id", "mine", "sk-first", "https://relay.example/v1", "site-local-only"),
			],
		});
		getProviderKeyStore().add("local-id", { apiKey: "sk-local-only" });
		const preview = await previewImport(toArrayBuffer(zip), "keys.zip");
		await applyImport(preview.token, { conflictDefault: "skip", passphrase: PASSPHRASE });
		expect((settings.customApiProviders ?? []).map((p) => p.prefix)).toEqual(["mine"]);
		expect(keysOf("local-id").map((key) => key.apiKey)).toEqual(["sk-first", "sk-local-only"]);
		expect(settings.customApiProviders?.[0]?.quotaAccessToken).toBe("site-local-only");
		expect(getProviderKeyStore().firstKey(quotaKeyOwner("local-id"))).toBe("site-local-only");
		expect(getProviderKeyStore().list(quotaKeyOwner("relay-id"))).toEqual([]);
	});

	test("a provider that had to take a new prefix gets its keys under its new id", async () => {
		const zip = await exportFromSource();
		setProviders({
			customApiProviders: [
				apiProvider(
					"relay-id",
					"relay",
					"sk-other",
					"https://other.example/v1",
					"site-original-local",
				),
			],
		});
		const preview = await previewImport(toArrayBuffer(zip), "keys.zip");
		await applyImport(preview.token, { conflictDefault: "skip", passphrase: PASSPHRASE });
		const imported = (settings.customApiProviders ?? []).find((p) => p.prefix === "relay-2");
		expect(imported?.id).not.toBe("relay-id");
		expect(imported?.quotaAccessToken).toBe("site-relay-secret");
		expect(getProviderKeyStore().firstKey(quotaKeyOwner(imported?.id ?? ""))).toBe(
			"site-relay-secret",
		);
		expect(keysOf(imported?.id ?? "").map((key) => key.apiKey)).toEqual([
			"sk-first",
			"sk-second",
			"sk-third",
		]);
		// The local provider that kept the prefix is untouched.
		expect(keysOf("relay-id").map((key) => key.apiKey)).toEqual(["sk-other"]);
		expect(getProviderKeyStore().firstKey(quotaKeyOwner("relay-id"))).toBe("site-original-local");
	});
});
