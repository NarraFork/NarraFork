import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { safeSpawn } from "../lib/spawn";
import {
	type LegacyRootAdoptionInput,
	type LegacyRootAdoptionOverrides,
	legacyLocalWorkspaceContext,
	prepareLegacyRootAdoption,
} from "./legacy-main-checkout-adoption";
import type { LegacyRootHistoryInput } from "./legacy-root-history";
import { treeSnapshotKey, treeSnapshotPhysicalDir } from "./tree-snapshot-paths";

const fixtures: string[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true });
});
async function fixture(git = true) {
	const root = await mkdtemp(join(tmpdir(), "legacy-root-adoption-"));
	fixtures.push(root);
	if (git) await command(root, "init", "-b", "not-main");
	return root;
}
async function command(root: string, ...args: string[]) {
	const result = await safeSpawn({
		cmd: ["git", "-C", root, ...args],
		timeout: 10_000,
		maxOutputBytes: 32_768,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout;
}
function input(root: string, complex = true): LegacyRootAdoptionInput {
	return {
		project: { id: "project", git_path: root },
		chapters: [
			{
				id: "chapter",
				is_root: 1,
				worktree_path: complex ? root : null,
				snapshot_shadow_key: null,
			},
		],
		sessions: [
			{
				id: "narrator",
				chapter_id: "chapter",
				cwd: root,
				workspace_revision: 3,
				default_device_id: "local",
				workspace_context: null,
				variant: "primary",
				traits: "[]",
			},
		],
		databasePath: "/not-opened.sqlite",
	};
}
const empty: LegacyRootAdoptionOverrides = {
	history: async () => ({
		status: "empty",
		digest: "a".repeat(64),
		guards: [{ id: "narrator", messageVersion: 0, messageStructureVersion: 0, nextSeq: 1 }],
	}),
};
const blocked = async (data: LegacyRootAdoptionInput, seam: LegacyRootAdoptionOverrides = {}) => {
	const result = await prepareLegacyRootAdoption(data, { ...empty, ...seam });
	expect(result.blockers.length).toBeGreaterThan(0);
	expect(result.updates).toEqual([]);
	return result;
};

describe("read-only ordinary main checkout adoption", () => {
	test("retained readiness cannot promote unknown strict history or regress a confirmed empty root", async () => {
		const root = await fixture();
		const data = input(root);
		data.retainHistory = true;
		const knownEmpty = await prepareLegacyRootAdoption(data, empty);
		expect(knownEmpty.blockers).toEqual([]);
		expect(knownEmpty.history.status).toBe("empty");
		const unknown = await prepareLegacyRootAdoption(data, {
			history: async () => ({
				status: "unknown",
				digest: "c".repeat(64),
				reason: "incomplete source inventory",
			}),
		});
		expect(unknown.history.status).toBe("unknown");
		expect(unknown.updates).toEqual([]);
		expect(unknown.blockers.some((blocker) => blocker.code === "ADOPTION_HISTORY")).toBe(true);
	});
	test("unborn/non-main root is adopted with exact physical keys and next revision", async () => {
		const root = await fixture();
		const result = await prepareLegacyRootAdoption(input(root), empty);
		expect(result.blockers).toEqual([]);
		const update = result.updates[0];
		expect(update.previous).toEqual(legacyLocalWorkspaceContext(root, 3, "project", root));
		expect(update.current.revision).toBe(4);
		expect(update.current.contextProjectId).toBeUndefined();
		expect(update.current.contextKey).toBe(update.previous.contextKey);
		expect(update.directoryIdentity).toEqual({
			dev: (await stat(root)).dev,
			ino: (await stat(root)).ino,
		});
		const metadata = await lstat(join(root, ".git"));
		expect(update.gitDirectoryIdentity).toEqual({ dev: metadata.dev, ino: metadata.ino });
		expect(result.history.guards?.[0].id).toBe("narrator");
	});
	test("dirty tracked/untracked files and .narrafork user resources survive unchanged", async () => {
		const root = await fixture();
		await writeFile(join(root, "tracked"), "original");
		await command(root, "add", "tracked");
		await command(
			root,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit",
			"-m",
			"fixture",
		);
		await writeFile(join(root, "tracked"), "dirty");
		await mkdir(join(root, ".narrafork", "skills"), { recursive: true });
		await mkdir(join(root, ".narrafork", "plans"), { recursive: true });
		await writeFile(join(root, ".narrafork", "user-file"), "keep");
		const before = await command(root, "status", "--porcelain=v1");
		const index = await readFile(join(root, ".git", "index"));
		const result = await prepareLegacyRootAdoption(input(root), empty);
		expect(result.blockers).toEqual([]);
		expect(await command(root, "status", "--porcelain=v1")).toBe(before);
		expect(await readFile(join(root, ".git", "index"))).toEqual(index);
		expect(await readFile(join(root, "tracked"), "utf8")).toBe("dirty");
		expect(await readFile(join(root, ".narrafork", "user-file"), "utf8")).toBe("keep");
	});
	test("valid persisted context wins over lower-priority explicit/runtime cwd", async () => {
		const root = await fixture();
		const data = input(root);
		data.sessions[0].workspace_context = JSON.stringify(
			legacyLocalWorkspaceContext(root, 3, "project", root),
		);
		data.sessions[0].cwd = "/old-uninstalled-directory";
		data.sessions[0].runtime_cwd = "/old-runtime-directory";
		const result = await prepareLegacyRootAdoption(data, empty);
		expect(result.blockers).toEqual([]);
		expect(result.updates[0].current.cwd).toBe(root);
	});
	test("runtime cwd precedes explicit cwd; never falls back home", async () => {
		const root = await fixture();
		const data = input(root);
		data.sessions[0].cwd = "/missing-cwd";
		data.sessions[0].runtime_cwd = root;
		expect((await prepareLegacyRootAdoption(data, empty)).blockers).toEqual([]);
		data.project.git_path = null;
		data.chapters[0].worktree_path = null;
		data.sessions[0].cwd = null;
		data.sessions[0].runtime_cwd = null;
		await blocked(data);
	});
	test("malformed, oversized, stale and inconsistent persisted contexts fail closed", async () => {
		const root = await fixture();
		const ctx = legacyLocalWorkspaceContext(root, 3, "project", root);
		for (const raw of [
			"{",
			" ".repeat(16_385),
			"null",
			JSON.stringify({ ...ctx, revision: 2 }),
			JSON.stringify({ ...ctx, pathFlavor: "windows" }),
			JSON.stringify({ ...ctx, contextKey: "bad" }),
			JSON.stringify({ ...ctx, git: { ...ctx.git, repositoryKey: "bad" } }),
			JSON.stringify({ ...ctx, capabilities: {} }),
		]) {
			const data = input(root);
			data.sessions[0].workspace_context = raw;
			await blocked(data);
		}
	});
	test("remote devices, external ancestry, multiple cwd and empty inventories block", async () => {
		const root = await fixture();
		for (const fields of [
			{ default_device_id: "remote" },
			{ runtime_device: "remote" },
			{ parent_narrator_id: "outside" },
			{ acl_root_narrator_id: "outside" },
			{ workspace_revision: -1 },
		]) {
			const data = input(root);
			Object.assign(data.sessions[0], fields);
			await blocked(data);
		}
		const data = input(root);
		await mkdir(join(root, "nested"));
		data.sessions[0].cwd = join(root, "nested");
		await blocked(data);
		data.sessions = [];
		await blocked(data);
	});
	test("ordinary primary capability matches traits without erasing them", async () => {
		const root = await fixture();
		for (const traits of ["[]", '["background"]', '["knowledge-steward"]']) {
			const data = input(root);
			data.sessions[0].traits = traits;
			const result = await prepareLegacyRootAdoption(data, empty);
			expect(result.blockers).toEqual([]);
			expect(result.updates[0].current.capabilities.switchDirectory).toBe(traits === "[]");
			expect(data.sessions[0].traits).toBe(traits);
		}
	});
	test("canonical shadow key is inspected at trusted physical path; foreign key blocks", async () => {
		const root = await fixture();
		const data = input(root);
		data.chapters[0].snapshot_shadow_key = treeSnapshotKey("local", root);
		let observed: LegacyRootHistoryInput | undefined;
		const result = await prepareLegacyRootAdoption(data, {
			history: async (request) => {
				observed = request;
				return {
					status: "empty",
					digest: "a".repeat(64),
					guards: [{ id: "narrator", messageVersion: 0, messageStructureVersion: 0, nextSeq: 1 }],
				};
			},
		});
		expect(result.blockers).toEqual([]);
		expect(observed?.workspacePaths).toEqual([root]);
		expect(observed?.shadowDirectories).toEqual([treeSnapshotPhysicalDir("local", root)]);
		expect(observed?.databasePath).toBe(data.databasePath);
		data.chapters[0].snapshot_shadow_key = "/untrusted-directory";
		await blocked(data);
	});
	test("history or unknown never grants adoption; evidence participates in digest", async () => {
		const root = await fixture();
		const data = input(root);
		const good = await prepareLegacyRootAdoption(data, empty);
		const other = await prepareLegacyRootAdoption(data, {
			history: async () => ({
				status: "empty",
				digest: "b".repeat(64),
				guards: [{ id: "narrator", messageVersion: 0, messageStructureVersion: 0, nextSeq: 1 }],
			}),
		});
		expect(other.digest).not.toBe(good.digest);
		for (const status of ["history", "unknown"] as const)
			await blocked(data, { history: async () => ({ status, digest: "c".repeat(64) }) });
	});
	test("plain nonGit explicit cwd remains supported but complex nonGit blocks", async () => {
		const root = await fixture(false);
		const result = await prepareLegacyRootAdoption(input(root, false), empty);
		expect(result.blockers).toEqual([]);
		expect(result.updates[0].current.git).toBeUndefined();
		expect(result.updates[0]).not.toHaveProperty("gitDirectoryIdentity");
		await blocked(input(root));
		await blocked(input(await fixture(), false));
	});
	test("bare, linked-worktree/gitfile and symlink .git are excluded", async () => {
		const bare = await fixture(false);
		await command(bare, "init", "--bare");
		await blocked(input(bare));
		const root = await fixture();
		await writeFile(join(root, "a"), "a");
		await command(root, "add", "a");
		await command(
			root,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit",
			"-m",
			"fixture",
		);
		const linked = await fixture(false);
		await command(root, "worktree", "add", "-b", "linked", linked);
		await blocked(input(linked));
		const alias = await fixture(false);
		await symlink(join(root, ".git"), join(alias, ".git"), "dir");
		await blocked(input(alias));
	});
	test("probe errors/timeouts/overflow fail closed; env and budgets are bounded", async () => {
		const root = await fixture();
		let seen = false;
		const result = await prepareLegacyRootAdoption(input(root), {
			...empty,
			spawn: async (options) => {
				seen = true;
				expect(options.timeout).toBe(10_000);
				expect(options.maxOutputBytes).toBe(32_768);
				expect(Object.keys(options.env ?? {}).some((key) => /^GIT_/i.test(key))).toBe(false);
				expect(options.cmd).not.toContain("status");
				expect(options.cmd).not.toContain("checkout");
				return safeSpawn(options);
			},
		});
		expect(seen).toBe(true);
		expect(result.blockers).toEqual([]);
		for (const spawn of [
			async () => {
				throw new Error("timeout");
			},
			async () => ({ exitCode: 1, stdout: "", stderr: "fatal: permission denied" }),
			async () => ({ exitCode: 0, stdout: "true\nfalse", stderr: "", stdoutTruncated: true }),
		])
			await blocked(input(root), { spawn });
	});
	test("missing history guards and changing Git discovery fail closed", async () => {
		const root = await fixture();
		await blocked(input(root), {
			history: async () => ({ status: "empty", digest: "a".repeat(64), guards: [] }),
		});
		let calls = 0;
		await blocked(input(root), {
			spawn: async (options) => {
				const probe = await safeSpawn(options);
				if (++calls === 2) probe.stdout = probe.stdout.replace("false", "true");
				return probe;
			},
		});
	});
	test("Git directory proof is revalidated, bounded and included in the digest", async () => {
		const root = await fixture();
		const first = await prepareLegacyRootAdoption(input(root), empty);
		let calls = 0;
		await blocked(input(root), {
			lstat: (async (...args: Parameters<typeof lstat>) => {
				const metadata = await lstat(...args);
				if (++calls === 2) metadata.ino++;
				return metadata;
			}) as typeof lstat,
		});
		for (const invalid of [-1, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
			await blocked(input(root), {
				lstat: (async (...args: Parameters<typeof lstat>) => {
					const metadata = await lstat(...args);
					metadata.dev = invalid;
					return metadata;
				}) as typeof lstat,
			});
		}
		const differentIdentity = await prepareLegacyRootAdoption(input(root), {
			...empty,
			lstat: (async (...args: Parameters<typeof lstat>) => {
				const metadata = await lstat(...args);
				metadata.ino++;
				return metadata;
			}) as typeof lstat,
		});
		expect(differentIdentity.blockers).toEqual([]);
		expect(differentIdentity.updates[0].gitDirectoryIdentity?.ino).toBe(
			(first.updates[0].gitDirectoryIdentity?.ino ?? 0) + 1,
		);
		expect(differentIdentity.digest).not.toBe(first.digest);
	});
	test("changed directory inode fails closed", async () => {
		const root = await fixture();
		let calls = 0;
		await blocked(input(root), {
			stat: (async (...args: Parameters<typeof stat>) => {
				const s = await stat(...args);
				if (++calls > 1) s.ino++;
				return s;
			}) as typeof stat,
		});
	});
	test("linked workspace and repository identities use top and common independently", () => {
		const root = join(tmpdir(), "identity-main");
		const top = join(tmpdir(), "identity-linked");
		const common = join(root, ".git");
		const main = legacyLocalWorkspaceContext(root, 1, "project", root);
		const linked = legacyLocalWorkspaceContext(top, 1, "project", top, common);
		expect(linked.git?.repositoryKey).toBe(main.git?.repositoryKey);
		expect(linked.git?.workspaceKey).not.toBe(main.git?.workspaceKey);
		expect(linked.contextKey).not.toBe(main.contextKey);
		expect(linked.cwd).toBe(top);
		expect(linked.git?.rootPath).toBe(top);
	});
	test("context hash algorithms are equivalent to source service identities", () => {
		const root = join(tmpdir(), "exact-context");
		const digest = (value: unknown) =>
			createHash("sha256").update(JSON.stringify(value)).digest("hex");
		const ctx = legacyLocalWorkspaceContext(root, 4, "project", root);
		const workspaceKey = digest(["local", localPathSemantics.identityKey(root)]);
		const repositoryKey = digest(["local", localPathSemantics.identityKey(join(root, ".git"))]);
		expect(ctx.git).toEqual({ rootPath: root, workspaceKey, repositoryKey });
		expect(ctx.contextKey).toBe(
			digest(["local", localPathSemantics.identityKey(root), workspaceKey, repositoryKey]),
		);
		expect(legacyLocalWorkspaceContext(root, 4, "project").contextKey).toBe(
			digest(["local", localPathSemantics.identityKey(root), null, null]),
		);
	});
});
