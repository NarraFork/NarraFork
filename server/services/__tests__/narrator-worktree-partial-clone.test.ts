/**
 * A narrator's worktree commands on a partial clone (or a repository naming a promisor remote)
 * when this git is not known to honour `GIT_NO_LAZY_FETCH`: a command that reads a missing
 * object would fetch it lazily through the repository-configured promisor remote, running its
 * transport and upload-pack. The service refuses such a repository before any object is read
 * (`GIT_TOO_OLD_FOR_PARTIAL_CLONE`); a normal repository, or a git that honours the variable,
 * proceeds as before.
 *
 * The promisor remote's upload-pack is a repository-configured program
 * (`remote.origin.uploadpack`) that records each run, so a lazy fetch is observable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "../../lib/agent/execution/local-backend";
import { createWorktreeTool } from "../../lib/agent/tools/worktree";
import type { ToolContext } from "../../lib/agent/types";
import { setNoLazyFetchSupportForTests } from "../../lib/git-exec-hardening";
import { safeSpawn } from "../../lib/spawn";
import type { WorktreeCreateRequest } from "../../lib/validators/narrator-worktrees";
import { FileWorktreeJournal } from "../narrator-worktree-journal";
import {
	NarratorWorktreeService,
	WORKTREE_MAX_OUTPUT_BYTES,
	type WorktreeRetirementPorts,
	type WorktreeServicePorts,
	type WorktreeTarget,
} from "../narrator-worktree-service";

const fixture = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"];
const signal = () => new AbortController().signal;
const posixOnly = test.skipIf(process.platform === "win32");

let temporary: string;
let upstream: string;
let marker: string;

async function git(args: string[], cwd: string) {
	const result = await safeSpawn({
		cmd: ["git", "-C", cwd, ...args],
		timeout: 20_000,
		maxOutputBytes: WORKTREE_MAX_OUTPUT_BYTES,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

/** A clone of `upstream` whose origin's upload-pack records every run in {@link marker}. */
async function cloneOf(name: string, options: { filter?: string; promisor?: boolean } = {}) {
	const clone = join(temporary, name);
	await git(
		[
			"-c",
			"protocol.file.allow=always",
			"clone",
			"-q",
			...(options.filter ? [`--filter=${options.filter}`] : []),
			`file://${upstream}`,
			clone,
		],
		temporary,
	);
	const helper = join(temporary, `upload-pack-${name}`);
	await writeFile(helper, `#!/bin/sh\necho ran >> '${marker}'\nexec git upload-pack "$@"\n`);
	await chmod(helper, 0o755);
	await git(["config", "remote.origin.uploadpack", helper], clone);
	if (options.promisor) await git(["config", "remote.origin.promisor", "true"], clone);
	await git(["branch", "-q", "other", "origin/other"], clone);
	await mkdir(join(clone, ".worktrees"));
	await writeFile(join(clone, ".git", "info", "exclude"), ".worktrees/\n");
	return clone;
}

function serviceFor(root: string) {
	const target: WorktreeTarget = {
		workspace: {
			deviceId: "local",
			cwd: root,
			rootPath: root,
			workspaceKey: "workspace",
			repositoryKey: "repository",
			state: "ready",
			capabilities: { read: true, write: true },
		},
		backend: new LocalBackend(),
		repositoryPath: join(root, ".git"),
	};
	// No `runGit` port: the production, hardened local executor.
	const ports: WorktreeServicePorts<string> = {
		authorize: async () => target,
		withRevision: async (_id, _expected, action) => action(),
		withRepositoryLock: async (_key, action) => action(),
		journal: new FileWorktreeJournal(join(temporary, `receipts-${Math.random()}`)),
		// Only the read-only removal preflight is exercised: nothing depends on the worktree.
		retirement: {
			inspect: async () => ({
				registration: null,
				dependents: [],
				inventory: {
					backgroundTasks: 0,
					browserSessions: 0,
					terminals: 0,
					containers: 0,
					volumeSnapshots: 0,
					treeSnapshots: 0,
				},
				truncated: false,
				revision: 1,
			}),
		} as unknown as WorktreeRetirementPorts,
	};
	return new NarratorWorktreeService(ports);
}

function request(root: string, id = "request-one"): WorktreeCreateRequest {
	return {
		expectedRevision: 1,
		workspaceKey: "workspace",
		requestId: id,
		destinationPath: join(root, ".worktrees", id),
		branch: { kind: "existing", name: "other" },
	};
}

/** The git built-ins a GIT_TRACE file shows ran. */
async function tracedCommands(trace: string): Promise<string[]> {
	const text = await readFile(trace, "utf8").catch(() => "");
	return [
		...new Set(
			text
				.split("\n")
				.map((line) => /trace: built-in: git (\S+)/.exec(line)?.[1])
				.filter((command): command is string => !!command),
		),
	];
}

const ran = () => existsSync(marker);

