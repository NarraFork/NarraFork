import { afterAll, expect, spyOn, test } from "bun:test";
import { seedUnifiedCredentials } from "../../../tests/unified-credentials";
import { getCodexManager } from "../codex-manager";
import { getCredentialStore } from "../credential-store";
import {
	applyCredentialImport,
	exportCredentials,
	previewCredentialImport,
} from "../credential-transfer";
import { openBundle, sealBundle } from "../credential-transfer/bundle";
import { getProviderKeyStore } from "../provider-keys";
import { settings } from "../settings";

const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
	new Error("Network disabled in transfer test"),
);
afterAll(() => {
	fetch.mockRestore();
});
seedUnifiedCredentials();
const PASSPHRASE = "unified transfer passphrase";
const actor = { userId: "admin" };

test("legacy and new wire items share unified storage without losing choices or other key owners", async () => {
	const keys = getProviderKeyStore();
	const search = keys.add("search:keep", { apiKey: "keep-search" });
	const text = await sealBundle(
		{
			exportedAt: 1,
			items: [
				{ kind: "future", id: "unknown", label: "Unsupported", data: {} },
				{
					kind: "api-key",
					id: "old-key",
					label: "Legacy",
					data: {
						provider: {
							id: "unified-relay",
							name: "Relay",
							prefix: "unified-relay",
							baseUrl: "https://relay.example/v1",
							protocol: "completions-compatible",
							defaultModel: "",
						},
						key: { apiKey: "relay-secret" },
					},
				},
				{
					kind: "codex",
					id: "old-codex",
					label: "Account",
					data: {
						id: "old-codex",
						displayName: "user@example.com",
						accessToken: "codex-access",
						refreshToken: "codex-refresh",
						sub: "stable-sub",
						priority: 0,
						disabled: false,
					},
				},
			],
		},
		PASSPHRASE,
	);
	const preview = await previewCredentialImport(text, PASSPHRASE);
	expect(preview.items.map((item) => [item.index, item.kind, !!item.unsupported])).toEqual([
		[0, "future", true],
		[1, "credential", false],
		[2, "credential", false],
	]);
	expect(
		await applyCredentialImport(
			text,
			PASSPHRASE,
			new Map([
				[0, "import"],
				[2, "import"],
			]),
			actor,
		),
	).toEqual({ added: 1, replaced: 0, skipped: 2 });
	expect(settings.customApiProviders?.find((p) => p.id === "unified-relay")).toBeUndefined();
	expect(await applyCredentialImport(text, PASSPHRASE, new Map([[1, "import"]]), actor)).toEqual({
		added: 1,
		replaced: 0,
		skipped: 2,
	});
	const key = keys.listGroup("unified-relay")[0];
	const codex = getCodexManager().exportForTransfer()[0];
	expect(key?.id).not.toBe("old-key");
	expect(codex?.id).not.toBe("old-codex");
	expect(keys.get(search.id)?.apiKey).toBe("keep-search");
	const store = getCredentialStore();
	expect(store.unified).toBe(true);
	expect(store.keyCredentials().credentials.map((c) => c.id)).toContain(key?.id);
	expect(store.codexCredentials().map((c) => c.id)).toContain(codex?.id);
	const exported = await exportCredentials(undefined, PASSPHRASE, actor);
	const opened = await openBundle(exported.text, PASSPHRASE);
	expect(opened.items).toHaveLength(2);
	expect(opened.items.every((item) => item.kind === "credential")).toBe(true);
	const newPreview = await previewCredentialImport(exported.text, PASSPHRASE);
	expect(newPreview.items.map((item) => item.existingId)).toEqual(
		expect.arrayContaining([key?.id, codex?.id]),
	);
	expect(
		await applyCredentialImport(
			exported.text,
			PASSPHRASE,
			new Map([
				[0, "import"],
				[1, "import"],
			]),
			actor,
		),
	).toEqual({ added: 0, replaced: 0, skipped: 2 });
	expect(
		(await exportCredentials([{ kind: "future", id: key?.id ?? "" }], PASSPHRASE, actor)).count,
	).toBe(0);
});
