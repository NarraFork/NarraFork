import { describe, expect, test } from "bun:test";
import {
	assertLegacyRuntimeOwner,
	type CurrentResourceAuthority,
	createWorktreeResourceAccess,
	resolveWorktreeResourceOwner,
	type WorktreeResourceRecord,
	withResourceDeadline,
} from "./worktree-resource-owner";

const resource = (): WorktreeResourceRecord => ({
	id: "resource",
	ownerNarratorId: "source",
	deviceId: "local",
	repositoryKey: "repo",
	worktreePath: "/fixture/worktree",
	state: "ready",
	scopeKind: "project",
	scopeProjectId: "project",
	scopeOwnerUserId: "owner",
	ownershipRevision: 3,
	createRequestId: "create",
	createdAt: "2026-10-04T00:00:00.000Z",
});
const authority = (): CurrentResourceAuthority => ({
	actorUserId: "owner",
	scopeOwnerUserId: "owner",
	contextProjectId: "project",
	rootNarratorId: "source",
	sessionNarratorId: "source",
	sessionType: "primary",
	sessionAclRootNarratorId: null,
	sourceNarratorId: "source",
	sourceRootNarratorId: "source",
	basis: "sourceRoot",
	backend: "sqlite",
	workspaceKind: "git",
	workspaceMode: "normal",
	deviceId: "local",
	canonicalWorktreePath: "/fixture/worktree",
	repositoryKey: "repo",
	complete: true,
	readAllowed: true,
	writeAllowed: true,
	projectAllowed: true,
	deviceAllowed: true,
	oauthAllowed: true,
	executionAllowed: true,
});
function fixture(
	row: WorktreeResourceRecord | null = resource(),
	auth: CurrentResourceAuthority | null = authority(),
) {
	const calls = { resource: 0, authority: 0 };
	return {
		calls,
		access: createWorktreeResourceAccess({
			backend: "sqlite",
			loadResource: async () => {
				calls.resource++;
				return row;
			},
			loadCurrentAuthority: async () => {
				calls.authority++;
				return auth;
			},
		}),
	};
}

describe("resource owner selectors", () => {
	test("discriminates all four owner forms", () => {
		expect(resolveWorktreeResourceOwner({ chapterId: "c" })).toEqual({
			kind: "legacyChapter",
			chapterId: "c",
		});
		expect(resolveWorktreeResourceOwner({ narratorId: "n" })).toEqual({
			kind: "legacyNarrator",
			narratorId: "n",
		});
		expect(resolveWorktreeResourceOwner({})).toEqual({ kind: "legacyStandalone" });
		expect(resolveWorktreeResourceOwner({ worktreeResourceId: "r" })).toEqual({
			kind: "worktreeResource",
			worktreeResourceId: "r",
		});
	});
	for (const input of [
		null,
		[],
		"r",
		{ chapterId: "" },
		{ worktreeResourceId: 1 },
		{ worktreeResourceId: "r", chapterId: "c" },
		{ chapterId: "c", narratorId: "n" },
		{ worktreeResourceId: "r", narratorId: "n" },
	]) {
		test(`malformed/mixed selector rejects: ${JSON.stringify(input)}`, () => {
			expect(() => resolveWorktreeResourceOwner(input)).toThrow();
		});
	}
	test("legacy runtime rejects a resource without minting an execution grant", () => {
		expect(() => assertLegacyRuntimeOwner({ worktreeResourceId: "r" })).toThrow(
			"WORKTREE_RESOURCE_RUNTIME_DISABLED",
		);
		expect(assertLegacyRuntimeOwner({})).toEqual({ kind: "legacyStandalone" });
	});
});

