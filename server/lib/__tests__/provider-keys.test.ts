import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNarraforkPath } from "../narrafork-home";
import { getProviderKeyStore, ProviderKeyStore } from "../provider-keys";
import { readSecretJSON } from "../secret-store";
import { saveSettings, settings } from "../settings";
import { absorbProviderKeys } from "../settings/provider-keys-projection";
import type { CustomApiProviderConfig, NarraForkSettings } from "../settings/types";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore() {
	const dir = mkdtempSync(join(tmpdir(), "narrafork-provider-keys-"));
	dirs.push(dir);
	const path = join(dir, "provider-keys.json");
	return { path, store: new ProviderKeyStore(path) };
}

const provider = (id: string, apiKey: string): CustomApiProviderConfig => ({
	id,
	name: `Provider ${id}`,
	prefix: `p${id}`,
	apiKey,
	baseUrl: "https://api.example.com/v1",
	defaultModel: "m",
	protocol: "completions-compatible",
});

describe("provider key store", () => {
	test("first-key sync creates under the provider id, replaces, and clears only when asked", () => {
		const { store } = freshStore();
		expect(store.syncFirstKeys([{ id: "prov1", apiKey: "sk-1" }], { clearOnEmpty: true })).toBe(
			true,
		);
		expect(store.list("prov1").map((k) => [k.id, k.apiKey])).toEqual([["prov1", "sk-1"]]);

		store.add("prov1", { apiKey: "sk-2", label: "backup" });
		store.syncFirstKeys([{ id: "prov1", apiKey: "sk-1b" }], { clearOnEmpty: true });
		expect(store.list("prov1").map((k) => k.apiKey)).toEqual(["sk-1b", "sk-2"]);

		// Settings read back from disk carry no key: that must not delete anything.
		store.syncFirstKeys([{ id: "prov1", apiKey: "" }], { clearOnEmpty: false });
		expect(store.list("prov1")).toHaveLength(2);
		// Clearing the field in settings removes the first key; the next one moves up.
		store.syncFirstKeys([{ id: "prov1", apiKey: "" }], { clearOnEmpty: true });
		expect(store.firstKey("prov1")).toBe("sk-2");
	});

	test("reorder, disable and a new secret reviving an invalid key", () => {
		const { store } = freshStore();
		const a = store.add("p", { apiKey: "a" });
		const b = store.add("p", { apiKey: "b" });
		store.reorder("p", [b.id]);
		expect(store.list("p").map((k) => k.id)).toEqual([b.id, a.id]);
		store.update(a.id, { disabled: true, disabledReason: "invalid" });
		expect(store.get(a.id)?.disabledReason).toBe("invalid");
		store.update(a.id, { apiKey: "a2" });
		expect(store.get(a.id)?.disabled).toBeUndefined();
	});

	test("persists encrypted, reloads, and never overwrites a file it cannot read", () => {
		const { path, store } = freshStore();
		store.add("p", { apiKey: "sk-secret" });
		expect(readFileSync(path, "utf8")).not.toContain("sk-secret");
		expect(new ProviderKeyStore(path).firstKey("p")).toBe("sk-secret");

		const foreign = JSON.stringify({
			format: "narrafork.secret.v1",
			cipher: "aes-256-gcm",
			iv: "x",
			tag: "x",
			data: "x",
		});
		writeFileSync(path, foreign);
		const broken = new ProviderKeyStore(path);
		expect(broken.readable).toBe(false);
		expect(() => broken.add("p", { apiKey: "k" })).toThrow();
		expect(broken.syncFirstKeys([{ id: "p", apiKey: "k" }], { clearOnEmpty: true })).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(foreign);
	});
});

describe("settings projection", () => {
	test("settings.json keeps no key; memory shows the first key and follows the store", () => {
		const saved = structuredClone(settings.customApiProviders);
		try {
			saveSettings({ ...settings, customApiProviders: [provider("projA", "sk-projected")] });
			const disk = JSON.parse(readFileSync(getNarraforkPath("settings.json"), "utf8"));
			expect(JSON.stringify(disk)).not.toContain("sk-projected");
			expect(disk.customApiProviders[0].apiKey).toBe("");
			expect(settings.customApiProviders?.[0]?.apiKey).toBe("sk-projected");
			expect(settings.openaiProviders?.find((p) => p.id === "projA")?.apiKey).toBe("sk-projected");
			const stored = readSecretJSON(getNarraforkPath("provider-keys.json")) as Array<{
				id: string;
				apiKey: string;
			}>;
			expect(stored.find((k) => k.id === "projA")?.apiKey).toBe("sk-projected");

			// Removing the first key in the key list promotes the next one everywhere.
			const store = getProviderKeyStore();
			store.add("projA", { apiKey: "sk-second" });
			store.remove("projA");
			expect(settings.customApiProviders?.[0]?.apiKey).toBe("sk-second");
		} finally {
			saveSettings({ ...settings, customApiProviders: saved });
			getProviderKeyStore().removeProvider("projA");
		}
	});

	test("keys still in settings.json move into the store on load", () => {
		const loaded = {
			customApiProviders: [provider("legacyA", "sk-legacy")],
		} as NarraForkSettings;
		try {
			expect(absorbProviderKeys(loaded)).toBe(true);
			expect(getProviderKeyStore().firstKey("legacyA")).toBe("sk-legacy");
			// Next load: the file no longer has the key, and memory still does.
			const reloaded = {
				customApiProviders: [provider("legacyA", "")],
			} as NarraForkSettings;
			expect(absorbProviderKeys(reloaded)).toBe(false);
			expect(reloaded.customApiProviders?.[0]?.apiKey).toBe("sk-legacy");
		} finally {
			getProviderKeyStore().removeProvider("legacyA");
		}
	});
});
