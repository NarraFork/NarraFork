import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	canonicalKitBody,
	type KitSignedFields,
	kitFileSha256,
	resetKitSigningKeyForTest,
	signKitFields,
	verifyKitFields,
} from "./kit-signature";

const savedHome = process.env.NARRAFORK_HOME;
let home = "";
beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "nf-ui-kit-signing-"));
	process.env.NARRAFORK_HOME = home;
	resetKitSigningKeyForTest();
});
afterEach(() => {
	process.env.NARRAFORK_HOME = home;
	resetKitSigningKeyForTest();
});
afterAll(async () => {
	if (savedHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = savedHome;
	resetKitSigningKeyForTest();
	await rm(home, { recursive: true, force: true });
});

const fields: KitSignedFields = {
	version: 1,
	workspace: "workspace",
	fingerprint: "f".repeat(64),
	hash: "0123456789abcdef0123",
	builtAt: "2026-01-01T00:00:00.000Z",
	components: ["Button", "Card"],
	hasSetup: true,
	js: "kit-0123456789ab.js",
	css: "kit-0123456789ab.css",
	generation: 3,
	jsSha256: kitFileSha256(new TextEncoder().encode("js")),
	cssSha256: kitFileSha256(new TextEncoder().encode("css")),
};

describe("kit signature", () => {
	test("the canonical body has a fixed key order and nothing else", () => {
		const extra = { ...fields, signature: "x", other: 1 } as KitSignedFields;
		expect(Object.keys(JSON.parse(canonicalKitBody(extra)))).toEqual([
			"version",
			"workspace",
			"fingerprint",
			"hash",
			"builtAt",
			"components",
			"hasSetup",
			"js",
			"css",
			"generation",
			"jsSha256",
			"cssSha256",
		]);
	});

	test("the same fields give the same HMAC, and it verifies", async () => {
		const first = await signKitFields(fields);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		// Field order in the input does not matter; the key is read back from disk.
		resetKitSigningKeyForTest();
		const reordered = Object.fromEntries(Object.entries(fields).reverse()) as KitSignedFields;
		expect(await signKitFields(reordered)).toBe(first);
		expect(await verifyKitFields(fields, first)).toBe(true);
	});

	test("any changed field fails verification", async () => {
		const signature = await signKitFields(fields);
		for (const tampered of [
			{ ...fields, workspace: "other-workspace" },
			{ ...fields, hash: "1123456789abcdef0123" },
			{ ...fields, components: ["Button"] },
			{ ...fields, hasSetup: false },
			{ ...fields, js: "kit.js" },
			{ ...fields, css: null },
			{ ...fields, generation: 4 },
			{ ...fields, jsSha256: kitFileSha256(new TextEncoder().encode("jS")) },
			{ ...fields, cssSha256: "" },
		])
			expect(await verifyKitFields(tampered, signature)).toBe(false);
	});

	test("a malformed or wrong-length signature fails closed instead of throwing", async () => {
		const signature = await signKitFields(fields);
		for (const bad of [
			undefined,
			null,
			42,
			"",
			signature.slice(0, 62),
			`${signature}00`,
			signature.toUpperCase(),
			`${signature.slice(0, 63)}g`,
			"0".repeat(64),
		])
			expect(await verifyKitFields(fields, bad)).toBe(false);
	});

	test("the key lives in the NarraFork home, private, created once; another home cannot verify", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "nf-ui-kit-signing-workspace-"));
		try {
			const signature = await signKitFields(fields);
			const keyPath = join(home, "intelligent-ui-kit-signing.key");
			expect(existsSync(keyPath)).toBe(true);
			expect(relative(workspace, keyPath).startsWith("..")).toBe(true);
			const key = await readFile(keyPath);
			expect(key).toHaveLength(32);
			if (process.platform !== "win32") expect(statSync(keyPath).mode & 0o777).toBe(0o600);
			// Not rewritten by a later caller.
			resetKitSigningKeyForTest();
			await signKitFields(fields);
			expect(await readFile(keyPath)).toEqual(key);

			const other = await mkdtemp(join(tmpdir(), "nf-ui-kit-signing-other-"));
			try {
				process.env.NARRAFORK_HOME = other;
				resetKitSigningKeyForTest();
				expect(await verifyKitFields(fields, signature)).toBe(false);
			} finally {
				await rm(other, { recursive: true, force: true });
			}
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	test("concurrent first use agrees on one key", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "nf-ui-kit-signing-race-"));
		try {
			process.env.NARRAFORK_HOME = fresh;
			resetKitSigningKeyForTest();
			const first = signKitFields(fields);
			resetKitSigningKeyForTest();
			const second = signKitFields(fields);
			expect(await first).toBe(await second);
		} finally {
			await rm(fresh, { recursive: true, force: true });
		}
	});
});
