import { execFileSync } from "node:child_process";
import { parseComponentVersions } from "../../shared/helper-distribution";
import { isValidReleaseVersion } from "../../shared/release-version";
import { type GhRunner, runGh, validateGitHubRepository } from "./github-release";

const WORKFLOW = ".github/workflows/release.yml";
/** Inspect the frozen release source, not whichever component pin today's checkout contains. */
export function releaseSourceDeclaresRemotePeer(
	root: string,
	commit: string,
	readGit: (args: string[]) => string = (args) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 64 * 1024,
		}).trim(),
): boolean {
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected exact release source commit");
	const path = "shared/component-versions.json";
	const entry = readGit(["ls-tree", "--name-only", commit, "--", path]);
	if (!entry) return false;
	if (entry !== path) throw new Error("Ambiguous release component pin path");
	return Boolean(
		parseComponentVersions(JSON.parse(readGit(["show", `${commit}:${path}`]))).remotePeer,
	);
}
interface ReleaseRun {
	id: number;
	event: string;
	path: string;
	head_sha: string;
	head_branch: string;
	display_title: string;
	actor: { login: string };
	head_repository: { full_name: string };
	status: string;
	conclusion: string | null;
}
function record(raw: string): Record<string, unknown> {
	if (Buffer.byteLength(raw) > 1024 * 1024)
		throw new Error("Release dispatch response exceeds limit");
	const value = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid release dispatch response");
	return value;
}
function positiveId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}
async function wait(ms: number, signal: AbortSignal) {
	signal.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const done = () => {
			signal.removeEventListener("abort", cancel);
			resolve();
		};
		const timer = setTimeout(done, ms);
		const cancel = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			reject(signal.reason);
		};
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) cancel();
	});
}
/** Run the ordinary protected main release; never synthesizes a CI identity or publishes locally. */
export async function dispatchMainRelease(options: {
	repository: string;
	version: string;
	commit: string;
	run?: GhRunner;
	signal?: AbortSignal;
	timeoutMs?: number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	log?: (message: string) => void;
}): Promise<{ runId: number; commit: string }> {
	validateGitHubRepository(options.repository);
	if (!isValidReleaseVersion(options.version) || !/^[a-f0-9]{40}$/.test(options.commit))
		throw new Error("Invalid main release dispatch identity");
	const timeout = options.timeoutMs ?? 90 * 60_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2 * 60 * 60_000)
		throw new Error("Invalid main release wait budget");
	const deadline = AbortSignal.timeout(timeout);
	const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), deadline]);
	const run = options.run ?? runGh;
	const call = async (args: string[]) => {
		signal.throwIfAborted();
		const value = await run(args, {
			signal,
			timeoutMs: Math.min(timeout, 30_000),
			maxOutputBytes: 1024 * 1024,
		});
		signal.throwIfAborted();
		if (Buffer.byteLength(value) > 1024 * 1024) throw new Error("Release dispatch output limit");
		return value;
	};
	const repository = options.repository;
	const tag = `v${options.version}`;
	const repo = record(await call(["api", `repos/${repository}`]));
	if (
		typeof repo.full_name !== "string" ||
		repo.full_name.toLowerCase() !== repository.toLowerCase() ||
		repo.private !== false ||
		typeof repo.default_branch !== "string" ||
		!/^[A-Za-z0-9_./-]{1,240}$/.test(repo.default_branch)
	)
		throw new Error("Expected public release repository and default branch");
	const branch = repo.default_branch;
	const user = record(await call(["api", "user"]));
	if (typeof user.login !== "string" || !/^[A-Za-z0-9_[\]-]{1,100}$/.test(user.login))
		throw new Error("Cannot bind release dispatch actor");
	const workflow = record(await call(["api", `repos/${repository}/actions/workflows/release.yml`]));
	if (workflow.path !== WORKFLOW || workflow.state !== "active" || !positiveId(workflow.id))
		throw new Error("Main release workflow unavailable");
	const ref = record(
		await call(["api", `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`]),
	);
	const control = ref.object as { type?: unknown; sha?: unknown } | undefined;
	if (
		control?.type !== "commit" ||
		typeof control.sha !== "string" ||
		!/^[a-f0-9]{40}$/.test(control.sha)
	)
		throw new Error("Invalid release control commit");
	const verifyTag = async () => {
		let value = record(
			await call(["api", `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`]),
		);
		for (let depth = 0; depth < 5; depth++) {
			const obj = value.object as { type?: unknown; sha?: unknown } | undefined;
			if (!obj || typeof obj.sha !== "string" || !/^[a-f0-9]{40}$/.test(obj.sha))
				throw new Error("Invalid remote release tag");
			if (obj.type === "commit") {
				if (obj.sha !== options.commit) throw new Error("Remote main tag commit mismatch");
				return;
			}
			if (obj.type !== "tag") throw new Error("Unsupported remote main tag object");
			value = record(await call(["api", `repos/${repository}/git/tags/${obj.sha}`]));
		}
		throw new Error("Remote main tag nesting exceeds limit");
	};
	try {
		await verifyTag();
	} catch (error) {
		throw new Error(
			`Main tag ${tag} must already be pushed and match the local release source; peer publication needs no separate command`,
			{ cause: error },
		);
	}
	// Bind the exact dispatch response; never guess among concurrent runs with the same tag.
	// Explicit API version supports return_run_details even on clients whose gh CLI is older.
	const created = record(
		await call([
			"api",
			"--method",
			"POST",
			`repos/${repository}/actions/workflows/release.yml/dispatches`,
			"-H",
			"X-GitHub-Api-Version: 2022-11-28",
			"-f",
			`ref=${branch}`,
			"-f",
			`inputs[tag]=${tag}`,
			"-F",
			"inputs[publish]=true",
			"-F",
			"return_run_details=true",
		]),
	);
	if (!positiveId(created.workflow_run_id))
		throw new Error(
			"Main release may have been dispatched but no exact run ID was returned; inspect Actions before retrying",
		);
	const selected = { id: created.workflow_run_id };
	const title = `Release ${tag} (publish)`;
	const matches = (r: ReleaseRun) =>
		r.event === "workflow_dispatch" &&
		r.path === WORKFLOW &&
		r.head_branch === branch &&
		r.head_sha === control.sha &&
		r.display_title === title &&
		r.actor?.login === user.login &&
		r.head_repository?.full_name?.toLowerCase() === repository.toLowerCase();
	const sleep = options.sleep ?? wait;
	options.log?.(
		`Main release run ${selected.id}: waiting for normal CI and release approval; peer is handled automatically`,
	);
	for (;;) {
		signal.throwIfAborted();
		const current = record(
			await call(["api", `repos/${repository}/actions/runs/${selected.id}`]),
		) as unknown as ReleaseRun;
		if (current.id !== selected.id || !matches(current))
			throw new Error("Main release run identity changed");
		if (current.status === "completed") {
			if (current.conclusion !== "success")
				throw new Error(
					`Main release run ${selected.id} did not succeed; inspect its logs before retrying`,
				);
			break;
		}
		await sleep(15000, signal);
	}
	await verifyTag();
	const release = record(
		await call(["api", `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`]),
	);
	if (release.tag_name !== tag || release.draft !== false || !positiveId(release.id))
		throw new Error("Main workflow completed without the expected public release");
	return { runId: selected.id, commit: options.commit };
}
