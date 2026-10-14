import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { fixtureDatabase } from "./__tests__/worktree-resource-fixture";
import {
	createLegacyLinkedWorktreeClaimsReader,
	readAuthorizedLinkedWorktreeSummary,
	readLinkedWorktreeProtection,
} from "./legacy-linked-worktree-claims";
import { createLifecycleGuard } from "./worktree-lifecycle-guard";
import {
	type CurrentResourceAuthority,
	createWorktreeResourceAccess,
	validateResourceAuthority,
	type WorktreeResourceRecord,
} from "./worktree-resource-owner";

const now = "2026-10-11T00:00:00Z";
let fixture: ReturnType<typeof fixtureDatabase>;
const resource = (): WorktreeResourceRecord => ({
	id: "resource",
	ownerNarratorId: "original",
	deviceId: "local",
	repositoryKey: "repo",
	worktreePath: "/fixture/linked",
	state: "ready",
	scopeKind: "standalone",
	scopeProjectId: null,
	scopeOwnerUserId: "owner",
	ownershipRevision: 3,
	createRequestId: "create",
	createdAt: now,
});
const auth = (narrator = "claimant"): CurrentResourceAuthority => ({
	actorUserId: "owner",
	scopeOwnerUserId: "owner",
	contextProjectId: null,
	rootNarratorId: narrator,
	sessionNarratorId: narrator,
	sessionType: "primary",
	sessionAclRootNarratorId: null,
	sourceNarratorId: narrator,
	sourceRootNarratorId: narrator,
	basis: "sourceRoot",
	backend: "sqlite",
	workspaceKind: "git",
	workspaceMode: "normal",
	deviceId: "local",
	canonicalWorktreePath: "/fixture/linked",
	repositoryKey: "repo",
	complete: true,
	readAllowed: true,
	writeAllowed: true,
	projectAllowed: true,
	deviceAllowed: true,
	oauthAllowed: true,
	executionAllowed: true,
});
const summary = (narrator = "claimant") =>
	createLegacyLinkedWorktreeClaimsReader(fixture.database).readSummary("resource", narrator);

beforeEach(() => {
	fixture = fixtureDatabase();
	for (const id of ["owner", "other"])
		fixture.database
			.insert(schema.users)
			.values({ id, username: id, passwordHash: "fixture", createdAt: now })
			.run();
	for (const id of ["original", "claimant", "second", "stranger"])
		fixture.database
			.insert(schema.narrators)
			.values({ id, ownerUserId: "owner", createdAt: now, updatedAt: now })
			.run();
	fixture.database
		.insert(schema.legacyProjectMigrations)
		.values({
			projectId: "receipt",
			projectName: "retired",
			actorUserId: "owner",
			phase: "completed",
			revision: "revision",
			narratorIds: ["original", "claimant", "second"],
			chapterTargets: {},
			createdAt: now,
			updatedAt: now,
		})
		.run();
	fixture.database
		.insert(schema.narratorWorktreeResources)
		.values({ ...resource(), updatedAt: now })
		.run();
	fixture.database
		.insert(schema.narratorWorktreeResourceOrigins)
		.values({
			resourceId: "resource",
			migrationProjectId: "receipt",
			sourceChapterId: "chapter-one",
			deviceId: "local",
			commonDirectoryPath: "/fixture/main/.git",
			gitAdminDirectoryPath: "/fixture/main/.git/worktrees/linked",
			evidenceJson: { deliberatelyNotReturned: "large private identity evidence" },
			evidenceDigest: "digest",
			createdAt: now,
		})
		.run();
	for (const [id, narratorId, chapter] of [
		["claim-one", "claimant", "chapter-one"],
		["claim-two", "second", "chapter-two"],
	])
		fixture.database
			.insert(schema.narratorWorktreeResourceClaims)
			.values({
				id: id as string,
				resourceId: "resource",
				migrationProjectId: "receipt",
				sourceChapterId: chapter as string,
				narratorId: narratorId as string,
				ownerUserId: "owner",
				state: "claimed",
				ownershipRevision: 3,
				createdAt: now,
				updatedAt: now,
			})
			.run();
});
afterEach(() => fixture.sqlite.close());

