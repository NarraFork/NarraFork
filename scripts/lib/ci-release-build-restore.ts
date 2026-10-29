import { lstat, mkdir, mkdtemp, realpath, rm, statfs } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { validateSmokeMetadata } from "../smoke-release-binary";
import { runPublicationProcess as runBridgeProcess } from "./ci-publication-runtime";
import {
	CI_DISK_RESERVE,
	CI_METADATA_LIMIT,
	CI_TEXT_LIMIT,
	hashReleaseFile,
	readReleaseText,
} from "./ci-release-io";
import {
	assertCiMainAncestor,
	type CiReleaseComponentChecks,
	ciApi,
	ciApiList,
	ciGhRunner,
	parseCiId,
	resolveCiDispatch,
	revalidateCiReleasePlan,
	validateCiReleasePlan,
	validateCiReleaseTag,
} from "./ci-release-plan";
import {
	CI_RELEASE_REPOSITORY,
	CI_RELEASE_TARGETS,
	CI_RELEASE_WORKFLOW,
	type CiReleaseArtifactIdentity,
	type CiReleaseBuildSource,
	type CiReleasePlan,
	type CiReleaseTarget,
} from "./ci-release-types";
import type { GhRunner } from "./github-release";
import { restoreRemotePeerReleasePlan } from "./remote-peer-release-prepare";

const TIMEOUT = 15 * 60_000;
const CONTROL_LIMIT = 4 * 1024 ** 2;
const BINARY_LIMIT = 1024 ** 3;
const PLATFORM_LIMIT = BINARY_LIMIT + 2 * 1024 ** 2;
const UPLOAD_ACTION = "Run actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repositorySchema = z.object({ id, full_name: z.string() });
const sourceSchema = z.object({
	id,
	run_attempt: id,
	workflow_id: id,
	path: z.literal(CI_RELEASE_WORKFLOW),
	event: z.literal("workflow_dispatch"),
	head_branch: z.string(),
	head_sha: sha,
	status: z.literal("completed"),
	repository: repositorySchema,
	head_repository: repositorySchema,
});
const artifactSchema = z.object({
	id,
	name: z.string(),
	expired: z.literal(false),
	size_in_bytes: id.max(PLATFORM_LIMIT),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	workflow_run: z.object({
		id,
		repository_id: id,
		head_repository_id: id,
		head_branch: z.string(),
		head_sha: sha,
	}),
});
const jobSchema = z.object({
	id,
	run_id: id,
	run_attempt: id,
	head_sha: sha,
	name: z.string(),
	status: z.string(),
	conclusion: z.string().nullable(),
	steps: z
		.array(
			z.object({
				name: z.string(),
				status: z.string(),
				conclusion: z.string().nullable(),
			}),
		)
		.optional(),
});

export const REQUIRED_RELEASE_BUILD_SOURCE_CHECKS = [
	"Verify release source / Static checks",
	"Verify release source / Build and typecheck",
	...Array.from({ length: 4 }, (_, index) => `Verify release source / Tests (${index + 1}/4)`),
	"Verify release source / CI Gate",
] as const;

interface BuildOptions {
	root: string;
	env?: NodeJS.ProcessEnv;
	run?: GhRunner;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}
export interface PrepareCiReleaseBuildOptions extends BuildOptions {
	sourceRunId: string | number;
	sourceRunAttempt: string | number;
	tag: string;
	target?: string;
	publish: boolean;
	/** Fixture injection only, forwarded to online control-plan prechecks. */
	componentChecks?: CiReleaseComponentChecks;
}

function targetSet(target?: string): CiReleaseTarget[] {
	if (target === undefined || target === "all")
		return CI_RELEASE_TARGETS.map((item) => item.target);
	const match = CI_RELEASE_TARGETS.find((item) => item.target === target);
	if (!match) throw new Error("Invalid original build target");
	return [match.target];
}

function boundedOptions(
	options: BuildOptions,
): Required<Omit<BuildOptions, "root">> & { root: string } {
	const env = options.env ?? process.env;
	const signal = AbortSignal.any([
		AbortSignal.timeout(TIMEOUT),
		...(options.signal ? [options.signal] : []),
	]);
	signal.throwIfAborted();
	const runner = options.run ?? ciGhRunner(env);
	const run: GhRunner = async (args) => {
		signal.throwIfAborted();
		const output = await runner(args);
		signal.throwIfAborted();
		return output;
	};
	return { ...options, env, signal, run, fetch: options.fetch ?? fetch };
}

