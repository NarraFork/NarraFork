import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as schema from "../db/schema";
import { fixtureDatabase } from "./worktree-resource-fixture";
import {
	boundedMetadataJson,
	createWorktreeResourceMetadataStore,
	type ResourceMetadataAction,
} from "./worktree-resource-metadata-store";
import type { CurrentResourceAuthority, WorktreeResourceRecord } from "./worktree-resource-owner";

let fixture: ReturnType<typeof fixtureDatabase>;
let auth: CurrentResourceAuthority;
let committedChecks: number;
let finalAuthority: (resource: WorktreeResourceRecord) => CurrentResourceAuthority | null;
let store: ReturnType<typeof createWorktreeResourceMetadataStore>;
const now = "2026-01-01T00:00:00.000Z";
const initialAuth = (): CurrentResourceAuthority => ({
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
const request = (actions: ResourceMetadataAction[], requestId = "request") => ({
	requestId,
	worktreeResourceId: "resource",
	expectedRevision: 3,
	actions,
});
function resourceRow(): WorktreeResourceRecord | null {
	return fixture.sqlite
		.query<WorktreeResourceRecord, []>(`SELECT id, owner_narrator_id AS ownerNarratorId,
	device_id AS deviceId, repository_key AS repositoryKey, worktree_path AS worktreePath, state,
	scope_kind AS scopeKind, scope_project_id AS scopeProjectId, scope_owner_user_id AS scopeOwnerUserId,
	ownership_revision AS ownershipRevision, create_request_id AS createRequestId,
	created_at AS createdAt FROM narrator_worktree_resources WHERE id='resource'`)
		.get();
}
beforeEach(() => {
	fixture = fixtureDatabase();
	fixture.database
		.insert(schema.users)
		.values({ id: "owner", username: "owner", passwordHash: "fixture", createdAt: now })
		.run();
	fixture.database
		.insert(schema.projects)
		.values({
			id: "project",
			name: "fixture",
			gitPath: "/fixture/repo",
			ownerUserId: "owner",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	fixture.database
		.insert(schema.narrators)
		.values({ id: "source", ownerUserId: "owner", createdAt: now, updatedAt: now })
		.run();
	fixture.database
		.insert(schema.chapters)
		.values({
			id: "legacy",
			projectId: "project",
			title: "legacy",
			branch: "legacy",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	fixture.database
		.insert(schema.narratorWorktreeResources)
		.values({
			id: "resource",
			ownerNarratorId: "source",
			deviceId: "local",
			repositoryKey: "repo",
			worktreePath: "/fixture/worktree",
			state: "ready",
			createRequestId: "create",
			scopeKind: "project",
			scopeProjectId: "project",
			scopeOwnerUserId: "owner",
			ownershipRevision: 3,
		})
		.run();
	auth = initialAuth();
	committedChecks = 0;
	finalAuthority = () => auth;
	store = createWorktreeResourceMetadataStore({
		mode: "isolatedFixture",
		database: fixture.database,
		access: {
			backend: "sqlite",
			loadResource: async () => resourceRow(),
			loadCurrentAuthority: async () => auth,
		},
		currentAuthority: (resource) => {
			committedChecks++;
			return finalAuthority(resource);
		},
	});
});
afterEach(() => {
	fixture?.sqlite.close();
});

describe("bounded isolated metadata", () => {
	test("creates real resource FK rows but never claims a running process or completed restore", async () => {
		await store.write(
			request([
				{ kind: "terminal", id: "t", name: "Terminal" },
				{ kind: "container", id: "c", serviceName: "app" },
				{ kind: "port", port: 10000, serviceName: "app" },
				{ kind: "layout", id: "l", layout: "quad" },
				{ kind: "config", config: { composeFile: "compose.yml", projectName: "fixture" } },
			]),
		);
		expect(
			fixture.sqlite
				.query(
					"SELECT status,chapter_id,narrator_id,worktree_resource_id,cwd,dtach_socket FROM terminals",
				)
				.get(),
		).toEqual({
			status: "exited",
			chapter_id: null,
			narrator_id: null,
			worktree_resource_id: "resource",
			cwd: null,
			dtach_socket: null,
		});
		expect(
			fixture.sqlite
				.query(
					"SELECT status,container_id,chapter_id,worktree_resource_id FROM container_instances",
				)
				.get(),
		).toEqual({
			status: "stopped",
			container_id: null,
			chapter_id: null,
			worktree_resource_id: "resource",
		});
		expect(
			fixture.sqlite.query("SELECT COUNT(*) AS n FROM volume_snapshot_applications").get(),
		).toEqual({ n: 0 });
		expect((await store.summary("resource", 3, "terminal")).rows).toEqual([
			{ id: "t", name: "Terminal", hasNameDetails: false, status: "exited" },
		]);
	});
	test("old config receipt cannot report success after same-ID/revision ABA recreation", async () => {
		fixture.sqlite.run(
			"UPDATE narrator_worktree_resources SET ownership_revision=0 WHERE id='resource'",
		);
		const payload = {
			...request([{ kind: "config" as const, config: { composeFile: "compose-old.yml" } }], "aba"),
			expectedRevision: 0,
		};
		await store.write(payload);
		const previous = resourceRow();
		if (!previous) throw new Error("Missing fixture resource");
		fixture.sqlite.run("DELETE FROM narrator_worktree_resources WHERE id='resource'");
		fixture.database
			.insert(schema.narratorWorktreeResources)
			.values({
				...previous,
				createRequestId: "replacement-create",
				createdAt: new Date(Date.parse(previous.createdAt) + 1).toISOString(),
			})
			.run();
		await expect(store.write(payload)).rejects.toThrow("RESOURCE_IDEMPOTENCY_CONFLICT");
		expect(
			fixture.sqlite
				.query("SELECT container_config AS config FROM narrator_worktree_resources")
				.get(),
		).toEqual({ config: null });
		expect(await store.write({ ...payload, requestId: "new-incarnation-request" })).toEqual({
			count: 1,
			replayed: false,
		});
	});
	test("createdAt distinguishes a recreated resource even when createRequestId is reused", async () => {
		const payload = request(
			[{ kind: "config", config: { composeFile: "compose-old.yml" } }],
			"same-create-id",
		);
		await store.write(payload);
		const previous = resourceRow();
		if (!previous) throw new Error("Missing fixture resource");
		fixture.sqlite.run("DELETE FROM narrator_worktree_resources WHERE id='resource'");
		fixture.database
			.insert(schema.narratorWorktreeResources)
			.values({
				...previous,
				createdAt: new Date(Date.parse(previous.createdAt) + 1).toISOString(),
			})
			.run();
		await expect(store.write(payload)).rejects.toThrow("RESOURCE_IDEMPOTENCY_CONFLICT");
		expect(
			fixture.sqlite
				.query("SELECT container_config AS config FROM narrator_worktree_resources")
				.get(),
		).toEqual({ config: null });
	});
	test("replacement between initial authorization and commit cannot reuse its ID/revision", async () => {
		const replacement = createWorktreeResourceMetadataStore({
			mode: "isolatedFixture",
			database: fixture.database,
			access: {
				backend: "sqlite",
				loadResource: async () => resourceRow(),
				loadCurrentAuthority: async () => {
					const previous = resourceRow();
					if (!previous) throw new Error("Missing fixture resource");
					fixture.sqlite.run("DELETE FROM narrator_worktree_resources WHERE id='resource'");
					fixture.database
						.insert(schema.narratorWorktreeResources)
						.values({ ...previous, createRequestId: "replacement-window" })
						.run();
					return auth;
				},
			},
			currentAuthority: () => auth,
		});
		await expect(
			replacement.write(
				request([{ kind: "config", config: { composeFile: "wrong-incarnation.yml" } }]),
			),
		).rejects.toThrow("RESOURCE_INCARNATION_CHANGED");
		expect(resourceRow()?.createRequestId).toBe("replacement-window");
		expect(
			fixture.sqlite
				.query("SELECT container_config AS config FROM narrator_worktree_resources")
				.get(),
		).toEqual({ config: null });
	});
	test("scope replacement without revision cannot carry authorization into a newly allowed context", async () => {
		fixture.database
			.insert(schema.projects)
			.values({
				id: "project-2",
				name: "fixture-2",
				ownerUserId: "owner",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		const changedScope = createWorktreeResourceMetadataStore({
			mode: "isolatedFixture",
			database: fixture.database,
			access: {
				backend: "sqlite",
				loadResource: async () => resourceRow(),
				loadCurrentAuthority: async () => {
					fixture.sqlite.run(
						"UPDATE narrator_worktree_resources SET scope_project_id='project-2' WHERE id='resource'",
					);
					return auth;
				},
			},
			currentAuthority: () => ({ ...auth, contextProjectId: "project-2" }),
		});
		await expect(
			changedScope.write(request([{ kind: "config", config: { composeFile: "wrong-scope.yml" } }])),
		).rejects.toThrow("RESOURCE_INCARNATION_CHANGED");
		expect(
			fixture.sqlite
				.query("SELECT container_config AS config FROM narrator_worktree_resources")
				.get(),
		).toEqual({ config: null });
	});
	test("canonical path/repository replacement without revision is still a different identity", async () => {
		const changedIdentity = createWorktreeResourceMetadataStore({
			mode: "isolatedFixture",
			database: fixture.database,
			access: {
				backend: "sqlite",
				loadResource: async () => resourceRow(),
				loadCurrentAuthority: async () => {
					fixture.sqlite.run(
						"UPDATE narrator_worktree_resources SET worktree_path='/fixture/replacement', repository_key='replacement-repo' WHERE id='resource'",
					);
					return auth;
				},
			},
			currentAuthority: () => ({
				...auth,
				canonicalWorktreePath: "/fixture/replacement",
				repositoryKey: "replacement-repo",
			}),
		});
		await expect(
			changedIdentity.write(
				request([{ kind: "config", config: { composeFile: "wrong-identity.yml" } }]),
			),
		).rejects.toThrow("RESOURCE_INCARNATION_CHANGED");
		expect(
			fixture.sqlite
				.query("SELECT container_config AS config FROM narrator_worktree_resources")
				.get(),
		).toEqual({ config: null });
	});
	test("current actor and verified session must match initial authorization, not only commit-time policy", async () => {
		for (const replacement of [
			{ ...auth, actorUserId: "different-actor" },
			{
				...auth,
				sessionNarratorId: "new-child",
				sessionType: "subagent" as const,
				sessionAclRootNarratorId: "source",
			},
		]) {
			const swappedAuthority = createWorktreeResourceMetadataStore({
				mode: "isolatedFixture",
				database: fixture.database,
				access: {
					backend: "sqlite",
					loadResource: async () => resourceRow(),
					loadCurrentAuthority: async () => auth,
				},
				currentAuthority: () => replacement,
			});
			await expect(
				swappedAuthority.write(
					request([{ kind: "config", config: { composeFile: "wrong-authority.yml" } }]),
				),
			).rejects.toThrow();
		}
		expect(
			fixture.sqlite
				.query("SELECT container_config AS config FROM narrator_worktree_resources")
				.get(),
		).toEqual({ config: null });
	});
	test("idempotent retry is exactly-once; conflicting payload never overwrites existing ports", async () => {
		const payload = request([{ kind: "port", port: 10000, serviceName: "app" }]);
		expect(await store.write(payload)).toEqual({ count: 1, replayed: false });
		expect(await store.write(payload)).toEqual({ count: 1, replayed: true });
		await expect(
			store.write(request([{ kind: "port", port: 10001, serviceName: "other" }])),
		).rejects.toThrow("RESOURCE_IDEMPOTENCY_CONFLICT");
		expect(fixture.sqlite.query("SELECT port FROM port_allocations ORDER BY port").all()).toEqual([
			{ port: 10000 },
		]);
	});
	test("port conflict rolls back only this request and retains unrelated legacy and resource rows", async () => {
		fixture.database
			.insert(schema.portAllocations)
			.values({ port: 10000, chapterId: "legacy", serviceName: "legacy", allocatedAt: now })
			.run();
		await store.write(request([{ kind: "port", port: 10001, serviceName: "prior" }], "prior"));
		await expect(
			store.write(
				request([
					{ kind: "terminal", id: "undo", name: "undo" },
					{ kind: "port", port: 10002, serviceName: "undo" },
					{ kind: "port", port: 10000, serviceName: "conflict" },
				]),
			),
		).rejects.toThrow();
		expect(fixture.sqlite.query("SELECT id FROM terminals").all()).toEqual([]);
		expect(fixture.sqlite.query("SELECT port FROM port_allocations ORDER BY port").all()).toEqual([
			{ port: 10000 },
			{ port: 10001 },
		]);
		await store.write(request([{ kind: "terminal", id: "retry", name: "retry" }]));
	});
	test("CAS change after initial authorization leaves no metadata", async () => {
		const staleStore = createWorktreeResourceMetadataStore({
			mode: "isolatedFixture",
			database: fixture.database,
			access: {
				backend: "sqlite",
				loadResource: async () => resourceRow(),
				loadCurrentAuthority: async () => {
					fixture.sqlite.run(
						"UPDATE narrator_worktree_resources SET ownership_revision=4 WHERE id='resource'",
					);
					return auth;
				},
			},
			currentAuthority: () => auth,
		});
		await expect(
			staleStore.write(request([{ kind: "terminal", id: "t", name: "t" }])),
		).rejects.toThrow("RESOURCE_REVISION_STALE");
		expect(fixture.sqlite.query("SELECT id FROM terminals").all()).toEqual([]);
	});
	test("ACL revocation between rows rolls back config, ports and terminals together", async () => {
		finalAuthority = () => (committedChecks >= 5 ? { ...auth, writeAllowed: false } : auth);
		await expect(
			store.write(
				request([
					{ kind: "config", config: { composeFile: "compose.yml" } },
					{ kind: "port", port: 10000, serviceName: "app" },
					{ kind: "terminal", id: "t", name: "t" },
				]),
			),
		).rejects.toThrow("RESOURCE_ACCESS_DENIED");
		expect(fixture.sqlite.query("SELECT id FROM terminals").all()).toEqual([]);
		expect(fixture.sqlite.query("SELECT port FROM port_allocations").all()).toEqual([]);
		expect(
			fixture.sqlite
				.query("SELECT container_config AS config FROM narrator_worktree_resources")
				.get(),
		).toEqual({ config: null });
	});
	test("abort during atomic admission rolls back prior inserts", async () => {
		const controller = new AbortController();
		finalAuthority = () => {
			if (committedChecks >= 4) controller.abort();
			return auth;
		};
		await expect(
			store.write(
				request([
					{ kind: "port", port: 10000, serviceName: "app" },
					{ kind: "terminal", id: "t", name: "t" },
				]),
				controller.signal,
			),
		).rejects.toThrow("RESOURCE_AUTH_CANCELLED");
		expect(fixture.sqlite.query("SELECT port FROM port_allocations").all()).toEqual([]);
	});
	test("deleted legacy owner retains resource rows; project deletion preserves scope kind but denies grants", async () => {
		await store.write(
			request([
				{ kind: "terminal", id: "t", name: "t" },
				{ kind: "port", port: 10000, serviceName: "app" },
			]),
		);
		fixture.sqlite.run("DELETE FROM chapters WHERE id='legacy'");
		expect(fixture.sqlite.query("SELECT id FROM terminals").all()).toEqual([{ id: "t" }]);
		fixture.sqlite.run("DELETE FROM projects WHERE id='project'");
		expect(resourceRow()?.scopeKind).toBe("project");
		expect(resourceRow()?.scopeProjectId).toBeNull();
		await expect(store.summary("resource", 3, "terminal")).rejects.toThrow(
			"RESOURCE_SCOPE_UNVERIFIED",
		);
		expect(fixture.sqlite.query("SELECT port FROM port_allocations").all()).toEqual([
			{ port: 10000 },
		]);
	});
	test("owner user SET NULL preserves record but cannot mint access", async () => {
		fixture.sqlite.run("DELETE FROM users WHERE id='owner'");
		expect(resourceRow()?.scopeOwnerUserId).toBeNull();
		await expect(store.write(request([{ kind: "terminal", id: "t", name: "t" }]))).rejects.toThrow(
			"RESOURCE_SCOPE_UNVERIFIED",
		);
		expect(resourceRow()?.id).toBe("resource");
	});
	test("source narrator deletion never broadens owner rights", async () => {
		fixture.sqlite.run("DELETE FROM narrators WHERE id='source'");
		expect(resourceRow()?.ownerNarratorId).toBeNull();
		auth = {
			...auth,
			sourceNarratorId: null,
			sourceRootNarratorId: null,
			basis: "scopeOwner",
			actorUserId: "publicViewer",
		};
		await expect(store.summary("resource", 3, "terminal")).rejects.toThrow(
			"RESOURCE_ORIGIN_UNVERIFIED",
		);
	});
	test("source-level page bound uses 128 plus one without fetching big fields", async () => {
		for (let index = 0; index < 130; index++)
			fixture.database
				.insert(schema.terminals)
				.values({
					id: `t${String(index).padStart(3, "0")}`,
					worktreeResourceId: "resource",
					name: "t",
					status: "exited",
					createdAt: now,
				})
				.run();
		const first = await store.summary("resource", 3, "terminal");
		expect(first.rows).toHaveLength(128);
		expect(first.hasMore).toBe(true);
		expect(first.nextCursor).toBe("t127");
		const second = await store.summary("resource", 3, "terminal", first.nextCursor ?? undefined);
		expect(second.rows).toHaveLength(2);
		expect(second.hasMore).toBe(false);
	});
	test("metadata payload cannot set running status/containerId or attest volume restore", async () => {
		for (const action of [
			{ kind: "terminal", id: "t", name: "t", status: "running" },
			{ kind: "container", id: "c", serviceName: "app", containerId: "real" },
			{ kind: "application", snapshotId: "snapshot", appliedAt: now },
		]) {
			await expect(store.write({ ...request([]), actions: [action] })).rejects.toThrow(
				"RESOURCE_METADATA_INVALID",
			);
		}
	});
	test("strict selector, byte and traversal limits fail before any store write", async () => {
		await expect(
			store.write({ ...request([{ kind: "terminal", id: "t", name: "t" }]), chapterId: "legacy" }),
		).rejects.toThrow("RESOURCE_METADATA_INVALID");
		await expect(
			store.write(request([{ kind: "terminal", id: "t", name: "x".repeat(17000) }])),
		).rejects.toThrow("RESOURCE_METADATA_TOO_LARGE");
		expect(() => boundedMetadataJson({ text: "中".repeat(10000) }, 16384)).toThrow(
			"RESOURCE_METADATA_TOO_LARGE",
		);
		expect(() => boundedMetadataJson({ rows: Array(130).fill("x") }, 262144)).toThrow(
			"RESOURCE_METADATA_TOO_LARGE",
		);
		expect(fixture.sqlite.query("SELECT id FROM terminals").all()).toEqual([]);
	});
	test("summary bounds strings at SQL source and omits config details", async () => {
		fixture.database
			.insert(schema.terminals)
			.values({
				id: "big",
				worktreeResourceId: "resource",
				name: "x".repeat(512 * 1024),
				status: "exited",
				createdAt: now,
			})
			.run();
		const summary = await store.summary("resource", 3, "terminal");
		expect(summary.rows).toEqual([
			{ id: "big", name: "x".repeat(256), hasNameDetails: true, status: "exited" },
		]);
		await store.write(request([{ kind: "config", config: { composeFile: "compose.yml" } }]));
		const configuration = await store.summary("resource", 3, "config");
		expect(configuration.rows[0]).toMatchObject({ id: "resource", hasConfig: true });
		expect(configuration.rows[0]).not.toHaveProperty("containerConfig");
	});
	test("oversized identity cannot be returned as a truncated cursor", async () => {
		fixture.database
			.insert(schema.terminals)
			.values({
				id: "x".repeat(2048),
				worktreeResourceId: "resource",
				name: "t",
				status: "exited",
				createdAt: now,
			})
			.run();
		await expect(store.summary("resource", 3, "terminal")).rejects.toThrow(
			"RESOURCE_METADATA_TOO_LARGE",
		);
	});
	test("current actor cannot change mid-commit or reuse another actor's receipt", async () => {
		finalAuthority = () => (committedChecks >= 4 ? { ...auth, actorUserId: "different" } : auth);
		await expect(
			store.write(
				request([
					{ kind: "port", port: 10000, serviceName: "app" },
					{ kind: "terminal", id: "t", name: "t" },
				]),
			),
		).rejects.toThrow("RESOURCE_ACTOR_CHANGED");
		expect(fixture.sqlite.query("SELECT port FROM port_allocations").all()).toEqual([]);
		finalAuthority = () => auth;
		const payload = request([{ kind: "port", port: 10000, serviceName: "app" }]);
		await store.write(payload);
		auth = { ...auth, actorUserId: "different" };
		await expect(store.write(payload)).rejects.toThrow("RESOURCE_IDEMPOTENCY_CONFLICT");
	});
	test("an abort during the final authority read still rolls back every row", async () => {
		const controller = new AbortController();
		finalAuthority = () => {
			if (committedChecks >= 3) controller.abort();
			return auth;
		};
		await expect(
			store.write(request([{ kind: "port", port: 10000, serviceName: "app" }]), controller.signal),
		).rejects.toThrow("RESOURCE_AUTH_CANCELLED");
		expect(fixture.sqlite.query("SELECT port FROM port_allocations").all()).toEqual([]);
	});
	test("schema fixture uses real owner exclusion and RESTRICT constraints", async () => {
		await store.write(request([{ kind: "port", port: 10000, serviceName: "app" }]));
		expect(() =>
			fixture.sqlite.run("DELETE FROM narrator_worktree_resources WHERE id='resource'"),
		).toThrow();
		expect(() =>
			fixture.database
				.insert(schema.containerInstances)
				.values({
					id: "mixed",
					chapterId: "legacy",
					worktreeResourceId: "resource",
					serviceName: "app",
					createdAt: now,
					updatedAt: now,
				})
				.run(),
		).toThrow();
	});
});
