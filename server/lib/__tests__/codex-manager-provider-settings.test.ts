import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CodexCredential,
	CodexManager,
	MAX_CODEX_PROVIDER_SETTINGS_PAGE_SIZE,
	MAX_CODEX_PROVIDER_SETTINGS_SCAN,
} from "../codex-manager";
import { writeSecretJSON } from "../secret-store";

const SECRET = "identity-only-secret-never-return";
const managers: CodexManager[] = [];
const homes: string[] = [];

afterEach(() => {
	mock.restore();
	for (const manager of managers.splice(0)) manager.dispose();
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function credential(id: string, overrides: Partial<CodexCredential> = {}): CodexCredential {
	return {
		id,
		displayName: "Same account display",
		refreshToken: `${SECRET}-refresh-${id}`,
		accessToken: `${SECRET}-access-${id}`,
		accountId: `upstream-${id}`,
		priority: 0,
		disabled: false,
		...overrides,
	};
}

function create(credentials: CodexCredential[]) {
	const home = mkdtempSync(join(tmpdir(), "nf-codex-settings-identity-"));
	homes.push(home);
	mkdirSync(join(home, ".narrafork"), { recursive: true });
	const path = join(home, ".narrafork", "codex-credentials.json");
	writeSecretJSON(path, credentials);
	const manager = new CodexManager({ homeDir: home, registerProcessHooks: false });
	managers.push(manager);
	return { manager, path, home };
}

function forbidden(): never {
	throw new Error("An identity read accessed credentials, history or an execution path");
}

describe("CodexManager provider settings identities without any host startup", () => {
	test("exact lookup and pool/page projection are read-only and never access credentials or self-heal expired quota", () => {
		const { manager, path } = create([
			credential("saved", {
				disabled: true,
				disabledReason: "quota_exhausted",
				quotaResetsAt: Date.now() - 60_000,
			}),
		]);
		const before = readFileSync(path);
		const snapshot = spyOn(manager, "snapshot").mockImplementation(forbidden);
		const exporting = spyOn(manager, "exportForTransfer").mockImplementation(forbidden);
		const acquire = spyOn(manager, "acquireContext").mockImplementation(forbidden);
		const fetch = spyOn(globalThis, "fetch").mockImplementation(forbidden);
		const raw = (manager as unknown as { entries: CodexCredential[] }).entries[0];
		raw.displayName = JSON.stringify({ apiKey: SECRET });
		const secretRead = mock(forbidden);
		for (const key of [
			"refreshToken",
			"accessToken",
			"agentPrivateKey",
			"network",
			"usage",
			"usageHistory",
		]) {
			Object.defineProperty(raw, key, { get: secretRead, configurable: true });
		}
		const lookup = manager.getProviderSettingsIdentity("saved");
		expect(lookup).toEqual({ status: "found", identity: { id: "saved", disabled: true } });
		const page = manager.listProviderSettingsIdentities({ limit: 1 });
		expect(page).toEqual({
			status: "ok",
			identities: [{ id: "saved", disabled: true }],
			nextOffset: null,
		});
		expect(manager.getProviderSettingsPoolIdentity()).toEqual({
			status: "ok",
			exists: true,
			available: false,
		});
		expect(JSON.stringify([lookup, page])).not.toContain(SECRET);
		expect(readFileSync(path)).toEqual(before);
		for (const spy of [snapshot, exporting, acquire, fetch, secretRead])
			expect(spy).not.toHaveBeenCalled();
	});

	test("pages preserve real saved ids and lifecycle flags, never substitute upstream ids or display names", () => {
		const { manager } = create([
			credential("first"),
			credential("second", { disabled: true }),
			credential("third", { archivedAt: 123 }),
		]);
		const first = manager.listProviderSettingsIdentities({ limit: 2 });
		expect(first).toMatchObject({
			status: "ok",
			nextOffset: 2,
			identities: [
				{ id: "first", disabled: false },
				{ id: "second", disabled: true },
			],
		});
		if (first.status !== "ok") throw new Error("expected identity page");
		expect(Object.isFrozen(first.identities)).toBe(true);
		expect(first.identities.every(Object.isFrozen)).toBe(true);
		const next = manager.listProviderSettingsIdentities({
			offset: first.nextOffset ?? 0,
			limit: 2,
		});
		expect(next).toMatchObject({
			status: "ok",
			nextOffset: null,
			identities: [{ id: "third", archivedAt: 123 }],
		});
		expect(manager.getProviderSettingsIdentity("upstream-first")).toEqual({ status: "not-found" });
		expect(manager.getProviderSettingsIdentity("Same account display")).toEqual({
			status: "invalid",
		});
		expect(manager.getProviderSettingsIdentity("codex:first")).toEqual({ status: "invalid" });
		expect(JSON.stringify([first, next])).not.toContain(SECRET);
		for (const options of [
			{ limit: 0 },
			{ limit: MAX_CODEX_PROVIDER_SETTINGS_PAGE_SIZE + 1 },
			{ offset: -1 },
			{ offset: Number.MAX_SAFE_INTEGER },
		]) {
			expect(manager.listProviderSettingsIdentities(options)).toEqual({ status: "invalid" });
		}
	});

	test("a legacy ID generated only in memory is rejected until an existing explicit save persists it", () => {
		const { manager, path, home } = create([credential("legacy", { id: undefined as never })]);
		const before = readFileSync(path);
		const runtimeId = (manager as unknown as { entries: CodexCredential[] }).entries[0].id;
		expect(typeof runtimeId).toBe("string");
		expect(manager.getProviderSettingsIdentity(runtimeId)).toEqual({ status: "not-found" });
		expect(manager.listProviderSettingsIdentities()).toEqual({ status: "invalid" });
		// The stored pool slot is real even when its legacy account lacks a durable ID.
		expect(manager.getProviderSettingsPoolIdentity()).toMatchObject({ status: "ok", exists: true });
		expect(readFileSync(path)).toEqual(before);
		manager.updateCredential(runtimeId, { displayName: "Explicitly saved" });
		expect(manager.getProviderSettingsIdentity(runtimeId)).toMatchObject({
			status: "found",
			identity: { id: runtimeId },
		});
		const reopened = new CodexManager({ homeDir: home, registerProcessHooks: false });
		managers.push(reopened);
		expect(reopened.getProviderSettingsIdentity(runtimeId)).toMatchObject({
			status: "found",
			identity: { id: runtimeId, displayName: "Explicitly saved" },
		});
	});

	test("a failed save never publishes a newly generated account identity or an invented pool", () => {
		const { manager, path } = create([]);
		const before = readFileSync(path);
		(manager as unknown as { credentialsUnreadable: boolean }).credentialsUnreadable = true;
		manager.importCredentials([{ accessToken: "unsaved-access-token", displayName: "Unsaved" }]);
		const runtimeId = (manager as unknown as { entries: CodexCredential[] }).entries[0].id;
		expect(manager.getProviderSettingsIdentity(runtimeId)).toEqual({ status: "not-found" });
		expect(manager.listProviderSettingsIdentities()).toEqual({ status: "invalid" });
		expect(manager.getProviderSettingsPoolIdentity()).toEqual({ status: "invalid" });
		expect(readFileSync(path)).toEqual(before);
	});

	test("duplicate and oversized stored identities fail closed rather than selecting current/first or silently truncating", () => {
		const duplicate = create([
			credential("duplicate", { refreshToken: "refresh-one", accountId: "upstream-one" }),
			credential("duplicate", {
				refreshToken: "refresh-two",
				accessToken: "access-two",
				accountId: "upstream-two",
			}),
		]).manager;
		expect(duplicate.getProviderSettingsIdentity("duplicate")).toEqual({ status: "ambiguous" });
		expect(duplicate.getProviderSettingsPoolIdentity()).toEqual({ status: "ambiguous" });
		const oversized = create([]).manager;
		// Test-only state injection exercises the production bounds; there is no runtime fallback.
		(oversized as unknown as { entries: CodexCredential[] }).entries = Array.from(
			{ length: MAX_CODEX_PROVIDER_SETTINGS_SCAN + 1 },
			(_, index) => credential(`id-${index}`),
		);
		expect(oversized.getProviderSettingsIdentity("id-0")).toEqual({ status: "limit-exceeded" });
		expect(oversized.listProviderSettingsIdentities({ limit: 1 })).toEqual({
			status: "limit-exceeded",
		});
		expect(oversized.getProviderSettingsPoolIdentity()).toEqual({ status: "limit-exceeded" });
	});
});