function identity(artifact: z.infer<typeof artifactSchema>): CiReleaseArtifactIdentity {
	return { id: artifact.id, digest: artifact.digest, size: artifact.size_in_bytes };
}
function sameIdentity(left: CiReleaseArtifactIdentity, right: CiReleaseArtifactIdentity): boolean {
	return left.id === right.id && left.digest === right.digest && left.size === right.size;
}

/** Validate all entries, including ignored control.js, before extracting only the allowlist. */
const EXTRACT = `
import json, os, resource, shutil, stat, sys, zipfile
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 ** 2, 512 * 1024 ** 2))
resource.setrlimit(resource.RLIMIT_CPU, (900, 900))
archive, destination, mode, binary = sys.argv[1:]
control = mode == 'control'
allowed = {'plan.json', 'control.js'} if control else {binary, binary + '.metadata.json'}
required = {'plan.json'} if control else allowed
maximum = 4 * 1024 ** 2 if control else 1024 ** 3 + 65536
with zipfile.ZipFile(archive) as bundle:
    entries = bundle.infolist()
    if len(entries) < 1 or len(entries) > 2: raise ValueError('archive entry limit')
    seen, total = set(), 0
    for entry in entries:
        name = entry.filename
        if name not in allowed or name in seen or entry.orig_filename != name:
            raise ValueError('unsafe or duplicate archive path')
        seen.add(name)
        kind = stat.S_IFMT(entry.external_attr >> 16)
        if entry.flag_bits & 1 or entry.is_dir() or kind not in (0, stat.S_IFREG):
            raise ValueError('nonregular or encrypted archive entry')
        limit = (1024 * 1024 if name == 'plan.json' else 3 * 1024 ** 2) if control else (65536 if name.endswith('.metadata.json') else 1024 ** 3)
        if entry.file_size < 1 or entry.file_size > limit:
            raise ValueError('archive entry size limit')
        total += entry.file_size
        if total > maximum: raise ValueError('archive inflated size limit')
    if not required.issubset(seen): raise ValueError('missing archive inputs')
    if shutil.disk_usage(destination).free < total + 4 * 1024 ** 3:
        raise ValueError('insufficient disk space')
    written = 0
    for entry in entries:
        count = 0
        # Read ignored code to validate CRC/inflation, but never write or execute it.
        target = None if control and entry.filename == 'control.js' else open(os.path.join(destination, entry.filename), 'xb')
        try:
            with bundle.open(entry) as source:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk: break
                    count += len(chunk)
                    written += len(chunk)
                    if count > entry.file_size or written > maximum:
                        raise ValueError('archive inflated beyond limits')
                    if target is not None: target.write(chunk)
            if count != entry.file_size: raise ValueError('archive size mismatch')
        finally:
            if target is not None: target.close()
`;

async function extract(
	archive: string,
	destination: string,
	mode: "control" | "platform",
	binary: string,
	options: ReturnType<typeof boundedOptions>,
) {
	await mkdir(destination);
	await runBridgeProcess("python3", ["-I", "-c", EXTRACT, archive, destination, mode, binary], {
		timeoutMs: TIMEOUT,
		maximumOutputBytes: CI_TEXT_LIMIT,
		signal: options.signal,
		environment: options.env,
	});
}

/** Linux/Ubuntu control path only: never fall back to a replace-capable rename. */
const ATOMIC_INSTALL = `
import ctypes, os, resource, stat, sys
resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 ** 2, 128 * 1024 ** 2))
resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
source_parent, source_name, destination_parent, destination_name = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
source_fd, destination_fd = os.open(source_parent, flags), os.open(destination_parent, flags)
try:
    if os.path.realpath('/proc/self/fd/' + str(source_fd)) != source_parent or os.path.realpath('/proc/self/fd/' + str(destination_fd)) != destination_parent:
        raise ValueError('atomic install parent identity changed')
    if not stat.S_ISDIR(os.stat(source_name, dir_fd=source_fd, follow_symlinks=False).st_mode):
        raise ValueError('atomic install source must be a real directory')
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(source_fd, os.fsencode(source_name), destination_fd, os.fsencode(destination_name), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
finally:
    os.close(source_fd)
    os.close(destination_fd)
`;

