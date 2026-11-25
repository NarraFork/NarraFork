import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { seedUnifiedCredentials } from "../../../tests/unified-credentials";
import {
	completeTokenDanceOAuth,
	createTokenDancePaymentSession,
	getTokenDanceConnection,
	getTokenDancePaymentSession,
	startTokenDanceOAuth,
} from "../../services/tokendance-service";
import { PooledProvider, selectProviderKey, usableProviderKeys } from "../agent/pooled-provider";
import { TokenDanceProvider } from "../agent/tokendance-provider";
import { getCredentialStore } from "../credential-store";
import { applyCredentialImport } from "../credential-transfer";
import { sealBundle } from "../credential-transfer/bundle";
import {
	type CredentialTransferData,
	collectProviderTransferItems,
	exportCredentialItems,
	importCredentialItems,
	restoreProviderTransferItems,
	transferGroupKey,
} from "../credential-transfer/kinds";
import { getNarraforkPath } from "../narrafork-home";
import {
	getProviderKeyStore,
	isTokenDanceLoginKey,
	tokenDanceLoginAccount,
} from "../provider-keys";
import { readSecretJSON } from "../secret-store";
import { reloadSettings, saveSettings, settings } from "../settings";

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

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = undefined;
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

	// Old packages lack account metadata: the same secret must retain locally proven
	// provenance, without promoting the unrelated manual key in first position.
	const missingMarker = structuredClone(data.find((item) => item.credential?.account));
	if (!missingMarker?.credential) throw new Error("portable login missing");
	delete missingMarker.credential.account;
	const restoredManual = store.listGroup("tokendance").find((key) => key.apiKey === MANUAL);
	if (!restoredManual) throw new Error("restored manual key missing");
	store.reorder("tokendance", [restoredManual.id, restoredLogin.id]);
	const generation = getTokenDanceConnection().generation;
	const oldItem = { kind: "credential", id: "login", label: "Login", data: missingMarker };
	expect(await importCredentialItems([oldItem], () => "add")).toEqual({
		added: 0,
		replaced: 0,
		skipped: 1,
	});
	expect(
		restoreProviderTransferItems(
			[missingMarker],
			new Map([[transferGroupKey("tokendance", "tokendance"), { id: "tokendance" }]]),
		),
	).toEqual({ imported: 1, failed: 0 });
	expect(await importCredentialItems([oldItem], () => "replace")).toEqual({
		added: 0,
		replaced: 1,
		skipped: 0,
	});
	expect(loginKeys().map((key) => key.id)).toEqual([restoredLogin.id]);
	expect(store.get(restoredManual.id)?.account).toBeUndefined();
	expect(getTokenDanceConnection().generation).toBe(generation);
	const auth = mockPortal();
	await checkout("legacy");
	expect(auth).toEqual([`Bearer ${LOGIN}`]);
});

function mockPortal(returnedKey = "oauth-returned-account-B") {
	const authorization: string[] = [];
	let receipt = 0;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const url = String(input);
				if (url.endsWith("/auth/keys")) return Response.json({ key: returnedKey });
				if (url.endsWith("/models")) return Response.json({ data: [] });
				authorization.push(new Headers(init?.headers).get("Authorization") ?? "");
				if (url.endsWith("/chat/completions")) {
					return Response.json({
						id: "completion",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "new-account-response" },
								finish_reason: "stop",
							},
						],
					});
				}
				const seconds = Math.floor(Date.now() / 1000);
				const id = `receipt-${++receipt}`;
				return Response.json({
					session: {
						id,
						amount: 10,
						status: "pending",
						payment_url: "https://pay.example/qr",
						status_url: `https://tokendance.space/portal/api/v1/payment/sessions/${id}`,
						created_at: seconds,
						expired_at: seconds + 600,
					},
				});
			},
			{ preconnect: () => {} },
		),
	);
	return authorization;
}

function checkout(requestId: string, generation = getTokenDanceConnection().generation) {
	const billingInstance = getTokenDanceConnection().billingInstance;
	if (!billingInstance) throw new Error("missing billing instance");
	return createTokenDancePaymentSession("admin", {
		amount: 10,
		generation,
		billingInstance,
		requestId: requestId.repeat(20),
	});
}

