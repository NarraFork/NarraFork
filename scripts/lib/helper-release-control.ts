import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
	appendFile,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	getHelperAssetName,
	HELPER_CATALOG_VERSION,
	HELPER_MANIFEST_FILENAME,
	HELPER_PLATFORMS,
	HELPER_RELEASE_TAG,
	HELPER_TOOL_VERSIONS,
	HELPER_TOOLS,
	type HelperPlatform,
	parseExecutorReleaseManifest,
	parseHelperManifest,
} from "../../shared/helper-distribution";
import {
	EXECUTOR_MANIFEST_FILENAME,
	executorPublishedFilename,
} from "../../shared/remote-executor";
import { updateServerChildEnvironment } from "../../shared/update-server-child-env";
import { assertCiMainAncestor, assertReleaseEnvironment, parseCiId } from "./ci-release-plan";
import {
	assertBridgeMode,
	type BridgeIdentity,
	createBridgeGhRunner,
	hasMirrorFailureReceipt,
	restoreUpdateServerBridgeArtifact,
	runBridgeProcess,
	writeBridgeEnvelope,
} from "./ci-update-server-bridge-restore";
import { buildExecutorManifest } from "./executor-manifest";
import { type GhRunner, runGh, validateGitHubRepository } from "./github-release";
import { validateHelperArtifactZip } from "./helper-artifact";
import {
	buildExecutorPlatform,
	executorPlatform,
	prepareHelperPlatform,
	smokeHelperPlatform,
} from "./helper-build";
import {
	EXECUTOR_LICENSE_FILES,
	HELPER_LICENSE_FILES,
	type HelperReleaseKind,
	helperFileIdentity,
	publishHelperRelease,
	resolveHelperTagCommit,
	validateHelperReleaseBundle,
} from "./helper-release";
import {
	resolveUpdateServerBridgeConfig,
	type UpdateServerBridgeConfig,
} from "./update-server-bridge-http";
import {
	type PreparedToolsMirror,
	prepareUpdateServerToolsMirror,
	publishUpdateServerToolsMirror,
	restoreUpdateServerToolsMirror,
} from "./update-server-tools-mirror";