/** Test seam for the no-replace commit primitive; no owned data is deleted on failure. */
export async function atomicInstallCiReleaseBuild(
	source: string,
	destination: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const sourcePath = await trustedDirectory(source);
	const destinationPath = resolve(destination);
	const parent = await trustedDirectory(dirname(destinationPath));
	// The cancellation boundary is before this short atomic commit. Once committing,
	// wait for close rather than report a false failure after an irreversible rename.
	await runBridgeProcess(
		"python3",
		[
			"-I",
			"-c",
			ATOMIC_INSTALL,
			dirname(sourcePath),
			basename(sourcePath),
			parent,
			basename(destinationPath),
		],
		{ timeoutMs: 30_000, maximumOutputBytes: CI_TEXT_LIMIT, environment: env },
	);
}

async function trustedDirectory(path: string): Promise<string> {
	const absolute = resolve(path);
	if ((await realpath(absolute)) !== absolute || !(await lstat(absolute)).isDirectory()) {
		throw new Error("Restore parent/root must be a real directory without symlinks");
	}
	return absolute;
}
async function absentDestination(destination: string): Promise<string> {
	const parent = await trustedDirectory(dirname(destination));
	try {
		await lstat(destination);
		throw new Error("Build destination already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return parent;
}
async function checkSpace(parent: string, size: number) {
	const disk = await statfs(parent);
	if (disk.bavail * disk.bsize < size + CI_DISK_RESERVE)
		throw new Error("Insufficient restore disk space");
}

async function readSource(
	sourceRunId: number,
	sourceRunAttempt: number,
	targets: CiReleaseTarget[],
	options: ReturnType<typeof boundedOptions>,
) {
	const { run, env } = options;
	const dispatch = await resolveCiDispatch(run, env);
	const { repository, defaultBranch } = dispatch;
	if (sourceRunId === dispatch.runId)
		throw new Error("Original build must come from a different run");
	const source = sourceSchema.parse(
		await ciApi(run, `actions/runs/${sourceRunId}/attempts/${sourceRunAttempt}`, repository),
	);
	if (
		source.id !== sourceRunId ||
		source.run_attempt !== sourceRunAttempt ||
		source.repository.full_name !== repository ||
		source.head_repository.full_name !== repository ||
		source.repository.id !== source.head_repository.id ||
		source.head_branch !== defaultBranch
	)
		throw new Error("Untrusted original build run/attempt provenance");
	const workflow = z
		.object({ id, path: z.literal(CI_RELEASE_WORKFLOW), state: z.literal("active") })
		.parse(await ciApi(run, `actions/workflows/${source.workflow_id}`, repository));
	if (workflow.id !== source.workflow_id) throw new Error("Original workflow ID mismatch");
	await assertCiMainAncestor(run, source.head_sha, repository, defaultBranch);
	await assertCiMainAncestor(run, dispatch.workflowCommit, repository, defaultBranch);
	const jobs = z
		.array(jobSchema)
		.parse(
			await ciApiList(
				run,
				`actions/runs/${sourceRunId}/attempts/${sourceRunAttempt}/jobs`,
				"jobs",
				repository,
			),
		);
	const jobIds = new Set<number>();
	for (const job of jobs) {
		if (
			job.run_id !== sourceRunId ||
			job.run_attempt !== sourceRunAttempt ||
			job.head_sha !== source.head_sha ||
			jobIds.has(job.id)
		) {
			throw new Error("Original job provenance mismatch or duplicate job ID");
		}
		jobIds.add(job.id);
	}
	for (const name of [
		"Release preflight",
		...REQUIRED_RELEASE_BUILD_SOURCE_CHECKS,
		...targets.map((target) => `Build (${target})`),
	]) {
		const matches = jobs.filter((job) => job.name === name);
		if (
			matches.length !== 1 ||
			matches[0].status !== "completed" ||
			matches[0].conclusion !== "success"
		) {
			throw new Error(`Original source job missing, duplicate or unsuccessful: ${name}`);
		}
		if (name === "Release preflight" || name.startsWith("Build (")) {
			const uploadName =
				name === "Release preflight" ? "Upload release control" : "Upload release platform";
			const uploads =
				matches[0].steps?.filter(
					(step) =>
						step.name.startsWith("Run actions/upload-artifact@") || step.name === uploadName,
				) ?? [];
			if (
				uploads.length !== 1 ||
				![UPLOAD_ACTION, uploadName].includes(uploads[0].name) ||
				uploads[0].status !== "completed" ||
				uploads[0].conclusion !== "success"
			) {
				throw new Error(`Original artifact upload unsuccessful or ambiguous: ${name}`);
			}
		}
	}
	const artifacts = await ciApiList(
		run,
		`actions/runs/${sourceRunId}/artifacts`,
		"artifacts",
		repository,
	);
	const artifactIds = new Set<number>();
	for (const item of artifacts) {
		const artifactId = z.object({ id }).parse(item).id;
		if (artifactIds.has(artifactId)) throw new Error("Duplicate original artifact ID");
		artifactIds.add(artifactId);
	}
	async function getArtifact(name: string, maximum: number) {
		const matches = artifacts.filter(
			(item) => typeof item === "object" && item !== null && "name" in item && item.name === name,
		);
		if (matches.length !== 1)
			throw new Error(`Exact original artifact missing or duplicated: ${name}`);
		const listed = artifactSchema.parse(matches[0]);
		const artifact = artifactSchema.parse(
			await ciApi(run, `actions/artifacts/${listed.id}`, repository),
		);
		for (const candidate of [listed, artifact]) {
			if (
				candidate.name !== name ||
				candidate.size_in_bytes > maximum ||
				candidate.workflow_run.id !== sourceRunId ||
				candidate.workflow_run.repository_id !== source.repository.id ||
				candidate.workflow_run.head_repository_id !== source.repository.id ||
				candidate.workflow_run.head_sha !== source.head_sha ||
				candidate.workflow_run.head_branch !== defaultBranch
			) {
				throw new Error("Original artifact provenance/size mismatch");
			}
		}
		if (!sameIdentity(identity(listed), identity(artifact)))
			throw new Error("Original artifact identity changed");
		return artifact;
	}
	const control = await getArtifact(
		`release-control-${sourceRunId}-${sourceRunAttempt}`,
		CONTROL_LIMIT,
	);
	const platforms = [];
	for (const target of targets) {
		platforms.push({
			target,
			artifact: await getArtifact(
				`release-platform-${target}-${sourceRunId}-${sourceRunAttempt}`,
				PLATFORM_LIMIT,
			),
		});
	}
	const root = await trustedDirectory(options.root);
	await checkSpace(root, control.size_in_bytes);
	const temporary = await mkdtemp(join(root, ".ci-build-control-"));
	let original: CiReleasePlan;
	try {
		const archive = join(temporary, "control.zip");
		const extracted = join(temporary, "extracted");
		const { downloadArchive } = await import("./ci-release-restore");
		await downloadArchive(control, repository, archive, env, options.fetch, options.signal);
		await extract(archive, extracted, "control", "", options);
		original = validateCiReleasePlan(
			JSON.parse(await readReleaseText(join(extracted, "plan.json"))),
		);
		if (
			original.buildSource ||
			original.runId !== sourceRunId ||
			original.runAttempt !== sourceRunAttempt ||
			original.workflowCommit !== source.head_sha ||
			original.repository !== repository ||
			(original.defaultBranch ?? "main") !== defaultBranch
		) {
			throw new Error("Original control plan provenance mismatch or build source chain");
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	return { dispatch, source, original, control, platforms };
}

export async function prepareCiReleaseBuild(
	options: PrepareCiReleaseBuildOptions,
): Promise<CiReleasePlan> {
	validateCiReleaseTag(options.tag);
	const bounded = boundedOptions(options);
	const result = await readSource(
		parseCiId(options.sourceRunId),
		parseCiId(options.sourceRunAttempt),
		targetSet(options.target),
		bounded,
	);
	if (result.original.tag !== options.tag) throw new Error("Original build tag mismatch");
	const verified = await revalidateCiReleasePlan(result.original, {
		...bounded,
		publish: options.publish,
		componentChecks: options.componentChecks,
		componentRun: options.run,
	});
	const buildSource: CiReleaseBuildSource = {
		runId: result.source.id,
		runAttempt: result.source.run_attempt,
		workflowCommit: result.source.head_sha,
		controlArtifact: identity(result.control),
		platforms: result.platforms.map(({ target, artifact }) => ({
			target,
			artifact: identity(artifact),
		})),
	};
	bounded.signal.throwIfAborted();
	return validateCiReleasePlan({
		...verified,
		...result.dispatch,
		buildSource,
		...(verified.remotePeer
			? { remotePeer: restoreRemotePeerReleasePlan(verified.remotePeer, result.original) }
			: {}),
	});
}

function productIdentity(plan: CiReleasePlan) {
	return {
		schemaVersion: plan.schemaVersion,
		repository: plan.repository,
		defaultBranch: plan.defaultBranch ?? "main",
		tag: plan.tag,
		version: plan.version,
		commit: plan.commit,
		bunVersion: plan.bunVersion,
		channel: plan.channel,
		changelog: plan.changelog,
		baselines: plan.baselines,
	};
}
async function verifiedSource(
	planValue: CiReleasePlan,
	options: ReturnType<typeof boundedOptions>,
) {
	const plan = validateCiReleasePlan(planValue);
	const source = plan.buildSource;
	if (!source || source.runId === plan.runId)
		throw new Error("Missing original build source or recursive run");
	const targets = source.platforms.map((item) => item.target);
	if (
		![1, CI_RELEASE_TARGETS.length].includes(targets.length) ||
		new Set(targets).size !== targets.length ||
		targets.some((target) => !CI_RELEASE_TARGETS.some((item) => item.target === target))
	) {
		throw new Error("Invalid original build platform set");
	}
	const result = await readSource(source.runId, source.runAttempt, targets, options);
	if (
		source.workflowCommit !== result.source.head_sha ||
		!sameIdentity(source.controlArtifact, identity(result.control))
	) {
		throw new Error("Frozen original build/control identity mismatch");
	}
	for (const platform of result.platforms) {
		const frozen = source.platforms.find((item) => item.target === platform.target);
		if (!frozen || !sameIdentity(frozen.artifact, identity(platform.artifact)))
			throw new Error("Frozen original platform identity mismatch");
	}
	if (JSON.stringify(productIdentity(plan)) !== JSON.stringify(productIdentity(result.original))) {
		throw new Error("Original product identity/changelog/baselines changed");
	}
	await revalidateCiReleasePlan(plan, { ...options, publish: false });
	options.signal.throwIfAborted();
	return result;
}

export async function validateCiReleaseBuildSource(
	plan: CiReleasePlan,
	options: BuildOptions,
): Promise<void> {
	await verifiedSource(plan, boundedOptions(options));
}

export async function restoreCiReleaseBuildPlatform(
	options: BuildOptions & { plan: CiReleasePlan; target: string; destination: string },
): Promise<void> {
	const bounded = boundedOptions(options);
	const plan = validateCiReleasePlan(options.plan);
	const destination = resolve(options.destination);
	const parent = await absentDestination(destination);
	await trustedDirectory(options.root);
	const targets = targetSet(options.target);
	if (targets.length !== 1) throw new Error("Platform restore requires one target");
	const source = await verifiedSource(plan, bounded);
	if (
		source.dispatch.runId !== plan.runId ||
		source.dispatch.runAttempt !== plan.runAttempt ||
		source.dispatch.workflowCommit !== plan.workflowCommit
	) {
		throw new Error("Platform restore must use its own re-verification run/control identity");
	}
	const platform = source.platforms.find((item) => item.target === options.target);
	const target = CI_RELEASE_TARGETS.find((item) => item.target === options.target);
	if (!platform || !target) throw new Error("Target absent from frozen original build");
	await checkSpace(parent, platform.artifact.size_in_bytes);
	const temporary = await mkdtemp(join(parent, `.${basename(destination)}-build-restore-`));
	try {
		const archive = join(temporary, "platform.zip");
		const extracted = join(temporary, "extracted");
		const binary = `narrafork-${plan.version}-${target.suffix}`;
		const { downloadArchive } = await import("./ci-release-restore");
		await downloadArchive(
			platform.artifact,
			plan.repository,
			archive,
			bounded.env,
			bounded.fetch,
			bounded.signal,
		);
		await extract(archive, extracted, "platform", binary, bounded);
		const hash = await hashReleaseFile(join(extracted, binary), BINARY_LIMIT, bounded.signal);
		const metadata = JSON.parse(
			await readReleaseText(join(extracted, `${binary}.metadata.json`), CI_METADATA_LIMIT),
		);
		const legacy =
			source.original.repository === CI_RELEASE_REPOSITORY &&
			source.original.defaultBranch === undefined &&
			metadata.repository === undefined;
		if (metadata.repository === undefined && !legacy) {
			throw new Error("Binary metadata requires explicit repository identity");
		}
		validateSmokeMetadata(
			metadata,
			{
				target: target.target,
				binary: join(extracted, binary),
				metadata: join(extracted, `${binary}.metadata.json`),
				commit: plan.commit,
				version: plan.version,
				repository: legacy ? undefined : plan.repository,
				output: join(extracted, "unused-smoke.json"),
			},
			hash,
		);
		bounded.signal.throwIfAborted();
		await absentDestination(destination);
		bounded.signal.throwIfAborted();
		await atomicInstallCiReleaseBuild(extracted, destination, bounded.env);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