function portableLogin(secret: string) {
	return {
		kind: "credential",
		id: "remote-login",
		label: "Remote OAuth",
		data: {
			templateId: "tokendance",
			group: { id: "tokendance", prefix: "tokendance", name: "TokenDance" },
			credential: {
				target: { groupId: "tokendance" },
				ownerUserId: null,
				priority: 0,
				createdAt: 1,
				account: tokenDanceLoginAccount(secret),
				auth: { kind: "api_key", apiKey: secret },
			},
		},
	};
}

test("adding another OAuth secret preserves the portal account; explicit replacement invalidates billing", async () => {
	const auth = mockPortal();
	const first = portableLogin("oauth-original-account-A");
	const second = portableLogin("oauth-imported-account-B");
	expect(await importCredentialItems([first], () => "add")).toEqual({
		added: 1,
		replaced: 0,
		skipped: 0,
	});
	const firstLogin = loginKeys()[0];
	if (!firstLogin) throw new Error("first binding missing");
	const before = getTokenDanceConnection().generation;
	const receipt = await checkout("a");
	const manual = store.addGroupCredential("tokendance", "tokendance", {
		apiKey: "independent-manual-key",
		label: "Keep manual",
		network: { extraHeaders: { "X-Manual": "preserved" } },
	});
	expect(await importCredentialItems([second], () => "add")).toEqual({
		added: 1,
		replaced: 0,
		skipped: 0,
	});
	const backup = store
		.listGroup("tokendance")
		.find((key) => key.apiKey === "oauth-imported-account-B");
	if (!backup) throw new Error("backup missing");
	store.reorder("tokendance", [backup.id, firstLogin.id]);
	const manualBefore = structuredClone(store.get(manual.id));
	expect(loginKeys().map((key) => key.id)).toEqual([firstLogin.id]);
	expect(getTokenDanceConnection().generation).toBe(before);
	await checkout("b");
	expect(auth).toEqual(Array(2).fill("Bearer oauth-original-account-A"));
	expect(await importCredentialItems([second], () => "replace")).toEqual({
		added: 0,
		replaced: 1,
		skipped: 0,
	});
	expect(loginKeys().map((key) => key.id)).toEqual([backup.id]);
	expect(getTokenDanceConnection().generation).toBeGreaterThan(before);
	await expect(checkout("c", before)).rejects.toThrow("changed");
	await expect(getTokenDancePaymentSession("admin", receipt.id)).rejects.toHaveProperty(
		"statusCode",
		404,
	);
	expect(store.get(firstLogin.id)).toMatchObject({ disabled: true });
	expect(store.get(firstLogin.id)?.account).toBeUndefined();
	expect(store.get(manual.id)).toEqual(manualBefore);
	store.reorder("tokendance", [firstLogin.id, backup.id]);
	expect(selectProviderKey("builtin:tokendance", "after-explicit-login-replacement")?.apiKey).toBe(
		"oauth-imported-account-B",
	);
	expect(
		usableProviderKeys("builtin:tokendance").some(
			(key) => key.apiKey === "oauth-original-account-A",
		),
	).toBe(false);
	const pool = new PooledProvider(
		"builtin:tokendance",
		(key) =>
			new TokenDanceProvider(key.apiKey, {
				apiKey: key.apiKey,
				generation: getTokenDanceConnection().generation,
				disabled: false,
				models: [
					{
						id: "inference-test",
						name: "Inference",
						context_length: 128_000,
						supported_protocols: ["openai:chat-completions"],
					},
				],
			}),
	);
	expect(await pool.generate("probe after login replacement", "tokendance:inference-test")).toBe(
		"new-account-response",
	);
	await checkout("d");
	expect(auth).toEqual([
		"Bearer oauth-original-account-A",
		"Bearer oauth-original-account-A",
		"Bearer oauth-imported-account-B",
		"Bearer oauth-imported-account-B",
	]);
});

test("an explicit wire replace can switch login even when the imported secret is new locally", async () => {
	mockPortal();
	await importCredentialItems([portableLogin("oauth-original-account-A")], () => "add");
	const before = getTokenDanceConnection().generation;
	const passphrase = "explicit binding replacement";
	const text = await sealBundle(
		{ exportedAt: 1, items: [portableLogin("oauth-imported-account-B")] },
		passphrase,
	);
	expect(
		await applyCredentialImport(text, passphrase, new Map([[0, "replace"]]), { userId: "admin" }),
	).toEqual({ added: 1, replaced: 0, skipped: 0 });
	expect(loginKeys().map((key) => key.apiKey)).toEqual(["oauth-imported-account-B"]);
	expect(getTokenDanceConnection().generation).toBeGreaterThan(before);
});

