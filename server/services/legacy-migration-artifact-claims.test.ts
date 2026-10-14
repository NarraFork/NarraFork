import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { legacyMigrationArtifactClaims as table } from "../db/schema";
import {
	createLegacyArtifactClaimLookup,
	legacyArtifactClaimPredicate,
	verifyLegacyArtifactPathIdentity,
} from "./legacy-migration-artifact-claims";
import { createLifecycleGuard } from "./worktree-lifecycle-guard";

const databases: Database[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const database of databases.splice(0)) database.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function fixture() {
	const database = new Database(":memory:");
	databases.push(database);
	// Schema-derived isolated table only, never application DDL or a real database.
	const config = getTableConfig(table);
	database.exec(
		`CREATE TABLE "${config.name}" (${config.columns
			.map(
				(column) =>
					`"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}`,
			)
			.join(",")})`,
	);
	const db = drizzle(database);
	const hasClaim = createLegacyArtifactClaimLookup(
		async (lookup) =>
			!!(
				await db
					.select({ id: table.id })
					.from(table)
					.where(await legacyArtifactClaimPredicate(lookup))
					.limit(1)
			)[0],
	);
	const insert = (state: "claimed" | "unknown" | "released", owner: string | null = "owner") =>
		db
			.insert(table)
			.values({
				id: "claim",
				migrationProjectId: "p",
				sourceChapterId: "c",
				narratorId: null,
				ownerUserId: owner,
				kind: "shadow",
				deviceId: "local",
				workspacePath: "/repo",
				artifactPath: "/artifacts/old-shadow",
				shadowKey: "local\0/repo",
				identityJson: {},
				manifestDigest: "digest",
				state,
				createdAt: "now",
			})
			.run();
	return { db, hasClaim, insert };
}

for (const state of ["claimed", "unknown"] as const) {
	test(`${state} survives missing narrator and matches each indexed physical identity`, async () => {
		const { hasClaim, insert } = fixture();
		insert(state);
		for (const lookup of [
			{ workspacePath: "/repo" },
			{ artifactPath: "/artifacts/old-shadow" },
			{ shadowKey: "local\0/repo" },
			{ sourceChapterId: "c" },
		])
			expect(await hasClaim(lookup)).toBe(true);
		expect(await hasClaim({ workspacePath: "/repo", deviceId: "remote" })).toBe(false);
		expect(await hasClaim({ workspacePath: "/elsewhere" })).toBe(false);
	});
}
test("explicit release does not turn missing ownership into deletion authority", async () => {
	const released = fixture();
	released.insert("released");
	expect(await released.hasClaim({ sourceChapterId: "c" })).toBe(false);
	const unknownOwner = fixture();
	unknownOwner.insert("released", null);
	expect(await unknownOwner.hasClaim({ sourceChapterId: "c" })).toBe(true);
});
test("query rejection, incomplete selector and timeout all fail closed", async () => {
	expect(
		await createLegacyArtifactClaimLookup(async () => {
			throw new Error("unavailable");
		})({ artifactPath: "/a" }),
	).toBe(true);
	expect(await createLegacyArtifactClaimLookup(async () => false)({})).toBe(true);
	expect(
		await createLegacyArtifactClaimLookup(() => new Promise(() => {}), 5)({ artifactPath: "/a" }),
	).toBe(true);
});
test("unrecognized state cannot become release evidence", async () => {
	const { db, hasClaim, insert } = fixture();
	insert("claimed");
	db.run("UPDATE legacy_migration_artifact_claims SET state='unexpected'");
	expect(await hasClaim({ sourceChapterId: "c" })).toBe(true);
});
test("claim query selects only id even if identity JSON cannot be decoded", async () => {
	const { db, hasClaim, insert } = fixture();
	insert("claimed");
	db.run("UPDATE legacy_migration_artifact_claims SET identity_json='not-json'");
	expect(await hasClaim({ artifactPath: "/artifacts/old-shadow" })).toBe(true);
});
for (const state of ["claimed", "unknown", "released"]) {
	test(`durable ${state} artifact inventory cannot be forced into a deletion sink`, async () => {
		const guard = createLifecycleGuard({
			canonicalPath: async (path) => path,
			readClaims: async () => ({
				complete: true,
				claims: [
					{ kind: "legacy_artifact", id: "claim", deviceId: "local", path: "/artifact", state },
				],
			}),
		});
		let called = false;
		await expect(
			guard.withProtectionReservation([{ path: "/artifact" }], "force shadow destroy", async () => {
				called = true;
			}),
		).rejects.toThrow();
		expect(called).toBe(false);
	});
}
test("directory replacement and symlink aliases are never authorized physical evidence", async () => {
	const base = mkdtempSync(join(tmpdir(), "nf-artifact-identity-"));
	directories.push(base);
	const artifact = join(base, "artifact");
	mkdirSync(artifact);
	const stat = lstatSync(artifact);
	const identity = { dev: String(stat.dev), ino: String(stat.ino) };
	expect(await verifyLegacyArtifactPathIdentity(artifact, identity)).toBe(true);
	const replacement = join(base, "replacement");
	mkdirSync(replacement);
	const link = join(base, "link");
	symlinkSync(artifact, link);
	expect(await verifyLegacyArtifactPathIdentity(link, identity)).toBe(false);
	const nested = join(artifact, "nested");
	mkdirSync(nested);
	expect(
		await verifyLegacyArtifactPathIdentity(join(link, "nested"), {
			dev: String(lstatSync(nested).dev),
			ino: String(lstatSync(nested).ino),
		}),
	).toBe(false);
	expect(await verifyLegacyArtifactPathIdentity(replacement, identity)).toBe(false);
	expect(await verifyLegacyArtifactPathIdentity(artifact, {})).toBe(false);
});
