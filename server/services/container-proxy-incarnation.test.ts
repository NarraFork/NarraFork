import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { fixtureDatabase } from "./__tests__/worktree-resource-fixture";
import { createWorktreeResourceMetadataStore } from "./worktree-resource-metadata-store";
import type { CurrentResourceAuthority } from "./worktree-resource-owner";

let fixture: ReturnType<typeof fixtureDatabase>;
const database = new Proxy(
	{},
	{
		get: (_, key) => {
			const value = Reflect.get(fixture.database, key);
			return typeof value === "function" ? value.bind(fixture.database) : value;
		},
	},
);
mock.module("../db", () => ({ db: database }));
const inspect = mock(async (_options: unknown) => ({
	exitCode: 0,
	stdout: "true|192.0.2.2",
	stderr: "",
}));
mock.module("../lib/spawn", () => ({ safeSpawn: inspect }));
const { refreshCache, reconcileContainerStates, resolveTarget } = await import("./container-proxy");
const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";
const auth: CurrentResourceAuthority = {
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
};

beforeEach(() => {
	fixture = fixtureDatabase();
	fixture.database
		.insert(schema.users)
		.values([
			{ id: "owner", username: "owner", passwordHash: "fixture", createdAt: now },
			{ id: "other-owner", username: "other", passwordHash: "fixture", createdAt: now },
		])
		.run();
	for (const id of ["project", "other-project"])
		fixture.database
			.insert(schema.projects)
			.values({
				id,
				name: id,
				gitPath: `/fixture/${id}`,
				ownerUserId: "owner",
				proxyDomain: "fixture.test",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	fixture.database
		.insert(schema.narrators)
		.values({
			id: "source",
			ownerUserId: "owner",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	for (const id of ["legacy", "other-chapter"])
		fixture.database
			.insert(schema.chapters)
			.values({
				id,
				projectId: "project",
				title: id,
				branch: id,
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
	for (const id of ["original", "unrelated"])
		fixture.database
			.insert(schema.containerInstances)
			.values({
				id,
				chapterId: "legacy",
				serviceName: "app",
				status: id === "original" ? "running" : "paused",
				containerId: `podman-${id}`,
				proxyLabel: id,
				containerPort: 80,
				containerIp: "192.0.2.1",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	inspect.mockClear();
	inspect.mockImplementation(async () => ({ exitCode: 0, stdout: "true|192.0.2.2", stderr: "" }));
});
afterEach(() => {
	fixture.sqlite.close();
});
function row(id = "original") {
	return fixture.database
		.select()
		.from(schema.containerInstances)
		.where(eq(schema.containerInstances.id, id))
		.get();
}
function deferredInspect() {
	let release!: (stdout: string) => void;
	let started!: () => void;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const output = new Promise<string>((resolve) => {
		release = resolve;
	});
	inspect.mockImplementationOnce(async () => {
		started();
		return { exitCode: 0, stdout: await output, stderr: "" };
	});
	return { entered, release };
}
async function resourceReplacement() {
	fixture.database
		.delete(schema.containerInstances)
		.where(eq(schema.containerInstances.id, "original"))
		.run();
	const store = createWorktreeResourceMetadataStore({
		mode: "isolatedFixture",
		database: fixture.database,
		access: {
			backend: "sqlite",
			loadResource: async () =>
				(await fixture.database.query.narratorWorktreeResources.findFirst({
					where: eq(schema.narratorWorktreeResources.id, "resource"),
				})) ?? null,
			loadCurrentAuthority: async () => auth,
		},
		currentAuthority: () => auth,
	});
	await store.write({
		requestId: "replace",
		worktreeResourceId: "resource",
		expectedRevision: 3,
		actions: [{ kind: "container", id: "original", serviceName: "replacement" }],
	});
}
const mutations: Array<[string, () => void | Promise<void>]> = [
	["same ID becomes a metadata-store resource incarnation", resourceReplacement],
	[
		"null resource FK cannot erase resource ownership into the legacy domain",
		async () => {
			await resourceReplacement();
			// The real schema forbids an ownerless row; a SET NULL attempt is not a
			// legitimate legacy incarnation and must not make this stale inspect usable.
			expect(() =>
				fixture.sqlite.exec(
					"UPDATE container_instances SET worktree_resource_id=NULL WHERE id='original'",
				),
			).toThrow("CHECK constraint failed");
			expect(row()?.worktreeResourceId).toBe("resource");
		},
	],
	[
		"resource FK domain wins even with identical old runtime tuple",
		async () => {
			await resourceReplacement();
			fixture.database
				.update(schema.containerInstances)
				.set({
					serviceName: "app",
					status: "running",
					containerId: "podman-original",
					containerIp: "192.0.2.1",
					proxyLabel: "original",
					containerPort: 80,
					createdAt: now,
					updatedAt: now,
				})
				.where(eq(schema.containerInstances.id, "original"))
				.run();
		},
	],
	[
		"legacy container ID changes",
		() => {
			fixture.sqlite.exec(
				"UPDATE container_instances SET container_id='new-runtime' WHERE id='original'",
			);
		},
	],
	[
		"legacy createdAt changes",
		() => {
			fixture.sqlite.exec(
				`UPDATE container_instances SET created_at='${later}' WHERE id='original'`,
			);
		},
	],
	[
		"legacy state generation changes",
		() => {
			fixture.sqlite.exec(
				`UPDATE container_instances SET updated_at='${later}' WHERE id='original'`,
			);
		},
	],
	[
		"legacy status changes",
		() => {
			fixture.sqlite.exec("UPDATE container_instances SET status='paused' WHERE id='original'");
		},
	],
	[
		"legacy chapter owner changes",
		() => {
			fixture.sqlite.exec(
				"UPDATE container_instances SET chapter_id='other-chapter' WHERE id='original'",
			);
		},
	],
	[
		"chapter current project changes without timestamp bump",
		() => {
			fixture.sqlite.exec("UPDATE chapters SET project_id='other-project' WHERE id='legacy'");
		},
	],
	[
		"project current owner changes without timestamp bump",
		() => {
			fixture.sqlite.exec("UPDATE projects SET owner_user_id='other-owner' WHERE id='project'");
		},
	],
	[
		"project proxy domain changes",
		() => {
			fixture.sqlite.exec("UPDATE projects SET proxy_domain='changed.test' WHERE id='project'");
		},
	],
	[
		"proxy target tuple changes",
		() => {
			fixture.sqlite.exec(
				"UPDATE container_instances SET proxy_label='replacement',container_port=81,container_ip='192.0.2.9' WHERE id='original'",
			);
		},
	],
];

describe("deferred legacy inspect cannot write/cache another owner or incarnation", () => {
	for (const [name, operation, stdout] of [
		["refresh IP", refreshCache, "true|192.0.2.2"],
		["refresh stopped state", refreshCache, "false|"],
		["startup reconcile", reconcileContainerStates, "false|"],
	] as const) {
		for (const [mutationName, mutate] of mutations) {
			test(`${name}: ${mutationName}`, async () => {
				const unrelated = row("unrelated");
				const deferred = deferredInspect();
				const pending = operation();
				await deferred.entered;
				await mutate();
				const replacement = row();
				deferred.release(stdout);
				await pending;
				expect(row()).toEqual(replacement);
				expect(row("unrelated")).toEqual(unrelated);
				if (operation === refreshCache) expect(resolveTarget("original.fixture.test")).toBeNull();
				expect(inspect).toHaveBeenCalledTimes(1);
				if (mutationName === "same ID becomes a metadata-store resource incarnation") {
					expect(row()).toMatchObject({
						chapterId: null,
						worktreeResourceId: "resource",
						containerId: null,
						status: "stopped",
						containerIp: null,
						proxyLabel: null,
						containerPort: null,
					});
				}
			});
		}
	}
	test("normal legacy inspect updates IP and inserts its proxy target", async () => {
		const unrelated = row("unrelated");
		await refreshCache();
		expect(row()).toMatchObject({
			containerIp: "192.0.2.2",
			status: "running",
			chapterId: "legacy",
		});
		expect(resolveTarget("original.fixture.test")).toEqual({
			containerIp: "192.0.2.2",
			containerPort: 80,
			chapterId: "legacy",
			serviceName: "app",
		});
		expect(row("unrelated")).toEqual(unrelated);
	});
	for (const operation of [refreshCache, reconcileContainerStates]) {
		test(`normal legacy stopped inspection updates state (${operation.name})`, async () => {
			inspect.mockImplementation(async () => ({ exitCode: 0, stdout: "false|", stderr: "" }));
			await operation();
			expect(row()).toMatchObject({ status: "stopped", containerIp: "192.0.2.1" });
		});
	}
	test("failed old inspect neither deletes nor overwrites a newer refresh cache entry", async () => {
		const deferred = deferredInspect();
		const pending = refreshCache();
		await deferred.entered;
		fixture.database
			.update(schema.containerInstances)
			.set({
				containerId: "new-runtime",
				createdAt: later,
				updatedAt: later,
			})
			.where(eq(schema.containerInstances.id, "original"))
			.run();
		inspect.mockImplementation(async () => ({ exitCode: 0, stdout: "true|192.0.2.9", stderr: "" }));
		await refreshCache();
		const replacement = row();
		expect(resolveTarget("original.fixture.test")?.containerIp).toBe("192.0.2.9");
		deferred.release("false|");
		await pending;
		expect(row()).toEqual(replacement);
		expect(resolveTarget("original.fixture.test")?.containerIp).toBe("192.0.2.9");
	});
	test("real FK setNull leaves a chapter-bound legacy row, but cannot reuse a mixed resource owner", async () => {
		// The actual container resource FK is RESTRICT, not SET NULL. The legitimate
		// SET NULL edge is project.ownerUserId; the original snapshot binds it too.
		const deferred = deferredInspect();
		const pending = refreshCache();
		await deferred.entered;
		fixture.database.delete(schema.users).where(eq(schema.users.id, "owner")).run();
		expect(
			fixture.database.query.projects.findFirst({ where: eq(schema.projects.id, "project") }).sync()
				?.ownerUserId,
		).toBeNull();
		const replacement = row();
		deferred.release("true|192.0.2.2");
		await pending;
		expect(row()).toEqual(replacement);
		expect(resolveTarget("original.fixture.test")).toBeNull();
	});
});