test.each([
	"replace",
	"add",
] as const)("a migrated unmarked login requires an explicit %s choice after loading blank settings", async (mode) => {
	saveSettings({
		...settings,
		tokendance: { apiKey: "old-unmarked-account-A", generation: 20, disabled: false },
	});
	const old = store.listGroup("tokendance")[0];
	if (!old) throw new Error("legacy slot missing");
	const manual = store.addGroupCredential("tokendance", "tokendance", {
		apiKey: "independent-manual-key",
		label: "Manual",
	});
	const manualBefore = structuredClone(manual);
	const disk = readSecretJSON(getNarraforkPath("settings.json")) as {
		tokendance: { apiKey: string };
	};
	expect(disk.tokendance.apiKey).toBe("");
	reloadSettings();
	expect(store.listGroup("tokendance").some(isTokenDanceLoginKey)).toBe(false);
	expect(getTokenDanceConnection().unboundKeys?.map((key) => key.id)).toContain(old.id);
	const callback = new URL("https://ui.example/settings/providers/tokendance/callback");
	expect(() => startTokenDanceOAuth("admin", callback)).toThrow("Choose an old login key");
	const auth = mockPortal();
	const choice = mode === "replace" ? { mode, credentialId: old.id } : { mode };
	const flow = startTokenDanceOAuth("admin", callback, undefined, choice);
	expect(store.get(old.id)?.apiKey).toBe("old-unmarked-account-A");
	await completeTokenDanceOAuth("admin", flow.flowId, "one-time-code");
	expect(store.get(manual.id)).toEqual(manualBefore);
	expect(loginKeys()).toHaveLength(1);
	if (mode === "replace") {
		expect(store.get(old.id)?.apiKey).toBe("oauth-returned-account-B");
		expect(selectProviderKey("builtin:tokendance", "upgraded-session")?.apiKey).toBe(
			"oauth-returned-account-B",
		);
		expect(
			usableProviderKeys("builtin:tokendance").some(
				(key) => key.apiKey === "old-unmarked-account-A",
			),
		).toBe(false);
	} else {
		expect(store.get(old.id)?.apiKey).toBe("old-unmarked-account-A");
		expect(store.firstGroupKey("tokendance")).toBe("old-unmarked-account-A");
		expect(store.get(old.id)?.priority).toBe(0);
	}
	await checkout(mode === "replace" ? "r" : "k");
	expect(auth).toEqual(["Bearer oauth-returned-account-B"]);
});

test.each([
	"upstream-failure",
	"edited",
	"removed",
	"reassigned",
])("an explicit old-slot selection is never written when %s", async (failure) => {
	saveSettings({
		...settings,
		tokendance: { apiKey: "old-unmarked-account-A", generation: 40, disabled: false },
	});
	const old = store.listGroup("tokendance")[0];
	if (!old) throw new Error("legacy slot missing");
	const flow = startTokenDanceOAuth(
		"admin",
		new URL("https://ui.example/settings/providers/tokendance/callback"),
		undefined,
		{ mode: "replace", credentialId: old.id },
	);
	mockPortal();
	if (failure === "edited") store.update(old.id, { apiKey: "edited-manual-key" });
	if (failure === "removed" || failure === "reassigned") store.remove(old.id);
	if (failure === "reassigned")
		store.add("unrelated-provider", { id: old.id, apiKey: "keep-unrelated-key" });
	if (failure === "upstream-failure")
		fetchSpy?.mockResolvedValue(Response.json({ error: "refused" }, { status: 502 }));
	const path = getCredentialStore().path;
	const before = readFileSync(path);
	await expect(completeTokenDanceOAuth("admin", flow.flowId, "one-time-code")).rejects.toThrow(
		"TokenDance",
	);
	expect(readFileSync(path)).toEqual(before);
	expect(store.listGroup("tokendance").some(isTokenDanceLoginKey)).toBe(false);
	if (failure === "reassigned") store.remove(old.id);
});