export interface HelperReleasePlan {
	schemaVersion: 1;
	repository: string;
	defaultBranch: string;
	tag: string;
	commit: string;
	controlCommit: string;
	kind: HelperReleaseKind;
	version: string;
	protocolVersion: number;
	sourceRunId: string;
	publish: boolean;
	mirrorOnly?: boolean;
	bridgeRunId?: string;
	bridgeRunAttempt?: string;
}
interface HelperControlOptions {
	run?: GhRunner;
	environment?: NodeJS.ProcessEnv;
	git?: (root: string, args: string[]) => string;
}
async function resolveHelperRepositoryContext(
	repository: string,
	options: HelperControlOptions,
	expectedBranch?: string,
): Promise<string> {
	validateGitHubRepository(repository);
	const environment = options.environment ?? process.env;
	const raw = await (options.run ?? runGh)(["api", `repos/${repository}`]);
	if (Buffer.byteLength(raw) > 1024 * 1024)
		throw new Error("Helper repository response exceeds limit");
	const value = JSON.parse(raw) as { full_name?: string; default_branch?: string };
	const branch = value.default_branch;
	if (
		typeof value.full_name !== "string" ||
		value.full_name.toLowerCase() !== repository.toLowerCase() ||
		typeof branch !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
		branch.includes("..") ||
		(expectedBranch !== undefined && branch !== expectedBranch)
	)
		throw new Error("Helper repository/default branch mismatch");
	if (
		environment.GITHUB_REPOSITORY?.toLowerCase() !== repository.toLowerCase() ||
		environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
		environment.GITHUB_REF !== `refs/heads/${branch}` ||
		!/^[0-9a-f]{40}$/.test(environment.GITHUB_SHA ?? "")
	)
		throw new Error("Require trusted default-branch manual dispatch");
	return branch;
}
export async function assertHelperPublishEnvironment(
	plan: HelperReleasePlan,
	options: HelperControlOptions = {},
): Promise<void> {
	if (plan.publish !== true) throw new Error("Build-only helper plan may not publish");
	const environment = options.environment ?? process.env;
	if (environment.GITHUB_SHA !== plan.controlCommit)
		throw new Error("Helper publisher control commit mismatch");
	await resolveHelperRepositoryContext(plan.repository, options, plan.defaultBranch);
	const run = options.run ?? runGh;
	if (
		(await resolveHelperTagCommit({ repository: plan.repository, run }, plan.tag)) !== plan.commit
	)
		throw new Error("Helper planned tag/source commit changed");
	await assertCiMainAncestor(run, plan.commit, plan.repository, plan.defaultBranch);
	await assertReleaseEnvironment(run, plan.repository, plan.defaultBranch);
}
function git(root: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 65536,
		env: updateServerChildEnvironment(),
	}).trim();
}
export async function planHelperRelease(
	root: string,
	kind: string,
	tag: string,
	sourceRunId = "",
	options: HelperControlOptions & {
		publish?: boolean;
		mirrorOnly?: boolean;
		bridgeRunId?: string;
		bridgeRunAttempt?: string;
	} = {},
): Promise<HelperReleasePlan> {
	const environment = options.environment ?? process.env;
	assertBridgeMode({
		publish: String(options.publish ?? false),
		mirrorOnly: String(options.mirrorOnly ?? false),
		sourceRunId,
		bridgeRunId: options.bridgeRunId,
	});
	if (options.bridgeRunAttempt) parseCiId(options.bridgeRunAttempt);
	const run = options.run ?? runGh;
	const readGit = options.git ?? git;
	const repository = environment.GITHUB_REPOSITORY ?? "";
	validateGitHubRepository(repository);
	if (kind !== "helpers" && kind !== "executor") throw new Error("Unknown helper release kind");
	if (
		kind === "helpers"
			? tag !== HELPER_RELEASE_TAG
			: !/^executor-v\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/.test(tag)
	)
		throw new Error("Invalid helper release tag");
	if (sourceRunId && !/^[1-9]\d{0,19}$/.test(sourceRunId))
		throw new Error("Invalid restore run ID");
	if (options.publish !== undefined && typeof options.publish !== "boolean")
		throw new Error("Invalid helper publish intent");
	const defaultBranch = await resolveHelperRepositoryContext(repository, options);
	if (options.publish === true) await assertReleaseEnvironment(run, repository, defaultBranch);
	const commit = readGit(root, ["rev-parse", `refs/tags/${tag}^{commit}`]);
	const apiCommit = await resolveHelperTagCommit({ repository, run }, tag);
	if (!/^[0-9a-f]{40}$/.test(commit) || commit !== apiCommit)
		throw new Error("Tag commit mismatch");
	readGit(root, ["merge-base", "--is-ancestor", commit, `refs/remotes/origin/${defaultBranch}`]);
	await assertCiMainAncestor(run, commit, repository, defaultBranch);
	const version = kind === "executor" ? tag.slice("executor-v".length) : HELPER_CATALOG_VERSION;
	if (
		kind === "executor" &&
		JSON.parse(readGit(root, ["show", `${commit}:package.json`])).version !== version
	)
		throw new Error("Executor tag must match the source application version");
	const protocol = readGit(root, [
		"show",
		`${commit}:remote-executor/internal/rpc/protocol.go`,
	]).match(/\bProtocolVersion\s*=\s*(\d+)/);
	if (!protocol) throw new Error("Missing executor protocol version");
	return {
		schemaVersion: 1,
		repository,
		defaultBranch,
		tag,
		commit,
		controlCommit: environment.GITHUB_SHA as string,
		kind,
		version,
		protocolVersion: Number(protocol[1]),
		sourceRunId,
		publish: options.publish === true,
		mirrorOnly: options.mirrorOnly === true,
		bridgeRunId: options.bridgeRunId ?? "",
		bridgeRunAttempt: options.bridgeRunAttempt ?? "",
	};
}
export async function writeHelperReleasePlan(path: string, plan: HelperReleasePlan): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true });
	await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`);
	if (process.env.GITHUB_OUTPUT)
		await appendFile(
			process.env.GITHUB_OUTPUT,
			`commit=${plan.commit}\nkind=${plan.kind}\nversion=${plan.version}\nsource-run-id=${plan.sourceRunId}\n`,
		);
}
export async function readHelperReleasePlan(path: string): Promise<HelperReleasePlan> {
	const value = JSON.parse(await readFile(path, "utf8")) as HelperReleasePlan;
	validateGitHubRepository(value.repository);
	if (
		value.schemaVersion !== 1 ||
		typeof value.publish !== "boolean" ||
		!["helpers", "executor"].includes(value.kind) ||
		!/^[0-9a-f]{40}$/.test(value.commit) ||
		!/^[0-9a-f]{40}$/.test(value.controlCommit) ||
		!Number.isSafeInteger(value.protocolVersion) ||
		value.protocolVersion < 1 ||
		(value.kind === "helpers"
			? value.tag !== HELPER_RELEASE_TAG
			: value.tag !== `executor-v${value.version}`)
	)
		throw new Error("Invalid helper release plan");
	if (
		process.env.GITHUB_REPOSITORY &&
		process.env.GITHUB_REPOSITORY.toLowerCase() !== value.repository.toLowerCase()
	)
		throw new Error("Helper plan repository mismatch");
	assertBridgeMode({
		publish: String(value.publish),
		mirrorOnly: String(value.mirrorOnly ?? false),
		sourceRunId: value.sourceRunId,
		bridgeRunId: value.bridgeRunId,
	});
	if (value.bridgeRunAttempt) parseCiId(value.bridgeRunAttempt);
	return value;
}
export async function buildHelperReleasePlatform(
	root: string,
	plan: HelperReleasePlan,
	platform: HelperPlatform,
	cache: string,
	output: string,
): Promise<void> {
	if (!HELPER_PLATFORMS.includes(platform) || git(root, ["rev-parse", "HEAD"]) !== plan.commit)
		throw new Error("Build platform/source mismatch");
	if (plan.kind === "helpers")
		await prepareHelperPlatform(platform, resolve(cache), resolve(output));
	else await buildExecutorPlatform(root, platform, resolve(output), plan.version, plan.commit);
}
async function smokeExecutor(
	plan: HelperReleasePlan,
	platform: HelperPlatform,
	output: string,
): Promise<void> {
	const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
	if (host !== platform) throw new Error("Executor smoke must be native");
	const binary = resolve(
		output,
		executorPublishedFilename(plan.version, executorPlatform(platform)),
	);
	await chmod(binary, 0o755);
	const reported = Bun.spawnSync([binary, "--version"], {
		timeout: 10_000,
		maxBuffer: 65536,
		env: updateServerChildEnvironment(),
	});
	if (
		reported.exitCode !== 0 ||
		!reported.stdout
			.toString()
			.includes(`narrafork-executor ${plan.version} (commit ${plan.commit},`)
	)
		throw new Error("Executor version/commit mismatch");
	const env = Object.fromEntries(
		Object.entries(updateServerChildEnvironment()).filter(
			([name]) => !name.startsWith("NARRAFORK_EXECUTOR_"),
		),
	);
	let proc: ReturnType<typeof Bun.spawn> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let finish: () => void = () => {};
	let reject: (error: Error) => void = () => {};
	const observed = new Promise<void>((yes, no) => {
		finish = yes;
		reject = no;
	});
	const server = Bun.serve<{ smoke: true }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			return server.upgrade(request, { data: { smoke: true } })
				? undefined
				: new Response("Not found", { status: 404 });
		},
		websocket: {
			maxPayloadLength: 65536,
			message(ws, data) {
				try {
					const hello = JSON.parse(String(data));
					if (
						hello.type !== "hello" ||
						hello.protocolVersion !== plan.protocolVersion ||
						hello.agentVersion !== plan.version ||
						hello.platform?.os !== executorPlatform(platform).split("-")[0] ||
						hello.platform?.arch !== executorPlatform(platform).split("-")[1]
					)
						throw new Error("Executor native protocol/platform mismatch");
					finish();
					ws.close();
				} catch (error) {
					reject(error as Error);
					ws.close();
				}
			},
		},
	});
	try {
		proc = Bun.spawn(
			[
				binary,
				"--server",
				`ws://127.0.0.1:${server.port}/smoke`,
				"--device",
				"release-smoke",
				"--token",
				"rdev_local-smoke-only",
				"--cwd",
				resolve(output),
				"--allow-root",
				resolve(output),
				"--disable-shell",
			],
			{ cwd: output, env, stdout: "ignore", stderr: "inherit" },
		);
		timer = setTimeout(() => reject(new Error("Executor native protocol smoke timed out")), 20_000);
		await observed;
	} finally {
		if (timer) clearTimeout(timer);
		if (proc) {
			proc.kill();
			await proc.exited;
		}
		server.stop(true);
	}
}
export async function smokeHelperReleasePlatform(
	plan: HelperReleasePlan,
	platform: HelperPlatform,
	output: string,
): Promise<void> {
	if (plan.kind === "helpers") await smokeHelperPlatform(platform, output);
	else await smokeExecutor(plan, platform, output);
	const names =
		plan.kind === "helpers"
			? HELPER_TOOLS.map((tool) => getHelperAssetName(tool, platform))
			: [executorPublishedFilename(plan.version, executorPlatform(platform))];
	const files = await Promise.all(names.map((name) => helperFileIdentity(join(output, name))));
	for (const name of await readdir(output))
		if (!names.includes(name)) await rm(join(output, name), { force: true });
	await writeFile(
		join(output, "receipt.json"),
		`${JSON.stringify({ schemaVersion: 1, kind: plan.kind, commit: plan.commit, platform, version: plan.version, protocolVersion: plan.protocolVersion, files })}\n`,
	);
}
export async function assembleHelperReleaseBundle(
	root: string,
	plan: HelperReleasePlan,
	nativeDir: string,
	output: string,
): Promise<void> {
	await mkdir(output, { recursive: false });
	const files = [];
	for (const platform of HELPER_PLATFORMS) {
		const dir = join(nativeDir, `helper-native-${platform}`);
		const receipt = JSON.parse(await readFile(join(dir, "receipt.json"), "utf8"));
		if (
			receipt.schemaVersion !== 1 ||
			receipt.kind !== plan.kind ||
			receipt.commit !== plan.commit ||
			receipt.platform !== platform ||
			receipt.version !== plan.version ||
			receipt.protocolVersion !== plan.protocolVersion
		)
			throw new Error("Native receipt identity mismatch");
		const names =
			plan.kind === "helpers"
				? HELPER_TOOLS.map((tool) => getHelperAssetName(tool, platform))
				: [executorPublishedFilename(plan.version, executorPlatform(platform))];
		if (receipt.files?.length !== names.length || (await readdir(dir)).length !== names.length + 1)
			throw new Error("Unexpected native artifact set");
		for (const name of names) {
			const actual = await helperFileIdentity(join(dir, name));
			const recorded = receipt.files.find((entry: { name: string }) => entry.name === name);
			if (!recorded || recorded.size !== actual.size || recorded.sha256 !== actual.sha256)
				throw new Error("Native artifact digest mismatch");
			await copyFile(join(dir, name), join(output, name));
			files.push({ ...actual, platform });
		}
	}
	const licenseNames = plan.kind === "helpers" ? HELPER_LICENSE_FILES : EXECUTOR_LICENSE_FILES;
	const licenses = [];
	for (const name of licenseNames) {
		await copyFile(join(root, "licenses", "extra", name), join(output, name));
		licenses.push(await helperFileIdentity(join(output, name), 64 * 1024));
	}
	const identity = {
		schemaVersion: 1,
		repository: plan.repository,
		tag: plan.tag,
		commit: plan.commit,
		licenses,
	};
	if (plan.kind === "helpers") {
		const manifest = parseHelperManifest(
			{
				...identity,
				catalogVersion: HELPER_CATALOG_VERSION,
				files: files.map((file) => {
					const tool = file.name.startsWith("rg-") ? "rg" : "zstd";
					return { ...file, tool, toolVersion: HELPER_TOOL_VERSIONS[tool] };
				}),
			},
			identity,
		);
		await writeFile(
			join(output, HELPER_MANIFEST_FILENAME),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
	} else {
		const artifacts = await Promise.all(
			files.map(async (file) => ({
				platform: executorPlatform(file.platform),
				bytes: await readFile(join(output, file.name)),
			})),
		);
		const checked = buildExecutorManifest({
			version: plan.version,
			protocolVersion: plan.protocolVersion,
			artifacts,
			releasedAt: "1970-01-01T00:00:00Z",
		});
		const outer = parseExecutorReleaseManifest(
			{ ...identity, manifest: checked },
			{ ...identity, version: plan.version, protocolVersion: plan.protocolVersion },
		);
		await writeFile(
			join(output, EXECUTOR_MANIFEST_FILENAME),
			`${JSON.stringify(outer, null, 2)}\n`,
		);
	}
	await validateHelperReleaseBundle({ ...plan, bundleDir: output });
}
interface HelperSourceRun {
	id: number;
	status: string;
	event: string;
	head_repository: { full_name: string };
	path: string;
	head_branch: string;
	head_sha: string;
	run_attempt: number;
}
export function validateHelperSourceRun(
	plan: HelperReleasePlan,
	value: unknown,
	currentRunId = process.env.GITHUB_RUN_ID,
): HelperSourceRun {
	const run = value as HelperSourceRun;
	if (
		!run ||
		!Number.isSafeInteger(run.id) ||
		run.id !== Number(plan.sourceRunId) ||
		(plan.sourceRunId !== currentRunId && run.status !== "completed") ||
		run.event !== "workflow_dispatch" ||
		run.head_repository?.full_name?.toLowerCase() !== plan.repository.toLowerCase() ||
		run.path !== ".github/workflows/helpers-release.yml" ||
		run.head_branch !== plan.defaultBranch ||
		!/^[0-9a-f]{40}$/.test(run.head_sha) ||
		!Number.isInteger(run.run_attempt) ||
		run.run_attempt < 1 ||
		run.run_attempt > 8
	)
		throw new Error("Untrusted helper source run");
	return run;
}
export function validateHelperSourceJobs(value: unknown, source: HelperSourceRun): void {
	const response = value as {
		total_count: number;
		jobs: { name: string; conclusion: string; run_id: number; head_sha: string }[];
	};
	if (
		!response ||
		!Array.isArray(response.jobs) ||
		!Number.isInteger(response.total_count) ||
		response.total_count !== response.jobs.length ||
		response.total_count > 100
	)
		throw new Error("Invalid helper source jobs");
	const required = [
		"Helper preflight",
		"Assemble exact helper bundle",
		...HELPER_PLATFORMS.flatMap((platform) => [
			`Build (${platform})`,
			`Native smoke (${platform})`,
		]),
	];
	for (const name of required) {
		const matches = response.jobs.filter((job) => job.name === name);
		if (
			matches.length !== 1 ||
			matches[0]?.conclusion !== "success" ||
			matches[0]?.run_id !== source.id ||
			matches[0]?.head_sha !== source.head_sha
		)
			throw new Error(`Missing successful original helper job: ${name}`);
	}
}
export function validateHelperBundleArtifact(
	plan: HelperReleasePlan,
	value: unknown,
): { id: number; size_in_bytes: number; digest: string } {
	const response = value as {
		total_count: number;
		artifacts: {
			id: number;
			name: string;
			expired: boolean;
			size_in_bytes: number;
			digest: string;
			workflow_run: { id: number };
		}[];
	};
	if (
		!response ||
		!Array.isArray(response.artifacts) ||
		response.total_count !== response.artifacts.length ||
		response.total_count > 100
	)
		throw new Error("Invalid helper source artifact listing");
	const assets = response.artifacts.filter(
		(asset) => asset.name === `helper-bundle-${plan.kind}-${plan.commit}`,
	);
	const asset = assets[0];
	if (
		assets.length !== 1 ||
		!asset ||
		!Number.isSafeInteger(asset.id) ||
		asset.id < 1 ||
		asset.expired !== false ||
		asset.workflow_run?.id !== Number(plan.sourceRunId) ||
		!/^sha256:[0-9a-f]{64}$/.test(asset.digest) ||
		!Number.isSafeInteger(asset.size_in_bytes) ||
		asset.size_in_bytes < 1 ||
		asset.size_in_bytes > 512 * 1024 * 1024
	)
		throw new Error("Missing unique immutable helper bundle artifact");
	return asset;
}
export async function restoreHelperReleaseBundle(
	root: string,
	plan: HelperReleasePlan,
	output: string,
	options: HelperControlOptions & { signal?: AbortSignal } = {},
): Promise<{ sourceRunAttempt: number; artifactId: number }> {
	const signal = options.signal;
	const environment = options.environment ?? process.env;
	signal?.throwIfAborted();
	const runner = options.run ?? (signal ? createBridgeGhRunner(signal, environment) : runGh);
	const query: GhRunner = async (args) => {
		signal?.throwIfAborted();
		const result = await runner(args);
		signal?.throwIfAborted();
		return result;
	};
	if (!plan.sourceRunId) throw new Error("Restore requires an original run ID");
	const run = validateHelperSourceRun(
		plan,
		JSON.parse(await query(["api", `repos/${plan.repository}/actions/runs/${plan.sourceRunId}`])),
		environment.GITHUB_RUN_ID,
	);
	(options.git ?? git)(root, [
		"merge-base",
		"--is-ancestor",
		run.head_sha,
		`refs/remotes/origin/${plan.defaultBranch}`,
	]);
	let originalAttemptVerified = false;
	let originalAttempt = 0;
	for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
		const jobs = JSON.parse(
			await query([
				"api",
				`repos/${plan.repository}/actions/runs/${plan.sourceRunId}/attempts/${attempt}/jobs?per_page=100`,
			]),
		);
		try {
			validateHelperSourceJobs(jobs, run);
			originalAttemptVerified = true;
			originalAttempt = attempt;
			break;
		} catch {
			/* A later publisher-only retry must not hide the successful original build. */
		}
	}
	if (!originalAttemptVerified) throw new Error("Missing complete successful original helper jobs");
	const listing = JSON.parse(
		await query([
			"api",
			`repos/${plan.repository}/actions/runs/${plan.sourceRunId}/artifacts?per_page=100`,
		]),
	);
	const artifact = validateHelperBundleArtifact(plan, listing);
	await mkdir(resolve(output, ".."), { recursive: true });
	const temporary = await mkdtemp(join(resolve(output, ".."), ".helper-restore-"));
	const zip = join(temporary, "archive.zip");
	const downloadEnvironment: NodeJS.ProcessEnv = {
		...updateServerChildEnvironment(environment),
		GH_HOST: "github.com",
		GH_PROMPT_DISABLED: "1",
	};
	const proc = Bun.spawn(
		["gh", "api", `repos/${plan.repository}/actions/artifacts/${artifact.id}/zip`],
		{
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: downloadEnvironment,
		},
	);
	const hash = createHash("sha256");
	let size = 0;
	const timer = setTimeout(() => proc.kill(), 5 * 60_000);
	const cancel = () => proc.kill();
	signal?.addEventListener("abort", cancel, { once: true });
	const diagnostic = (async () => {
		let bytes = 0;
		for await (const chunk of proc.stderr) {
			bytes += chunk.length;
			if (bytes > 64 * 1024) {
				proc.kill();
				throw new Error("Helper artifact diagnostics exceed limit");
			}
		}
	})();
	const transfer = pipeline(
		proc.stdout,
		new Transform({
			transform(chunk, _encoding, callback) {
				size += chunk.length;
				hash.update(chunk);
				callback(
					size > artifact.size_in_bytes || size > 512 * 1024 * 1024
						? new Error("Artifact exceeds size limit")
						: null,
					chunk,
				);
			},
		}),
		createWriteStream(zip, { flags: "wx" }),
		{ signal },
	);
	let ownsOutput = false;
	try {
		await Promise.all([transfer, diagnostic]);
		if (
			(await proc.exited) !== 0 ||
			size !== artifact.size_in_bytes ||
			`sha256:${hash.digest("hex")}` !== artifact.digest
		)
			throw new Error("Immutable helper artifact digest mismatch");
		await validateHelperArtifactZip(zip);
		signal?.throwIfAborted();
		await mkdir(output, { recursive: false });
		ownsOutput = true;
		await runBridgeProcess("unzip", ["-q", zip, "-d", output], {
			signal,
			environment,
			timeoutMs: 30_000,
			maximumOutputBytes: 64 * 1024,
		});
		await validateHelperReleaseBundle({ ...plan, bundleDir: output });
		signal?.throwIfAborted();
		return { sourceRunAttempt: originalAttempt, artifactId: artifact.id };
	} catch (error) {
		if (ownsOutput) await rm(output, { recursive: true, force: true });
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
		if (proc.exitCode === null) proc.kill();
		await Promise.allSettled([transfer, diagnostic, proc.exited]);
		await rm(temporary, { recursive: true, force: true });
	}
}
export interface HelperBridgeOptions extends HelperControlOptions {
	bridgeDir?: string;
	sourceRunAttempt?: string;
	artifactId?: string;
	artifactDigest?: string;
	signal?: AbortSignal;
	/** Fixture transport seams; provenance and byte checks are never bypassed. */
	fetchImpl?: typeof fetch;
	artifactFetch?: typeof fetch;
}
async function helperBridgeIdentity(
	plan: HelperReleasePlan,
	output: string,
	serverUrl: string,
	options: HelperBridgeOptions,
): Promise<BridgeIdentity> {
	const env = options.environment ?? process.env;
	const manifestName =
		plan.kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME;
	return {
		kind: plan.kind,
		repository: plan.repository,
		defaultBranch: plan.defaultBranch,
		tag: plan.tag,
		version: plan.version,
		commit: plan.commit,
		sourceRunId: parseCiId(plan.sourceRunId || env.GITHUB_RUN_ID),
		sourceRunAttempt: parseCiId(options.sourceRunAttempt),
		serverUrl,
		manifestSha256: (await helperFileIdentity(join(output, manifestName), 64 * 1024)).sha256,
	};
}
async function bridgeOutput(values: Record<string, string>, options: HelperControlOptions) {
	const env = options.environment ?? process.env;
	if (env.GITHUB_OUTPUT)
		for (const [key, value] of Object.entries(values)) {
			if (!/^[a-z-]+$/.test(key) || /[\r\n]/.test(value))
				throw new Error("Invalid helper Actions output");
			await appendFile(env.GITHUB_OUTPUT, `${key}=${value}\n`);
		}
}
async function bridgeSummary(message: string, options: HelperControlOptions) {
	console.log(message);
	const env = options.environment ?? process.env;
	if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${message}\n`);
}
export async function prepareHelperReleaseBridge(
	plan: HelperReleasePlan,
	output: string,
	options: HelperBridgeOptions = {},
) {
	const config = resolveUpdateServerBridgeConfig(options.environment ?? process.env);
	await assertHelperPublishEnvironment(plan, options);
	if (plan.mirrorOnly)
		throw new Error("Mirror-only must restore the original bridge, not prepare again");
	await validateHelperReleaseBundle({ ...plan, bundleDir: output });
	await bridgeOutput(
		{ "mirror-required": String(!!config), "publication-status": "BUILD_COMPLETE" },
		options,
	);
	if (!config) {
		await bridgeSummary(
			"BUILD_COMPLETE: GitHub-only helper publication; no legacy server requests.",
			options,
		);
		return;
	}
	if (!options.bridgeDir) throw new Error("Missing immutable helper bridge directory");
	const identity = await helperBridgeIdentity(plan, output, config.serverUrl, options);
	const prepared = await prepareUpdateServerToolsMirror({
		kind: plan.kind,
		bundleDir: output,
		repo: plan.repository,
		version: plan.version,
		commit: plan.commit,
		protocolVersion: plan.protocolVersion,
		config,
		bridgeDir: options.bridgeDir,
		sourceRunId: String(identity.sourceRunId),
		sourceRunAttempt: String(identity.sourceRunAttempt),
		signal: options.signal,
		fetchImpl: options.fetchImpl,
	});
	await writeBridgeEnvelope(options.bridgeDir, identity, prepared.sealSha256, options.environment);
	await bridgeSummary(
		`BUILD_COMPLETE: immutable ${plan.kind} bridge ready; artifact upload must succeed before GitHub writes.`,
		options,
	);
}
export async function publishHelperReleasePlan(
	plan: HelperReleasePlan,
	output: string,
	dryRun = true,
	options: HelperBridgeOptions = {},
): Promise<void> {
	// Offline preview is deliberately independent of all update-server configuration.
	const config = dryRun
		? undefined
		: resolveUpdateServerBridgeConfig(options.environment ?? process.env);
	let acceptedMirror:
		| {
				prepared: PreparedToolsMirror;
				identity: BridgeIdentity;
				bridgeRunId: number;
				bridgeRunAttempt: number;
		  }
		| undefined;
	const guard = async () => {
		options.signal?.throwIfAborted();
		await assertHelperPublishEnvironment(plan, options);
		options.signal?.throwIfAborted();
	};
	if (!dryRun) {
		if (plan.mirrorOnly) throw new Error("Mirror-only may not mutate GitHub releases");
		await guard();
		if (config) {
			if (!options.bridgeDir || !options.artifactId || !options.artifactDigest)
				throw new Error("Publication requires a successfully uploaded immutable bridge artifact");
			const identity = await helperBridgeIdentity(plan, output, config.serverUrl, options);
			const restored = await restoreUpdateServerBridgeArtifact({
				identity,
				bridgeRunId: parseCiId((options.environment ?? process.env).GITHUB_RUN_ID),
				destination: options.bridgeDir,
				uploadedArtifactId: options.artifactId,
				uploadedArtifactDigest: options.artifactDigest,
				run: options.run,
				env: options.environment,
				signal: options.signal,
				fetch: options.artifactFetch,
			});
			const prepared = await restoreUpdateServerToolsMirror({
				kind: plan.kind,
				bundleDir: output,
				repo: plan.repository,
				version: plan.version,
				commit: plan.commit,
				protocolVersion: plan.protocolVersion,
				config,
				bridgeDir: options.bridgeDir,
				trustedSealSha256: restored.envelope.sealSha256,
				signal: options.signal,
				fetchImpl: options.fetchImpl,
			});
			if (prepared.sealSha256 !== restored.envelope.sealSha256)
				throw new Error("Helper bridge seal mismatch");
			acceptedMirror = {
				prepared,
				identity,
				bridgeRunId: restored.envelope.bridgeRunId,
				bridgeRunAttempt: restored.envelope.bridgeRunAttempt,
			};
		}
	}
	await publishHelperRelease({
		...plan,
		bundleDir: output,
		dryRun,
		run: options.run,
		signal: options.signal,
		beforeWrite: dryRun ? undefined : guard,
	});
	if (!dryRun)
		await bridgeOutput(
			{ "publication-status": "PUBLISHED", "mirror-required": String(!!config) },
			options,
		);
	if (acceptedMirror && config) {
		await verifyPublicHelperRelease(plan, output, options);
		await publishPreparedHelperMirror(plan, acceptedMirror, config, options);
	}
}
/** Public asset inspection only. Never calls the draft/upload/publication helper. */
export async function verifyPublicHelperRelease(
	plan: HelperReleasePlan,
	output: string,
	options: HelperControlOptions = {},
) {
	const description = await validateHelperReleaseBundle({ ...plan, bundleDir: output });
	const raw = await (options.run ?? runGh)([
		"api",
		`repos/${plan.repository}/releases/tags/${plan.tag}`,
	]);
	if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Public helper release exceeds limit");
	const release = JSON.parse(raw) as {
		tag_name?: string;
		draft?: boolean;
		prerelease?: boolean;
		assets?: { name: string; size: number; digest: string; state: string }[];
	};
	if (
		release.tag_name !== plan.tag ||
		release.draft !== false ||
		release.prerelease !== false ||
		!Array.isArray(release.assets)
	)
		throw new Error("Mirror requires an already-public helper release");
	// validateHelperReleaseBundle already includes the outer manifest in files.
	const files = description.files;
	if (release.assets.length !== files.length) throw new Error("Public helper asset set mismatch");
	for (const file of files) {
		const matches = release.assets.filter((asset) => asset.name === file.name);
		if (
			matches.length !== 1 ||
			matches[0]?.size !== file.size ||
			matches[0]?.digest !== `sha256:${file.sha256}` ||
			matches[0]?.state !== "uploaded"
		)
			throw new Error("Public helper asset identity mismatch");
	}
}
export async function mirrorHelperReleasePlan(
	plan: HelperReleasePlan,
	output: string,
	options: HelperBridgeOptions = {},
) {
	const env = options.environment ?? process.env;
	const config = resolveUpdateServerBridgeConfig(env);
	if (!config || !options.bridgeDir)
		throw new Error("Mirror requires explicit server configuration and original bridge artifact");
	await assertHelperPublishEnvironment(plan, options);
	const identity = await helperBridgeIdentity(plan, output, config.serverUrl, options);
	const bridgeRunId = plan.mirrorOnly ? parseCiId(plan.bridgeRunId) : parseCiId(env.GITHUB_RUN_ID);
	const restored = await restoreUpdateServerBridgeArtifact({
		identity,
		bridgeRunId,
		bridgeRunAttempt: plan.bridgeRunAttempt ? parseCiId(plan.bridgeRunAttempt) : undefined,
		destination: options.bridgeDir,
		run: options.run,
		env,
		signal: options.signal,
		fetch: options.artifactFetch,
	});
	const prepared = await restoreUpdateServerToolsMirror({
		kind: plan.kind,
		bundleDir: output,
		repo: plan.repository,
		version: plan.version,
		commit: plan.commit,
		protocolVersion: plan.protocolVersion,
		config,
		bridgeDir: options.bridgeDir,
		trustedSealSha256: restored.envelope.sealSha256,
		signal: options.signal,
		fetchImpl: options.fetchImpl,
	});
	if (prepared.sealSha256 !== restored.envelope.sealSha256)
		throw new Error("Helper mirror seal mismatch");
	await verifyPublicHelperRelease(plan, output, options);
	await publishPreparedHelperMirror(
		plan,
		{ prepared, identity, bridgeRunId, bridgeRunAttempt: restored.envelope.bridgeRunAttempt },
		config,
		options,
	);
}
async function publishPreparedHelperMirror(
	plan: HelperReleasePlan,
	accepted: {
		prepared: PreparedToolsMirror;
		identity: BridgeIdentity;
		bridgeRunId: number;
		bridgeRunAttempt: number;
	},
	config: UpdateServerBridgeConfig,
	options: HelperBridgeOptions,
) {
	const { prepared, identity, bridgeRunId, bridgeRunAttempt } = accepted;
	try {
		await publishUpdateServerToolsMirror(prepared, config, {
			signal: options.signal,
			fetchImpl: options.fetchImpl,
		});
		await bridgeOutput(
			{ "mirror-required": "true", "mirror-status": "MIRRORED", "publication-status": "MIRRORED" },
			options,
		);
		await bridgeSummary(
			`MIRRORED: ${plan.tag}; original bytes verified. Legacy tools API has no CAS; external private publishers can still race workflow serialization.`,
			options,
		);
	} catch (error) {
		await bridgeOutput({ "mirror-status": "PUBLISHED_NOT_MIRRORED" }, options);
		const partialReceipt = await hasMirrorFailureReceipt(
			prepared.receiptPath,
			"PUBLISHED_NOT_MIRRORED",
		);
		await bridgeSummary(
			`PUBLISHED_NOT_MIRRORED: ${plan.tag}. Retry publish=true mirror_only=true source_run_id=${identity.sourceRunId} bridge_run_id=${bridgeRunId} bridge_run_attempt=${bridgeRunAttempt}; original bundle and sealed bridge retained; partial receipt ${partialReceipt ? "retained" : "unavailable"}. Retry will not rebuild or write GitHub.`,
			options,
		);
		throw error;
	}
}
export function assertHelperReleaseGate(env: NodeJS.ProcessEnv) {
	if (
		env.SOURCE_RUN_ID === undefined ||
		(env.SOURCE_RUN_ID !== "" && !/^[1-9]\d*$/.test(env.SOURCE_RUN_ID))
	)
		throw new Error("Invalid helper source run mode");
	if (env.MIRROR_ONLY !== undefined && !["true", "false"].includes(env.MIRROR_ONLY))
		throw new Error("Invalid helper mirror-only mode");
	if (env.MIRROR_REQUIRED !== undefined && !["", "true", "false"].includes(env.MIRROR_REQUIRED))
		throw new Error("Invalid helper mirror requirement");
	if (env.PREFLIGHT_RESULT !== "success") throw new Error("Helper preflight failed");
	const restore = env.SOURCE_RUN_ID !== "";
	for (const key of ["BUILD_RESULT", "SMOKE_RESULT", "ASSEMBLE_RESULT"])
		if (env[key] !== (restore ? "skipped" : "success")) throw new Error(`Unexpected helper ${key}`);
	if (env.RESTORE_RESULT !== (restore ? "success" : "skipped"))
		throw new Error("Helper restore failed");
	if (
		!["true", "false"].includes(env.PUBLISH_REQUESTED ?? "") ||
		env.PUBLISH_RESULT !== (env.PUBLISH_REQUESTED === "true" ? "success" : "skipped")
	)
		throw new Error("Helper publisher did not succeed");
	if (env.MIRROR_REQUIRED === "true" && env.MIRROR_STATUS !== "MIRRORED")
		throw new Error("Configured helper mirror failed");
	if (
		env.MIRROR_ONLY === "true" &&
		(!restore ||
			env.PUBLISH_REQUESTED !== "true" ||
			env.MIRROR_REQUIRED !== "true" ||
			env.MIRROR_STATUS !== "MIRRORED")
	)
		throw new Error("Mirror-only helper receipt missing");
}
