/**
 * Run a test file against an instance whose model credentials already live in
 * credentials.json (provider sourcing S1). The preload has loaded settings, and with them
 * the credential owners, before any test file runs; this seeds an empty credentials.json
 * and rebuilds those owners on it, as a migrated instance would start. Unified variants of
 * existing suites call it, then import the suite.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { __setCodexManagerForTests } from "../server/lib/codex-manager";
import { CREDENTIALS_FILE } from "../server/lib/credential-store";
import { getNarraforkHome } from "../server/lib/narrafork-home";
import { getProviderKeyStore, resetProviderKeyStoreForTests } from "../server/lib/provider-keys";
import { writeSecretJSON } from "../server/lib/secret-store";
import { settings } from "../server/lib/settings";
import { hydrateProviderKeys } from "../server/lib/settings/provider-keys-projection";

/** Returns a check that the suite really wrote credentials.json (each write is re-encrypted). */
export function seedUnifiedCredentials(): { written: () => boolean } {
	const path = resolve(getNarraforkHome(), CREDENTIALS_FILE);
	writeSecretJSON(path, { version: 1, credentials: [], groupSecrets: {} });
	const seeded = readFileSync(path, "utf8");
	resetProviderKeyStoreForTests();
	__setCodexManagerForTests(undefined);
	// What settings/index.ts registers on the store it created at load.
	getProviderKeyStore().onChange(() => hydrateProviderKeys(settings));
	hydrateProviderKeys(settings);
	return { written: () => readFileSync(path, "utf8") !== seeded };
}