describe("current-auth resource resolver", () => {
	test("verified root and root subagents are supported", async () => {
		const f = fixture();
		expect((await f.access.authorize({ worktreeResourceId: "resource" }, 3, "write")).id).toBe(
			"resource",
		);
		expect(f.calls).toEqual({ resource: 1, authority: 1 });
		const child = fixture(resource(), {
			...authority(),
			sessionNarratorId: "verified-child",
			sessionType: "subagent",
			sessionAclRootNarratorId: "source",
		});
		expect((await child.access.authorize({ worktreeResourceId: "resource" }, 3, "write")).id).toBe(
			"resource",
		);
	});
	test("missing resource never retries legacy lookup", async () => {
		const f = fixture(null);
		await expect(f.access.authorize({ worktreeResourceId: "resource" }, 3, "read")).rejects.toThrow(
			"RESOURCE_NOT_FOUND",
		);
		expect(f.calls).toEqual({ resource: 1, authority: 0 });
	});
	for (const state of ["unknown", "preparing"] as const) {
		test(`${state} is protection evidence, not access evidence`, async () => {
			await expect(
				fixture({ ...resource(), state }).access.authorize(
					{ worktreeResourceId: "resource" },
					3,
					"read",
				),
			).rejects.toThrow("RESOURCE_NOT_READY");
		});
	}
	for (const changes of [
		{ scopeKind: "unknown" as const },
		{ scopeOwnerUserId: null },
		{ scopeProjectId: null },
	]) {
		test(`missing scope proof denies: ${JSON.stringify(changes)}`, async () => {
			await expect(
				fixture({ ...resource(), ...changes }).access.authorize(
					{ worktreeResourceId: "resource" },
					3,
					"read",
				),
			).rejects.toThrow("RESOURCE_SCOPE_UNVERIFIED");
		});
	}
	for (const changes of [
		{ sessionNarratorId: "ordinaryForkBorrowedRoot" },
		{
			sessionNarratorId: "unverified-child",
			sessionType: "subagent" as const,
			sessionAclRootNarratorId: null,
		},
		{
			sessionNarratorId: "wrong-root-child",
			sessionType: "subagent" as const,
			sessionAclRootNarratorId: "other-root",
		},
		{ rootNarratorId: "ordinaryFork" },
		{ rootNarratorId: "newPrimarySameCwd" },
		{ sourceNarratorId: "differentOrigin" },
		{ contextProjectId: "otherProject" },
		{ canonicalWorktreePath: "/fixture/alias" },
		{ repositoryKey: "otherRepo" },
		{ scopeOwnerUserId: "deletedOwnerReplacement" },
		{ projectAllowed: false },
		{ deviceAllowed: false },
		{ readAllowed: false },
		{ writeAllowed: false },
		{ executionAllowed: false },
		{ oauthAllowed: false },
		{ workspaceMode: "readonly" as const },
		{ complete: false },
		{ deviceId: "remote" },
		{ backend: "postgres" as const },
		{ workspaceKind: "directory" as const },
	]) {
		test(`no access through cwd/ACL/OAuth/policy shortcut: ${JSON.stringify(changes)}`, async () => {
			await expect(
				fixture(resource(), { ...authority(), ...changes }).access.authorize(
					{ worktreeResourceId: "resource" },
					3,
					"write",
				),
			).rejects.toThrow();
		});
	}
	test("malformed truthy authority values never count as verified proof", async () => {
		const f = fixture(resource(), { ...authority(), complete: "false" as unknown as boolean });
		await expect(
			f.access.authorize({ worktreeResourceId: "resource" }, 3, "write"),
		).rejects.toThrow("RESOURCE_ACCESS_DENIED");
	});
	test("readonly permits read only", async () => {
		const f = fixture(resource(), {
			...authority(),
			workspaceMode: "readonly",
			writeAllowed: false,
		});
		expect((await f.access.authorize({ worktreeResourceId: "resource" }, 3, "read")).id).toBe(
			"resource",
		);
	});
	test("origin removal retains explicit scope-owner access, never inherited public access", async () => {
		const row = { ...resource(), ownerNarratorId: null };
		const auth = {
			...authority(),
			sourceNarratorId: null,
			sourceRootNarratorId: null,
			basis: "scopeOwner" as const,
		};
		await fixture(row, auth).access.authorize({ worktreeResourceId: "resource" }, 3, "write");
		await expect(
			fixture(row, { ...auth, actorUserId: "publicViewer" }).access.authorize(
				{ worktreeResourceId: "resource" },
				3,
				"read",
			),
		).rejects.toThrow("RESOURCE_ORIGIN_UNVERIFIED");
	});
	test("stale revision and a DTO admin flag cannot authorize", async () => {
		await expect(
			fixture().access.authorize({ worktreeResourceId: "resource", isAdmin: true }, 2, "write"),
		).rejects.toThrow("RESOURCE_REVISION_STALE");
		await expect(
			fixture(resource(), null).access.authorize(
				{ worktreeResourceId: "resource", isAdmin: true },
				3,
				"write",
			),
		).rejects.toThrow("RESOURCE_ACCESS_DENIED");
	});
	test("Postgres fails before accessing the injected SQLite handle", async () => {
		let lookups = 0;
		const access = createWorktreeResourceAccess({
			backend: "postgres",
			loadResource: async () => {
				lookups++;
				return resource();
			},
			loadCurrentAuthority: async () => authority(),
		});
		await expect(access.authorize({ worktreeResourceId: "resource" }, 3, "read")).rejects.toThrow(
			"RESOURCE_CAPABILITY_UNSUPPORTED",
		);
		expect(lookups).toBe(0);
	});
	test("cancel and timeout remain closed even if a provider ignores cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			withResourceDeadline(controller.signal, async () => {
				calls++;
				return true;
			}),
		).rejects.toThrow("RESOURCE_AUTH_CANCELLED");
		expect(calls).toBe(0);
		let observedAbort = false;
		await expect(
			withResourceDeadline(
				undefined,
				async (signal) => {
					signal.addEventListener("abort", () => {
						observedAbort = true;
					});
					return new Promise<never>(() => {});
				},
				5,
			),
		).rejects.toThrow("RESOURCE_AUTH_TIMEOUT");
		expect(observedAbort).toBe(true);
	});
});