describe("current linked claimant authority", () => {
	test("same-owner current claim authorizes read/write despite different representative owner", () => {
		for (const narrator of ["claimant", "second"]) {
			const current = auth(narrator);
			const evidence = readAuthorizedLinkedWorktreeSummary(
				fixture.database,
				resource(),
				current,
				"write",
			);
			expect(() => validateResourceAuthority(resource(), current, "write", evidence)).not.toThrow();
			expect(evidence.origin).not.toHaveProperty("evidenceJson");
		}
	});
	test("reader never invents claim from actor or same cwd", () => {
		expect(summary("stranger").claim).toBeNull();
		expect(() =>
			readAuthorizedLinkedWorktreeSummary(fixture.database, resource(), auth("stranger")),
		).toThrow();
		expect(() =>
			validateResourceAuthority(resource(), auth("original"), "read", summary("original")),
		).toThrow();
	});
	for (const flag of [
		"readAllowed",
		"writeAllowed",
		"projectAllowed",
		"deviceAllowed",
		"oauthAllowed",
		"executionAllowed",
		"complete",
	] as const) {
		test(`current revoked ${flag} denies write`, () => {
			const current = { ...auth(), [flag]: false };
			expect(() =>
				readAuthorizedLinkedWorktreeSummary(fixture.database, resource(), current, "write"),
			).toThrow();
			expect(() => validateResourceAuthority(resource(), current, "write", summary())).toThrow();
		});
	}
	test("subject ACL denial persists even when actor is owner", () => {
		expect(() =>
			validateResourceAuthority(resource(), { ...auth(), readAllowed: false }, "read", summary()),
		).toThrow();
	});
	test("current narrator ownership changes invalidate a previously same-owner claim", () => {
		fixture.database
			.update(schema.narrators)
			.set({ ownerUserId: "other" })
			.where(eq(schema.narrators.id, "claimant"))
			.run();
		expect(() =>
			readAuthorizedLinkedWorktreeSummary(fixture.database, resource(), auth(), "write"),
		).toThrow();
		expect(() => validateResourceAuthority(resource(), auth(), "write", summary())).toThrow();
	});
	test("SQL current grant removal denies the next authorization without changing durable claims", async () => {
		fixture.database
			.insert(schema.aclGrants)
			.values({
				id: "grant",
				scopeType: "narrator",
				scopeId: "claimant",
				principalType: "user",
				principalId: "other",
				capability: "write",
				grantedBy: "owner",
				createdAt: now,
			})
			.run();
		const access = createWorktreeResourceAccess({
			backend: "sqlite",
			loadResource: async () => resource(),
			loadCurrentAuthority: async () => {
				// Fixture current-auth adapter: each attempt re-reads a bounded grant, never receipt ACL.
				const grant = fixture.database
					.select({ capability: schema.aclGrants.capability })
					.from(schema.aclGrants)
					.where(eq(schema.aclGrants.id, "grant"))
					.limit(1)
					.get();
				return {
					...auth(),
					actorUserId: "other",
					readAllowed: !!grant,
					writeAllowed: grant?.capability === "write",
				};
			},
			loadLinkedClaimSummary: async () => summary(),
		});
		expect(await access.authorize({ worktreeResourceId: "resource" }, 3, "write")).toEqual(
			resource(),
		);
		fixture.database.delete(schema.aclGrants).where(eq(schema.aclGrants.id, "grant")).run();
		await expect(
			access.authorize({ worktreeResourceId: "resource" }, 3, "write"),
		).rejects.toThrow();
		expect(summary().claim?.state).toBe("claimed");
	});
	test("authorized-summary helper rejects malformed truthy ACL proof", () => {
		const current = { ...auth(), readAllowed: "yes" } as unknown as CurrentResourceAuthority;
		expect(() =>
			readAuthorizedLinkedWorktreeSummary(fixture.database, resource(), current),
		).toThrow();
	});
	test("cross-owner, stale revision and missing origin cannot confer authority", () => {
		for (const patch of [
			{ ownerUserId: "other" },
			{ ownershipRevision: 2 },
			{ state: "unresolved" as const },
			{ state: "released" as const },
		]) {
			fixture.database
				.update(schema.narratorWorktreeResourceClaims)
				.set({ ownerUserId: "owner", ownershipRevision: 3, state: "claimed", ...patch })
				.where(eq(schema.narratorWorktreeResourceClaims.id, "claim-one"))
				.run();
			expect(() => validateResourceAuthority(resource(), auth(), "write", summary())).toThrow();
		}
		const evidence = summary();
		expect(() =>
			validateResourceAuthority(resource(), auth(), "write", { ...evidence, origin: null }),
		).toThrow();
		expect(() =>
			validateResourceAuthority({ ...resource(), state: "unknown" }, auth(), "write", evidence),
		).toThrow();
	});
	test("only bound runtime root can use a claim; subagent inherits current verified root", () => {
		const current = {
			...auth(),
			sessionType: "subagent" as const,
			sessionNarratorId: "sub",
			sessionAclRootNarratorId: "claimant",
		};
		expect(() => validateResourceAuthority(resource(), current, "write", summary())).not.toThrow();
		for (const patch of [
			{ sessionAclRootNarratorId: null },
			{ sourceRootNarratorId: "stranger" },
			{ rootNarratorId: "stranger" },
		])
			expect(() =>
				validateResourceAuthority(resource(), { ...current, ...patch }, "write", summary()),
			).toThrow();
	});
	test("representative owner deletion does not make linked namespace unowned", () => {
		const row = { ...resource(), ownerNarratorId: null };
		expect(() => validateResourceAuthority(row, auth(), "write", summary())).not.toThrow();
		expect(() =>
			validateResourceAuthority(
				row,
				{ ...auth(), basis: "scopeOwner", sourceNarratorId: null, sourceRootNarratorId: null },
				"write",
				summary(),
			),
		).toThrow();
	});
	test("authorization snapshot consumes exact current claim without touching FS", async () => {
		const access = createWorktreeResourceAccess({
			backend: "sqlite",
			loadResource: async () => resource(),
			loadCurrentAuthority: async () => auth(),
			loadLinkedClaimSummary: async (row, current) =>
				createLegacyLinkedWorktreeClaimsReader(fixture.database).readSummary(
					row.id,
					current.sourceRootNarratorId,
				),
		});
		expect(await access.authorize({ worktreeResourceId: "resource" }, 3, "write")).toEqual(
			resource(),
		);
		fixture.database
			.update(schema.narratorWorktreeResourceClaims)
			.set({ state: "unresolved" })
			.run();
		await expect(
			access.authorize({ worktreeResourceId: "resource" }, 3, "write"),
		).rejects.toThrow();
	});
});

