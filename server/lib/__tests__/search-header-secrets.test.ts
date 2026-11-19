import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNarraforkPath } from "../narrafork-home";
import * as providerKeys from "../provider-keys";
import { ProviderKeyStore } from "../provider-keys";
import { readSecretJSON, writeSecretJSON } from "../secret-store";
import { reloadSettings, saveSettings, settings } from "../settings";
import * as searchSecrets from "../settings/search-header-secrets";
import { isSensitiveHeaderName, SearchHeaderSecrets } from "../settings/search-header-secrets";
import type { NarraForkSettings } from "../settings/types";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const headers = {
	Authorization: "  Bearer keep spaces  ",
	"X-API-Key": "secret-api-key",
	"api-key": "secret-lower",
	"x-Auth-Token": "secret-token",
	Cookie: "session=secret-cookie",
	"Set-Cookie": "session=secret-set-cookie",
	"X-Ordinary": "  public value  ",
};
const provider = (id: string, value: Record<string, string> = headers) => ({
	id,
	name: id,
	protocol: "tavily",
	baseUrl: "https://search.example",
	headers: { ...value },
});
function freshPath() {
	const dir = mkdtempSync(join(tmpdir(), "nf-search-secrets-"));
	dirs.push(dir);
	return join(dir, "search-provider-secrets.json");
}
const foreign = JSON.stringify({
	format: "narrafork.secret.v1",
	cipher: "aes-256-gcm",
	iv: "x",
	tag: "x",
	data: "x",
});

