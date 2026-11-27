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
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function serviceFor(root: string, extra: Partial<WorktreeServicePorts<string>> = {}) {
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
		...extra,
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

	posixOnly(
		"removal preflight names the refusal as its blocker, not an unmeasured loss",
		async () => {
			const clone = await cloneOf("partial", { filter: "blob:none" });
			const worktree = join(clone, ".worktrees", "existing");
			await git(["worktree", "add", "-q", worktree, "other"], clone);
			await rm(marker, { force: true });
			setNoLazyFetchSupportForTests(false);
			const service = serviceFor(clone);
			const removal = { workspaceKey: "workspace", path: worktree };
			const plan = await service.planRemoval("actor", "narrator", removal, signal());
			expect(plan.status).toBe("blocked");
			expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
				"GIT_TOO_OLD_FOR_PARTIAL_CLONE",
			]);
			await expect(
				service.remove(
					"actor",
					"narrator",
					{ ...removal, expectedRevision: plan.expectedRevision },
					signal(),
				),
			).rejects.toMatchObject({ code: "GIT_TOO_OLD_FOR_PARTIAL_CLONE" });
			expect(ran()).toBe(false);
			// Refusing changes nothing on disk.
			expect(existsSync(join(worktree, "other.txt"))).toBe(true);
		},
	);

	posixOnly("a pruned checkout (no object read to measure) is blocked the same way", async () => {
		const clone = await cloneOf("partial", { filter: "blob:none" });
		const worktree = join(clone, ".worktrees", "gone");
		await git(["worktree", "add", "-q", worktree, "other"], clone);
		// The checkout directory disappeared outside NarraFork; its branch HEAD is not detached.
		await rm(worktree, { recursive: true, force: true });
		await rm(marker, { force: true });
		setNoLazyFetchSupportForTests(false);
		const service = serviceFor(clone);
		const removal = { workspaceKey: "workspace", path: worktree };
		const plan = await service.planRemoval("actor", "narrator", removal, signal());
		expect(plan.worktree.mode).toBe("prune");
		expect(plan.status).toBe("blocked");
		expect(plan.blockers.map((blocker) => blocker.code)).toEqual(["GIT_TOO_OLD_FOR_PARTIAL_CLONE"]);
		// The same repository on a git that honours GIT_NO_LAZY_FETCH is ready to prune.
		setNoLazyFetchSupportForTests(true);
		expect((await service.planRemoval("actor", "narrator", removal, signal())).status).toBe(
			"ready",
		);
		expect(ran()).toBe(false);
	});

	test("a configuration the gate cannot read blocks removal as unmeasurable, never throws", async () => {
		const clone = await cloneOf("full");
		const worktree = join(clone, ".worktrees", "existing");
		await git(["worktree", "add", "-q", worktree, "other"], clone);
		// Over the 64 KB cap of the gate's configuration read (the listing itself reads none).
		const filters = Array.from(
			{ length: 3000 },
			(_, i) => `[filter "f${i}"]\n\tclean = cat\n`,
		).join("");
		await appendFile(join(clone, ".git", "config"), filters);
		setNoLazyFetchSupportForTests(false);
		const plan = await serviceFor(clone).planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: worktree },
			signal(),
		);
		expect(plan.status).toBe("blocked");
		expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
			"WORKTREE_REMOVAL_STATUS_UNAVAILABLE",
		]);
		expect(existsSync(worktree)).toBe(true);
	});

	posixOnly("a promisor added right before the add is a clean, undispatched failure", async () => {
		const clone = await cloneOf("full");
		await rm(marker, { force: true });
		setNoLazyFetchSupportForTests(false);
		const calls: string[] = [];
		const journal = new FileWorktreeJournal(join(temporary, "receipts-race"));
		const service = serviceFor(clone, {
			journal,
			resources: {
				// The last step before the durable "started" boundary and the add.
				register: async () => {
					calls.push("register");
					await git(["config", "remote.origin.promisor", "true"], clone);
					return { inserted: true };
				},
				setState: async (_resource, state) => {
					calls.push(`state:${state}`);
				},
				releaseUndispatched: async () => {
					calls.push("release");
				},
			},
		});
		const result = await service.create("actor", "narrator", request(clone), signal());
		expect(result).toMatchObject({
			outcome: "failed",
			error: { code: "GIT_TOO_OLD_FOR_PARTIAL_CLONE" },
		});
		// No "unknown" row: the registration made for this attempt is released, never protected.
		expect(calls).toEqual(["register", "release"]);
		expect((await journal.read("narrator", "request-one"))?.dispatchState).toBe("not_started");
		expect(existsSync(request(clone).destinationPath)).toBe(false);
		expect(ran()).toBe(false);
	});

	posixOnly(
		"an unverifiable receipt stays unknown but names the partial-clone refusal",
		async () => {
			const clone = await cloneOf("partial", { filter: "blob:none" });
			const journal = new FileWorktreeJournal(join(temporary, "receipts-replay"));
			const save = journal.save.bind(journal);
			journal.save = async (...args) => {
				if (args[2].result) throw new Error("Receipt storage failed after Git succeeded");
				return save(...args);
			};
			setNoLazyFetchSupportForTests(true);
			const first = await serviceFor(clone, { journal }).create(
				"actor",
				"narrator",
				request(clone),
				signal(),
			);
			expect(first.outcome).toBe("created");
			journal.save = save;
			await rm(marker, { force: true });
			setNoLazyFetchSupportForTests(false);
			const replay = await serviceFor(clone, { journal }).create(
				"actor",
				"narrator",
				request(clone),
				signal(),
			);
			expect(replay).toMatchObject({
				outcome: "unknown",
				error: { code: "GIT_TOO_OLD_FOR_PARTIAL_CLONE" },
			});
			expect(replay.error?.message).toContain("reuse this requestId");
			expect(ran()).toBe(false);
		},
	);

	posixOnly(
		"a promisor added after the gate read the configuration still fetches nothing",
		async () => {
			const real = Bun.which("git");
			if (!real) throw new Error("git is not on PATH");
			const clone = await cloneOf("full");
			// A worktree whose HEAD is a commit only upstream has: listing it reads that commit.
			const later = join(temporary, "later");
			await git(["worktree", "add", "-q", "-b", "later", later, "main"], upstream);
			await git([...fixture, "commit", "-q", "--allow-empty", "-m", "later"], later);
			const missing = await git(["rev-parse", "HEAD"], later);
			const detached = join(clone, ".worktrees", "detached");
			await git(["worktree", "add", "-q", "--detach", detached, "HEAD"], clone);
			await writeFile(join(clone, ".git", "worktrees", "detached", "HEAD"), `${missing}\n`);
			// An old git: GIT_NO_LAZY_FETCH is ignored. The promisor appears right after the gate's
			// configuration read (check, then use).
			const bin = join(temporary, "bin");
			const injected = join(temporary, "injected");
			await mkdir(bin);
			await writeFile(
				join(bin, "git"),
				[
					"#!/bin/sh",
					"unset GIT_NO_LAZY_FETCH",
					'case " $* " in',
					'*" --get-regexp "*)',
					`\t'${real}' "$@"; status=$?`,
					`\tif [ ! -e '${injected}' ]; then touch '${injected}'; '${real}' -C '${clone}' config remote.origin.promisor true; fi`,
					"\texit $status ;;",
					"esac",
					`exec '${real}' "$@"`,
					"",
				].join("\n"),
			);
			await chmod(join(bin, "git"), 0o755);
			await rm(marker, { force: true });
			setNoLazyFetchSupportForTests(false);
			const path = process.env.PATH;
			process.env.PATH = `${bin}:${path ?? ""}`;
			try {
				const listed = await serviceFor(clone).list(
					"actor",
					"narrator",
					{ workspaceKey: "workspace" },
					signal(),
				);
				expect(existsSync(injected)).toBe(true);
				expect(listed.entries).toHaveLength(2);
				expect(ran()).toBe(false);
				// Control: the same read without the transport ban does fetch through the promisor.
				const control = await safeSpawn({
					cmd: ["git", "-C", clone, "show", "--no-walk", "--no-patch", "--format=%H", missing],
					timeout: 20_000,
					maxOutputBytes: 4096,
					env: { ...process.env, PATH: process.env.PATH },
				});
				expect(control.exitCode).toBe(0);
				expect(ran()).toBe(true);
			} finally {
				process.env.PATH = path;
			}
		},
	);

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
