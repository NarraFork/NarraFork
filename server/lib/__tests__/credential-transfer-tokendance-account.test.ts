import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { seedUnifiedCredentials } from "../../../tests/unified-credentials";
import {
	type CredentialTransferData,
	collectProviderTransferItems,
	exportCredentialItems,
	importCredentialItems,
	restoreProviderTransferItems,
	transferGroupKey,
} from "../credential-transfer/kinds";
import { getProviderKeyStore } from "../provider-keys";
import { saveSettings, settings } from "../settings";

seedUnifiedCredentials();
const original = structuredClone(settings);
const store = getProviderKeyStore();
const LOGIN = "tokendance-original-login";
const MANUAL = "tokendance-manual-first";
const account = {
	accountId: "tokendance-login",
	sub: createHash("sha256").update(LOGIN).digest("hex"),
};

function loginKeys() {
	return store
		.listGroup("tokendance")
		.filter((key) => key.account?.accountId === "tokendance-login");
}

afterEach(() => {
	store.removeGroup("tokendance");
	saveSettings(original);
});

test("TokenDance's login identity follows its key across reorder, credential transfer and data restore", async () => {
	saveSettings({ ...settings, tokendance: { apiKey: LOGIN, generation: 1, disabled: false } });
	const login = store.listGroup("tokendance")[0];
	if (!login) throw new Error("login key missing");
	const fields = { label: "OAuth login", account };
	store.update(login.id, fields);
	const manual = store.addGroupCredential("tokendance", "tokendance", { apiKey: MANUAL });
	store.reorder("tokendance", [manual.id, login.id]);
	expect(settings.tokendance?.apiKey).toBe(MANUAL);
	expect(loginKeys().map((key) => key.apiKey)).toEqual([LOGIN]);

	const exported = (await exportCredentialItems()).filter(
		(item) => (item.data as CredentialTransferData).templateId === "tokendance",
	);
	const data = exported.map((item) => item.data as CredentialTransferData);
	expect(
		data.map((item) => [
			item.credential?.auth.kind === "api_key" ? item.credential.auth.apiKey : "",
			item.credential?.account,
		]),
	).toEqual([
		[MANUAL, undefined],
		[LOGIN, account],
	]);
	expect(collectProviderTransferItems({ tokendance: settings.tokendance })).toEqual(exported);

	saveSettings({ ...settings, tokendance: undefined });
	store.removeGroup("tokendance");
	expect(await importCredentialItems(exported, () => "add")).toEqual({
		added: 2,
		replaced: 0,
		skipped: 0,
	});
	expect(settings.tokendance?.apiKey).toBe(MANUAL);
	expect(loginKeys().map((key) => key.apiKey)).toEqual([LOGIN]);

	// A settings save may already have recreated a key, without any transfer metadata.
	store.removeGroup("tokendance");
	saveSettings({ ...settings, tokendance: { apiKey: LOGIN, generation: 2, disabled: false } });
	expect(loginKeys()).toEqual([]);
	const restored = restoreProviderTransferItems(
		data,
		new Map([[transferGroupKey("tokendance", "tokendance"), { id: "tokendance" }]]),
	);
	expect(restored).toEqual({ imported: 2, failed: 0 });
	expect(loginKeys().map((key) => key.apiKey)).toEqual([LOGIN]);
	const restoredLogin = loginKeys()[0];
	if (!restoredLogin) throw new Error("restored login marker missing");
	expect(restoredLogin.account).toEqual(account);

	// A package lacking the login marker must not bind payment to whichever key is first.
	const missingMarker = structuredClone(data.find((item) => item.credential?.account));
	if (!missingMarker?.credential) throw new Error("portable login missing");
	delete missingMarker.credential.account;
	expect(
		await importCredentialItems(
			[{ kind: "credential", id: "login", label: "Login", data: missingMarker }],
			() => "replace",
		),
	).toEqual({
		added: 0,
		replaced: 1,
		skipped: 0,
	});
	expect(loginKeys()).toEqual([]);
});