describe("search header secrets", () => {
	test("the existing six sensitive names share one rule; headers keep their names and exact values", () => {
		for (const name of Object.keys(headers).slice(0, 6))
			expect(isSensitiveHeaderName(name)).toBe(true);
		expect(isSensitiveHeaderName("X-Ordinary")).toBe(false);
		const path = freshPath();
		const store = new SearchHeaderSecrets(path);
		const loaded = {
			search: {
				channels: [],
				customProviders: [provider("one"), provider("two", { Authorization: "other" })],
			},
		} as unknown as NarraForkSettings;
		expect(store.absorb(loaded)).toBe(true);
		const disk = store.without(loaded);
		expect(disk.search?.customProviders[0].headers).toEqual({ "X-Ordinary": "  public value  " });
		expect(disk.search?.customProviders[1]).not.toHaveProperty("headers");
		expect(loaded.search?.customProviders[0].headers).toEqual(headers);
		for (const secret of Object.values(headers).slice(0, 6))
			expect(readFileSync(path, "utf8")).not.toContain(secret);
		const reloaded = structuredClone(disk);
		expect(new SearchHeaderSecrets(path).absorb(reloaded)).toBe(false);
		expect(reloaded.search?.customProviders[0].headers).toEqual(headers);
		expect(reloaded.search?.customProviders[1].headers).toEqual({ Authorization: "other" });
	});

	test("settings load migrates, clone-save restores, and encryption changes rewrite the separate map", () => {
		const saved = structuredClone(settings);
		const settingsPath = getNarraforkPath("settings.json");
		const path = getNarraforkPath("search-provider-secrets.json");
		try {
			writeFileSync(
				settingsPath,
				JSON.stringify({
					...settings,
					search: { ...settings.search, customProviders: [provider("migration")] },
				}),
			);
			expect(reloadSettings().search?.customProviders[0].headers).toEqual(headers);
			for (const encrypt of [true, false, true]) {
				const next = structuredClone(settings);
				next.secrets = { encrypt };
				saveSettings(next);
				const disk = JSON.parse(readFileSync(settingsPath, "utf8"));
				expect(disk.search.customProviders[0].headers).toEqual({
					"X-Ordinary": "  public value  ",
				});
				expect(readFileSync(path, "utf8").includes("secret-api-key")).toBe(!encrypt);
				const fromDisk = structuredClone(disk);
				new SearchHeaderSecrets(path).hydrate(fromDisk);
				expect(fromDisk.search.customProviders[0].headers).toEqual(headers);
				expect(reloadSettings().search?.customProviders[0].headers).toEqual(headers);
			}
			expect(readSecretJSON(path)).toEqual({
				migration: Object.fromEntries(
					Object.entries(headers).filter(([name]) => isSensitiveHeaderName(name)),
				),
			});
		} finally {
			saveSettings(saved);
		}
	});

	test("clearing values, omitting headers and deleting providers cannot revive earlier secrets", () => {
		const saved = structuredClone(settings);
		const path = getNarraforkPath("search-provider-secrets.json");
		const set = (customProviders: NonNullable<NarraForkSettings["search"]>["customProviders"]) =>
			saveSettings({ ...settings, search: { channels: [], ...settings.search, customProviders } });
		try {
			const clearedHeaders: Array<Record<string, string> | undefined> = [
				{ Authorization: "" },
				{},
				undefined,
			];
			for (const clear of clearedHeaders) {
				set([provider("clear")]);
				set([{ ...provider("clear"), headers: clear }]);
				expect(reloadSettings().search?.customProviders[0].headers).toEqual(
					clear && Object.keys(clear).length ? clear : undefined,
				);
				expect(readFileSync(getNarraforkPath("settings.json"), "utf8")).not.toContain(
					"secret-api-key",
				);
			}
			set([provider("clear")]);
			set([]);
			expect(readSecretJSON(path)).toEqual({});
			set([{ ...provider("clear"), headers: undefined }]);
			expect(reloadSettings().search?.customProviders[0].headers).toBeUndefined();
		} finally {
			saveSettings(saved);
		}
	});

	test("an unreadable headers file leaves its only copy and inline headers intact on actual settings save", () => {
		const saved = structuredClone(settings);
		const path = freshPath();
		writeFileSync(path, foreign);
		const broken = new SearchHeaderSecrets(path);
		expect(broken.readable).toBe(false);
		const mock = spyOn(searchSecrets, "getSearchHeaderSecrets").mockReturnValue(broken);
		try {
			const next = {
				...settings,
				search: {
					channels: [],
					...settings.search,
					customProviders: [{ ...provider("blocked"), apiKey: "blocked-search-key" }],
				},
			};
			expect(broken.absorb(next)).toBe(false);
			saveSettings(next);
			expect(settings.search?.customProviders[0].headers).toEqual(headers);
			const disk = JSON.parse(readFileSync(getNarraforkPath("settings.json"), "utf8"));
			expect(disk.search.customProviders[0].headers).toEqual(headers);
			expect(disk.search.customProviders[0]).not.toHaveProperty("apiKey");
			expect(settings.search?.customProviders[0].apiKey).toBe("blocked-search-key");
			expect(readFileSync(path, "utf8")).toBe(foreign);
		} finally {
			mock.mockRestore();
			saveSettings(saved);
		}
	});

	test("an unreadable provider-key file does not prevent migrating the independent headers file", () => {
		const saved = structuredClone(settings);
		const path = freshPath();
		writeFileSync(path, foreign);
		const mock = spyOn(providerKeys, "getProviderKeyStore").mockReturnValue(
			new ProviderKeyStore(path),
		);
		try {
			saveSettings({
				...settings,
				nugProviders: [
					{
						id: "blocked-oauth",
						name: "OAuth",
						prefix: "blockedoauth",
						baseUrl: "https://nug.example",
						defaultModel: "",
						apiKey: "inline-nug-key",
						oauthClientSecret: "inline-oauth-secret",
					},
				],
				search: {
					channels: [],
					...settings.search,
					customProviders: [{ ...provider("independent"), apiKey: "inline-api-key" }],
				},
			});
			const disk = JSON.parse(readFileSync(getNarraforkPath("settings.json"), "utf8"));
			expect(disk.search.customProviders[0].apiKey).toBe("inline-api-key");
			expect(disk.nugProviders[0].oauthClientSecret).toBe("inline-oauth-secret");
			expect(settings.nugProviders?.[0].oauthClientSecret).toBe("inline-oauth-secret");
			expect(disk.search.customProviders[0].headers).toEqual({ "X-Ordinary": "  public value  " });
			expect(settings.search?.customProviders[0].headers).toEqual(headers);
			expect(readFileSync(path, "utf8")).toBe(foreign);
		} finally {
			mock.mockRestore();
			saveSettings(saved);
		}
	});

	test("malformed maps are also protected from overwrite", () => {
		const path = freshPath();
		writeSecretJSON(path, { one: { Authorization: 42 } });
		const original = readFileSync(path, "utf8");
		const broken = new SearchHeaderSecrets(path);
		const next = { search: { customProviders: [provider("one")] } } as unknown as NarraForkSettings;
		expect(broken.absorb(next)).toBe(false);
		broken.sync(next);
		broken.prune(next);
		broken.rewrite();
		expect(broken.without(next)).toBe(next);
		expect(readFileSync(path, "utf8")).toBe(original);
	});
});