describe("durable linked lifecycle dependencies", () => {
	test("all narrators and owner deleted: root/main/common/admin and nested aliases stay protected", async () => {
		fixture.database.delete(schema.narrators).run();
		fixture.database.delete(schema.users).run();
		expect(summary().claim).toBeNull();
		const retained = fixture.database
			.select({
				narratorId: schema.narratorWorktreeResourceClaims.narratorId,
				ownerUserId: schema.narratorWorktreeResourceClaims.ownerUserId,
			})
			.from(schema.narratorWorktreeResourceClaims)
			.all();
		expect(retained).toEqual([
			{ narratorId: null, ownerUserId: null },
			{ narratorId: null, ownerUserId: null },
		]);
		for (const state of ["ready", "unknown", "preparing"] as const) {
			fixture.database.update(schema.narratorWorktreeResources).set({ state }).run();
			const guard = createLifecycleGuard({
				canonicalPath: async (path) => path.replace("/alias/", "/fixture/"),
				readClaims: (deadline, signal) =>
					readLinkedWorktreeProtection(fixture.database, deadline, signal),
			});
			for (const path of [
				"/fixture/linked",
				"/fixture/linked/subdir",
				"/fixture/main",
				"/fixture/main/.git",
				"/fixture/main/.git/worktrees/linked",
				"/alias/main/.git/worktrees/linked/subdir",
				"/fixture",
			])
				expect((await guard.inspect([{ path }], "storage cleanup")).status).toBe("protected");
			expect(
				(await guard.inspect([{ path: "/fixture/unrelated" }], "storage cleanup")).status,
			).toBe("clear");
		}
	});
	test("exact common/admin lookups are indexed and small", () => {
		const reader = createLegacyLinkedWorktreeClaimsReader(fixture.database);
		expect(reader.hasExactDependency("local", "/fixture/main/.git")).toBe(true);
		expect(reader.hasExactDependency("local", "/fixture/main/.git/worktrees/linked")).toBe(true);
		expect(reader.hasExactDependency("remote", "/fixture/main/.git")).toBe(false);
		for (const [column, index] of [
			["common_directory_path", "idx_worktree_origin_common"],
			["git_admin_directory_path", "idx_worktree_origin_admin"],
		]) {
			const plan = fixture.sqlite
				.query<{ detail: string }, []>(
					`EXPLAIN QUERY PLAN SELECT resource_id FROM narrator_worktree_resource_origins WHERE device_id='local' AND ${column}='/fixture/main/.git' LIMIT 1`,
				)
				.all();
			expect(
				plan.some(
					(row) => row.detail.includes(index as string) && row.detail.includes(`${column}=?`),
				),
			).toBe(true);
		}
	});
	test("cursor pagination cannot hide origin dependencies beyond a full page", async () => {
		for (let index = 0; index < 128; index++) {
			const id = `resource-${String(index).padStart(3, "0")}`;
			fixture.database
				.insert(schema.narratorWorktreeResources)
				.values({
					...resource(),
					id,
					worktreePath: `/fixture/linked-${index}`,
					createRequestId: id,
					updatedAt: now,
				})
				.run();
			fixture.database
				.insert(schema.narratorWorktreeResourceOrigins)
				.values({
					resourceId: id,
					migrationProjectId: "receipt",
					sourceChapterId: id,
					deviceId: "local",
					commonDirectoryPath: "/fixture/main/.git",
					gitAdminDirectoryPath: `/fixture/main/.git/worktrees/${id}`,
					evidenceJson: {},
					evidenceDigest: "digest",
					createdAt: now,
				})
				.run();
		}
		const overflow = await readLinkedWorktreeProtection(
			fixture.database,
			performance.now() + 1000,
			undefined,
			{ maxRows: 128, maxBytes: 262144 },
		);
		expect(overflow).toEqual({ complete: false, claims: [] });
		const complete = await readLinkedWorktreeProtection(fixture.database, performance.now() + 1000);
		expect(complete.complete).toBe(true);
		expect(complete.claims).toHaveLength(129 * 3);
	});
	test("malformed durable paths deny cleanup instead of disappearing from inventory", async () => {
		fixture.database
			.update(schema.narratorWorktreeResourceOrigins)
			.set({ commonDirectoryPath: "relative/main/.git" })
			.run();
		expect(await readLinkedWorktreeProtection(fixture.database, performance.now() + 1000)).toEqual({
			complete: false,
			claims: [],
		});
	});
	test("scan row/byte/time/cancellation budgets fail closed, never return truncated clear inventory", async () => {
		for (const budget of [
			{ maxRows: 0, maxBytes: 262144 },
			{ maxRows: 4096, maxBytes: 0 },
		]) {
			const inventory = await readLinkedWorktreeProtection(
				fixture.database,
				performance.now() + 1000,
				undefined,
				budget,
			);
			expect(inventory).toEqual({ complete: false, claims: [] });
			const guard = createLifecycleGuard({
				canonicalPath: async (path) => path,
				readClaims: async () => inventory,
			});
			expect((await guard.inspect([{ path: "/fixture/main" }], "storage cleanup")).status).toBe(
				"unavailable",
			);
		}
		expect((await readLinkedWorktreeProtection(fixture.database, 0)).complete).toBe(false);
		expect(
			(
				await readLinkedWorktreeProtection(
					fixture.database,
					performance.now() + 1000,
					AbortSignal.abort(),
				)
			).complete,
		).toBe(false);
	});
});
