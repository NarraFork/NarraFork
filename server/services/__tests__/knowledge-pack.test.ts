/**
 * Pack lifecycle + security tests.
 *
 * Exercises the pack service (create/ACL/delete) and the activation service
 * (extract via safeSpawn → whitelist registration → cleanup) against a real
 * isolated DB under a temp NARRAFORK_HOME. Builds real .tar.gz archives with the
 * system `tar` so extraction goes through the production code path.
 *
 * Security focus: zip-slip containment (a `../escape` entry must be refused) and
 * dual-axis ACL filtering (a higher-clearance pack is hidden from a baseline user).
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/knowledge-pack.test.ts
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { db } from "../../db";
import { narrators, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { packActivationService } from "../knowledge-pack-activation-service";
import { knowledgePackService } from "../knowledge-pack-service";

const TAG = Date.now();
let userId: string;
let narratorId: string;
let workRoot: string;

const principal = (): { userId: string; role: "user" } => ({ userId, role: "user" });

/** Build a File from an on-disk archive path (so the service re-reads real bytes). */
async function fileFromPath(path: string, name: string): Promise<File> {
	const buf = await Bun.file(path).arrayBuffer();
	return new File([buf], name, { type: "application/gzip" });
}

/** tar a map of relative path → contents into <workRoot>/<name>.tar.gz, return its path. */
function buildTarGz(name: string, files: Record<string, string>): string {
	const srcDir = mkdtempSync(resolve(workRoot, "src-"));
	for (const [rel, content] of Object.entries(files)) {
		const full = resolve(srcDir, rel);
		mkdirSync(resolve(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	const archivePath = resolve(workRoot, `${name}.tar.gz`);
	const res = Bun.spawnSync(["tar", "-czf", archivePath, "-C", srcDir, "."]);
	if (res.exitCode !== 0) {
		throw new Error(`tar failed: ${new TextDecoder().decode(res.stderr)}`);
	}
	return archivePath;
}

/** Build a .tar.gz containing a zip-slip entry (../escape.txt) and return it as a File. */
async function makeZipSlipArchive(name: string): Promise<File> {
	const srcDir = mkdtempSync(resolve(workRoot, "evil-"));
	writeFileSync(resolve(srcDir, "ok.txt"), "benign");
	const archivePath = resolve(workRoot, `${name}.tar.gz`);
	// Craft a tar whose member name contains a parent traversal. GNU tar lets us add
	// a file under a transformed name via --transform, producing a ../ member path.
	const res = Bun.spawnSync([
		"tar",
		"-czf",
		archivePath,
		"-C",
		srcDir,
		"--transform",
		"s,^ok.txt,../escape.txt,",
		"ok.txt",
	]);
	if (res.exitCode !== 0) {
		throw new Error(`tar failed: ${new TextDecoder().decode(res.stderr)}`);
	}
	return fileFromPath(archivePath, `${name}.tar.gz`);
}

beforeAll(async () => {
	workRoot = mkdtempSync(resolve(tmpdir(), "pack-test-"));
	const now = new Date().toISOString();
	userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: `pack-user-${TAG}`,
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});
	narratorId = generateId();
	await db.insert(narrators).values({ id: narratorId, createdAt: now, updatedAt: now });
});

describe("pack create + activate + cleanup", () => {
	test("create a pack, activate it, and verify whitelist + extracted files", async () => {
		const archivePath = buildTarGz("good", {
			"hello.txt": "hi there",
			"sub/data.json": '{"k":1}',
		});
		const archive = await fileFromPath(archivePath, "good.tar.gz");

		const pack = await knowledgePackService.createPack({
			name: `Good Pack ${TAG}`,
			archive,
			ownerUserId: userId,
		});
		expect(pack.id).toBeTruthy();
		expect(pack.archiveFormat).toBe("tar.gz");
		expect(pack.archiveHash).toMatch(/^[0-9a-f]{64}$/);

		const result = await packActivationService.activate(narratorId, pack.id, principal());
		expect(existsSync(result.extractDir)).toBe(true);
		expect(result.files.sort()).toEqual(["hello.txt", "sub/data.json"]);
		expect(result.reused).toBe(false);

		// A readWrite whitelist row for the extract dir must now exist for the narrator.
		const wl = await db.query.narratorWhitelistDirs.findMany({
			where: (w, { and, eq }) => and(eq(w.narratorId, narratorId), eq(w.path, result.extractDir)),
		});
		expect(wl.length).toBe(1);
		expect(wl[0].accessLevel).toBe("readWrite");

		// Re-activating reuses the same extraction (idempotent, same hash).
		const again = await packActivationService.activate(narratorId, pack.id, principal());
		expect(again.reused).toBe(true);
		expect(again.extractDir).toBe(result.extractDir);

		// Deactivate removes the dir + the whitelist row.
		const res = await packActivationService.deactivate(narratorId, pack.id);
		expect(res.released).toBe(true);
		expect(existsSync(result.extractDir)).toBe(false);
		const wlAfter = await db.query.narratorWhitelistDirs.findMany({
			where: (w, { and, eq }) => and(eq(w.narratorId, narratorId), eq(w.path, result.extractDir)),
		});
		expect(wlAfter.length).toBe(0);
	});

	test("zip-slip: an archive escaping the extract dir is refused and cleaned up", async () => {
		const archive = await makeZipSlipArchive(`evil-${TAG}`);
		const pack = await knowledgePackService.createPack({
			name: `Evil Pack ${TAG}`,
			archive,
			ownerUserId: userId,
		});
		await expect(packActivationService.activate(narratorId, pack.id, principal())).rejects.toThrow(
			/zip-slip|escape/i,
		);

		// No whitelist row should have been created for this pack's narrator/dir.
		const wl = await db.query.narratorWhitelistDirs.findMany({
			where: (w, { eq }) => eq(w.narratorId, narratorId),
		});
		// The earlier test's dir was already released; nothing from the evil pack remains.
		for (const row of wl) {
			expect(row.path).not.toContain(pack.id);
		}
	});
});

describe("pack ACL filtering", () => {
	test("a higher-clearance pack is hidden from a baseline user in listPacks", async () => {
		// Standalone pack classified "secret" (baseline users have public clearance only).
		const secretArchive = await fileFromPath(
			buildTarGz("secret", { "s.txt": "top secret" }),
			"secret.tar.gz",
		);
		const secretPack = await knowledgePackService.createPack({
			name: `Secret Pack ${TAG}`,
			archive: secretArchive,
			classificationLevel: "secret",
			// No ownerUserId → the baseline user is not the owner, so ACL applies.
		});

		// The baseline user must NOT see the secret pack...
		const visible = await knowledgePackService.listPacks(principal(), {});
		expect(visible.some((p) => p.id === secretPack.id)).toBe(false);

		// ...and getPack must throw (NotFound, not leaking existence).
		await expect(knowledgePackService.getPack(secretPack.id, principal())).rejects.toThrow();

		// An admin sees it (admin short-circuits ACL).
		const adminView = await knowledgePackService.getPack(secretPack.id, {
			userId: "admin-x",
			role: "admin",
		});
		expect(adminView.id).toBe(secretPack.id);
	});
});

describe("pack archive validation", () => {
	test("rejects an unsupported archive type", async () => {
		const bad = new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" });
		await expect(
			knowledgePackService.createPack({ name: `Bad ${TAG}`, archive: bad }),
		).rejects.toThrow(/Unsupported pack archive type/i);
	});
});

describe("pack management authorization (write actions)", () => {
	// A second baseline user who is NOT the owner of the pack under test.
	let otherUserId: string;
	const otherPrincipal = (): { userId: string; role: "user" } => ({
		userId: otherUserId,
		role: "user",
	});

	beforeAll(async () => {
		otherUserId = generateId();
		await db.insert(users).values({
			id: otherUserId,
			username: `pack-other-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
	});

	/** Create a PUBLIC pack owned by the primary user (readable by everyone). */
	async function makePublicPack(label: string): Promise<string> {
		const archive = await fileFromPath(
			buildTarGz(label, { "a.txt": "content" }),
			`${label}.tar.gz`,
		);
		const pack = await knowledgePackService.createPack({
			name: `${label} ${TAG}`,
			archive,
			ownerUserId: userId, // owned by the primary user
		});
		return pack.id;
	}

	test("a non-owner who CAN read a public pack still cannot update its metadata/ACL", async () => {
		const packId = await makePublicPack("mgmt-update");
		// Sanity: the other user can read it (it is public).
		expect((await knowledgePackService.getPack(packId, otherPrincipal())).id).toBe(packId);
		// ...but cannot manage it.
		await expect(
			knowledgePackService.updatePackMeta(
				packId,
				{ classificationLevel: "secret" },
				otherPrincipal(),
			),
		).rejects.toThrow(/permission/i);
		// The ACL was not changed.
		const after = await knowledgePackService.getPack(packId, { userId: "admin-x", role: "admin" });
		expect(after.classificationLevel).toBeNull();
	});

	test("a non-owner cannot replace the archive of a readable pack", async () => {
		const packId = await makePublicPack("mgmt-replace");
		const original = await knowledgePackService.getPack(packId, {
			userId: "admin-x",
			role: "admin",
		});
		const replacement = await fileFromPath(
			buildTarGz("mgmt-replace-evil", { "evil.sh": "rm -rf /" }),
			"evil.tar.gz",
		);
		await expect(
			knowledgePackService.replaceArchive(packId, replacement, otherPrincipal()),
		).rejects.toThrow(/permission/i);
		// The archive hash is unchanged (bytes were not swapped).
		const after = await knowledgePackService.getPack(packId, { userId: "admin-x", role: "admin" });
		expect(after.archiveHash).toBe(original.archiveHash);
	});

	test("a non-owner cannot delete a readable pack", async () => {
		const packId = await makePublicPack("mgmt-delete");
		await expect(knowledgePackService.deletePack(packId, otherPrincipal())).rejects.toThrow(
			/permission/i,
		);
		// Still exists.
		expect((await knowledgePackService.getPack(packId, otherPrincipal())).id).toBe(packId);
	});

	test("the owner can manage their own pack", async () => {
		const packId = await makePublicPack("mgmt-owner");
		const updated = await knowledgePackService.updatePackMeta(
			packId,
			{ description: "owner edit" },
			principal(),
		);
		expect(updated.description).toBe("owner edit");
		const del = await knowledgePackService.deletePack(packId, principal());
		expect(del.deleted).toBe(true);
	});

	test("an admin can manage any pack", async () => {
		const packId = await makePublicPack("mgmt-admin");
		const admin = { userId: "admin-x", role: "admin" as const };
		const updated = await knowledgePackService.updatePackMeta(
			packId,
			{ description: "admin edit" },
			admin,
		);
		expect(updated.description).toBe("admin edit");
		expect((await knowledgePackService.deletePack(packId, admin)).deleted).toBe(true);
	});

	test("managing a pack the caller cannot even read fails as NotFound (no leak)", async () => {
		// Secret pack, no owner → the baseline 'other' user cannot read it.
		const secretArchive = await fileFromPath(
			buildTarGz("mgmt-secret", { "s.txt": "secret" }),
			"mgmt-secret.tar.gz",
		);
		const secretPack = await knowledgePackService.createPack({
			name: `Mgmt Secret ${TAG}`,
			archive: secretArchive,
			classificationLevel: "secret",
		});
		await expect(knowledgePackService.deletePack(secretPack.id, otherPrincipal())).rejects.toThrow(
			/not found/i,
		);
	});
});
