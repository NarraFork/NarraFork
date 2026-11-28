import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PluginPackageStore } from "../../../server/services/plugin-package-store";
import {
	isTrustedQuotaSettingsPackage,
	LEGACY_QUOTA_PACKAGE_HASH,
} from "../../../server/services/provider-quota-settings-compat";

test("archived 1.0.3 is identified by verified content, never a self-reported id/version", async () => {
	const archive = resolve("tests/fixtures/provider-quota-1.0.3.nfplugin");
	expect(
		createHash("sha256")
			.update(await readFile(archive))
			.digest("hex"),
	).toBe("5491feaad8e0d35a92b9f49edfc24eb02c618d0fc6710fdca3a235c486c7a24f");
	const root = await mkdtemp(join(tmpdir(), "nf-legacy-quota-proof-"));
	try {
		const installed = await new PluginPackageStore(root).install(archive);
		expect(installed.hash).toBe(LEGACY_QUOTA_PACKAGE_HASH);
		expect(
			await isTrustedQuotaSettingsPackage(installed.pluginId, installed.version, installed.hash),
		).toBe(true);
		expect(
			await isTrustedQuotaSettingsPackage(installed.pluginId, installed.version, "f".repeat(64)),
		).toBe(false);
		expect(
			await isTrustedQuotaSettingsPackage("com.other.plugin", installed.version, installed.hash),
		).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