beforeEach(async () => {
	temporary = await mkdtemp(join(tmpdir(), "narrafork-worktree-partial-"));
	upstream = join(temporary, "upstream");
	marker = join(temporary, "promisor-ran");
	await mkdir(upstream);
	await git(["init", "-q", "-b", "main"], upstream);
	await writeFile(join(upstream, "tracked.txt"), "committed\n");
	await git(["add", "tracked.txt"], upstream);
	await git([...fixture, "commit", "-qm", "initial"], upstream);
	// A blob only `other` has: a blobless clone of main lacks it until something reads it.
	await git(["checkout", "-qb", "other"], upstream);
	await writeFile(join(upstream, "other.txt"), "only on other\n");
	await git(["add", "other.txt"], upstream);
	await git([...fixture, "commit", "-qm", "other"], upstream);
	await git(["checkout", "-q", "main"], upstream);
	await git(["config", "uploadpack.allowFilter", "true"], upstream);
	await git(["config", "uploadpack.allowAnySHA1InWant", "true"], upstream);
});

afterEach(async () => {
	setNoLazyFetchSupportForTests(null);
	delete process.env.GIT_TRACE;
	await rm(temporary, { recursive: true, force: true });
});

describe("narrator worktrees on a partial clone", () => {
	posixOnly(
		"without lazy-fetch protection a partial clone is refused before any object is read",
		async () => {
			const clone = await cloneOf("partial", { filter: "blob:none" });
			await rm(marker, { force: true });
			const service = serviceFor(clone);
			const trace = join(temporary, "trace");
			setNoLazyFetchSupportForTests(false);
			process.env.GIT_TRACE = trace;
			const result = await service.create("actor", "narrator", request(clone), signal());
			delete process.env.GIT_TRACE;
			expect(result.outcome).toBe("failed");
			expect(result.error?.code).toBe("GIT_TOO_OLD_FOR_PARTIAL_CLONE");
			// Nothing was fetched, and nothing was half-created.
			expect(ran()).toBe(false);
			expect(existsSync(request(clone).destinationPath)).toBe(false);
			expect(await git(["worktree", "list", "--porcelain"], clone)).not.toContain("request-one");
			// Only configuration and metadata were read: no command that reads objects ran.
			const commands = await tracedCommands(trace);
			expect(commands.length).toBeGreaterThan(0);
			for (const command of commands)
				expect(["config", "check-ref-format", "rev-parse"]).toContain(command);
		},
	);

	posixOnly("the agent tool reports the refusal with its catalog code", async () => {
		const clone = await cloneOf("partial", { filter: "blob:none" });
		await rm(marker, { force: true });
		setNoLazyFetchSupportForTests(false);
		const tool = createWorktreeTool(serviceFor(clone), async () => "actor");
		const ctx = { narratorId: "narrator", signal: signal() } as ToolContext;
		const result = await tool.execute({ action: "create", ...request(clone) }, ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("GIT_TOO_OLD_FOR_PARTIAL_CLONE");
		expect(ran()).toBe(false);
	});

	posixOnly("a promisor remote on a full clone is refused the same way", async () => {
		const clone = await cloneOf("promisor", { promisor: true });
		await rm(marker, { force: true });
		setNoLazyFetchSupportForTests(false);
		const result = await serviceFor(clone).create("actor", "narrator", request(clone), signal());
		expect(result.error?.code).toBe("GIT_TOO_OLD_FOR_PARTIAL_CLONE");
		expect(ran()).toBe(false);
	});

	posixOnly("listing still works: only the commit metadata of the rows is left out", async () => {
		const clone = await cloneOf("partial", { filter: "blob:none" });
		await rm(marker, { force: true });
		setNoLazyFetchSupportForTests(false);
		const listed = await serviceFor(clone).list(
			"actor",
			"narrator",
			{ workspaceKey: "workspace" },
			signal(),
		);
		expect(listed.entries).toHaveLength(1);
		expect(listed.entries[0]?.lastCommitAt).toBeNull();
		expect(ran()).toBe(false);
	});

	posixOnly("removal preflight names the refusal instead of an unmeasured loss", async () => {
		const clone = await cloneOf("partial", { filter: "blob:none" });
		const worktree = join(clone, ".worktrees", "existing");
		await git(["worktree", "add", "-q", worktree, "other"], clone);
		await rm(marker, { force: true });
		setNoLazyFetchSupportForTests(false);
		const plan = serviceFor(clone).planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: worktree },
			signal(),
		);
		await expect(plan).rejects.toMatchObject({ code: "GIT_TOO_OLD_FOR_PARTIAL_CLONE" });
		expect(ran()).toBe(false);
		// Refusing changes nothing on disk.
		expect(existsSync(join(worktree, "other.txt"))).toBe(true);
	});

	posixOnly("a git that honours GIT_NO_LAZY_FETCH creates the worktree as before", async () => {
		const clone = await cloneOf("partial", { filter: "blob:none" });
		setNoLazyFetchSupportForTests(true);
		const result = await serviceFor(clone).create("actor", "narrator", request(clone), signal());
		expect(result.outcome).toBe("created");
		expect(await readFile(join(request(clone).destinationPath, "other.txt"), "utf8")).toBe(
			"only on other\n",
		);
	});

	posixOnly("a normal clone is created as before without lazy-fetch protection", async () => {
		const clone = await cloneOf("full");
		await rm(marker, { force: true });
		setNoLazyFetchSupportForTests(false);
		const result = await serviceFor(clone).create("actor", "narrator", request(clone), signal());
		expect(result.outcome).toBe("created");
		expect(await readFile(join(request(clone).destinationPath, "other.txt"), "utf8")).toBe(
			"only on other\n",
		);
		expect(ran()).toBe(false);
	});
});
