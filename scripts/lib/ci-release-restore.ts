import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, statfs } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { verifyReleaseBundle } from "./ci-release-bundle";
import { readReleaseText } from "./ci-release-io";
import {
	assertCiMainAncestor,
	ciApi,
	ciApiList,
	ciGhRunner,
	parseCiId,
	resolveCiDispatch,
	revalidateCiReleasePlan,
	validateCiReleasePlan,
	validateCiReleaseTag,
} from "./ci-release-plan";
import { CI_RELEASE_TARGETS, CI_RELEASE_WORKFLOW } from "./ci-release-types";
import type { GhRunner } from "./github-release";

export const MAX_RELEASE_BUNDLE_BYTES = 24 * 1024 ** 3;
const FREE_SPACE_RESERVE = 4 * 1024 ** 3;
const RESTORE_TIMEOUT_MS = 15 * 60_000;
const sha = z
	.string()
	.length(40)
	.regex(/^[a-f0-9]{40}$/);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const repository = z.object({ id, full_name: z.string() });
const sourceSchema = z.object({
	id,
	run_attempt: id,
	workflow_id: id,
	path: z.literal(CI_RELEASE_WORKFLOW),
	event: z.literal("workflow_dispatch"),
	head_branch: z.string(),
	head_sha: sha,
	status: z.enum(["completed", "in_progress"]),
	repository,
	head_repository: repository,
});
const artifactSchema = z.object({
	id,
	name: z.string(),
	expired: z.literal(false),
	size_in_bytes: id.max(MAX_RELEASE_BUNDLE_BYTES),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	workflow_run: z.object({
		id,
		repository_id: id,
		head_repository_id: id,
		head_branch: z.string(),
		head_sha: sha,
	}),
});

export const REQUIRED_RELEASE_SOURCE_JOBS = [
	"Verify release source / Static checks",
	"Verify release source / Build and typecheck",
	...Array.from({ length: 4 }, (_, index) => `Verify release source / Tests (${index + 1}/4)`),
	"Verify release source / CI Gate",
	...CI_RELEASE_TARGETS.map(({ target }) => `Build (${target})`),
	...CI_RELEASE_TARGETS.map(({ target }) => `Smoke (${target})`),
	"Assemble release bundle",
];

/** Python's ZIP64 reader streams entries; never let an archive choose a filesystem path. */
const EXTRACT_BUNDLE = `
import os, re, resource, shutil, stat, sys, zipfile
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 ** 2, 512 * 1024 ** 2))
resource.setrlimit(resource.RLIMIT_CPU, (900, 900))
archive, destination, maximum = sys.argv[1], sys.argv[2], int(sys.argv[3])
with zipfile.ZipFile(archive) as bundle:
    entries = bundle.infolist()
    if len(entries) > 202: raise ValueError('bundle entry limit')
    seen = set()
    total = 0
    for entry in entries:
        name = entry.filename
        if name in seen: raise ValueError('duplicate bundle entry')
        seen.add(name)
        mode = entry.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if entry.flag_bits & 1: raise ValueError('encrypted bundle entry')
        if name == 'dist/' and entry.is_dir() and kind in (0, stat.S_IFDIR): continue
        if entry.is_dir() or kind not in (0, stat.S_IFREG): raise ValueError('nonregular bundle entry')
        if name != 'manifest.json' and not re.fullmatch(r'dist/[A-Za-z0-9][A-Za-z0-9._-]{0,199}', name):
            raise ValueError('unsafe bundle path')
        limit = 1024 * 1024 if name == 'manifest.json' else 1024 ** 3
        if entry.file_size < 1 or entry.file_size > limit: raise ValueError('bundle file size limit')
        total += entry.file_size
        if total + os.stat(archive).st_size > maximum: raise ValueError('bundle extraction budget')
    if 'manifest.json' not in seen: raise ValueError('missing bundle manifest')
    free = shutil.disk_usage(destination).free
    if free < total + 4 * 1024 ** 3: raise ValueError('insufficient disk space')
    os.mkdir(os.path.join(destination, 'dist'))
    written = 0
    for entry in entries:
        if entry.is_dir(): continue
        path = os.path.join(destination, *entry.filename.split('/'))
        count = 0
        with bundle.open(entry) as source, open(path, 'xb') as target:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk: break
                count += len(chunk)
                written += len(chunk)
                if count > entry.file_size or written + os.stat(archive).st_size > maximum:
                    raise ValueError('bundle inflated beyond limits')
                target.write(chunk)
        if count != entry.file_size: raise ValueError('bundle size mismatch')
`;

async function downloadArchive(
	artifact: z.infer<typeof artifactSchema>,
	repository: string,
	path: string,
	env: NodeJS.ProcessEnv,
	fetcher: typeof fetch,
	cancel?: AbortSignal,
): Promise<void> {
	const token = env.GH_TOKEN || env.GITHUB_TOKEN;
	if (!token) throw new Error("Artifact download requires GH_TOKEN or GITHUB_TOKEN");
	const signal = AbortSignal.any([
		AbortSignal.timeout(RESTORE_TIMEOUT_MS),
		...(cancel ? [cancel] : []),
	]);
	let url = `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`;
	let response: Response | undefined;
	for (let redirects = 0; redirects <= 3; redirects++) {
		response = await fetcher(url, {
			redirect: "manual",
			signal,
			headers:
				redirects === 0
					? {
							Authorization: `Bearer ${token}`,
							Accept: "application/vnd.github+json",
							"X-GitHub-Api-Version": "2022-11-28",
						}
					: {},
		});
		if (![301, 302, 303, 307, 308].includes(response.status)) break;
		await response.body?.cancel();
		const location = response.headers.get("location");
		if (!location || redirects === 3) throw new Error("Invalid artifact download redirect");
		const next = new URL(location, url);
		if (
			next.protocol !== "https:" ||
			next.username ||
			next.password ||
			![".blob.core.windows.net", ".githubusercontent.com"].some((suffix) =>
				next.hostname.endsWith(suffix),
			)
		) {
			throw new Error("Untrusted artifact download redirect");
		}
		url = next.href;
	}
	if (!response?.ok || !response.body)
		throw new Error(`Artifact download failed: HTTP ${response?.status}`);
	const declared = response.headers.get("content-length");
	if (declared && (!/^\d+$/.test(declared) || Number(declared) !== artifact.size_in_bytes)) {
		await response.body.cancel();
		throw new Error("Artifact download size mismatch");
	}
	const handle = await open(path, "wx", 0o600);
	const reader = response.body.getReader();
	const hash = createHash("sha256");
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const result = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > artifact.size_in_bytes || size > MAX_RELEASE_BUNDLE_BYTES)
				throw new Error("Artifact download exceeds size limit");
			hash.update(result.value);
			let offset = 0;
			while (offset < result.value.length) {
				const written = await handle.write(result.value, offset, result.value.length - offset);
				if (!written.bytesWritten) throw new Error("Artifact write made no progress");
				offset += written.bytesWritten;
			}
		}
		if (size !== artifact.size_in_bytes || `sha256:${hash.digest("hex")}` !== artifact.digest) {
			throw new Error("Artifact digest/size mismatch");
		}
	} finally {
		await reader.cancel();
		await handle.close();
	}
}

export interface RestoreCiReleaseBundleOptions {
	sourceRunId: string | number;
	tag: string;
	root: string;
	destination: string;
	env?: NodeJS.ProcessEnv;
	run?: GhRunner;
	/** Fixture-only transport seam; API provenance still passes through run. */
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

export async function restoreCiReleaseBundle(options: RestoreCiReleaseBundleOptions) {
	validateCiReleaseTag(options.tag);
	const env = options.env ?? process.env;
	const sourceRunId = parseCiId(options.sourceRunId);
	const run = options.run ?? ciGhRunner(env);
	const dispatch = await resolveCiDispatch(run, env);
	const { repository, defaultBranch } = dispatch;
	const source = sourceSchema.parse(await ciApi(run, `actions/runs/${sourceRunId}`, repository));
	if (
		source.id !== sourceRunId ||
		source.repository.full_name !== repository ||
		source.head_repository.full_name !== repository ||
		source.head_branch !== defaultBranch ||
		source.repository.id !== source.head_repository.id ||
		(source.status !== "completed" &&
			(sourceRunId !== dispatch.runId || source.run_attempt !== dispatch.runAttempt))
	) {
		throw new Error("Untrusted or unfinished source workflow run");
	}
	const workflow = z
		.object({ id, path: z.literal(CI_RELEASE_WORKFLOW), state: z.literal("active") })
		.parse(await ciApi(run, `actions/workflows/${source.workflow_id}`, repository));
	if (workflow.id !== source.workflow_id) throw new Error("Source workflow ID mismatch");
	await assertCiMainAncestor(run, source.head_sha, repository, defaultBranch);
	const jobs = z
		.array(
			z.object({
				id,
				run_id: id,
				run_attempt: id,
				name: z.string(),
				status: z.string(),
				conclusion: z.string().nullable(),
				head_sha: sha,
			}),
		)
		.parse(
			await ciApiList(
				run,
				`actions/runs/${sourceRunId}/attempts/${source.run_attempt}/jobs`,
				"jobs",
				repository,
			),
		);
	const jobIds = new Set<number>();
	for (const job of jobs) {
		if (
			job.run_id !== sourceRunId ||
			job.run_attempt !== source.run_attempt ||
			job.head_sha !== source.head_sha ||
			jobIds.has(job.id)
		) {
			throw new Error("Source job provenance mismatch");
		}
		jobIds.add(job.id);
	}
	for (const name of REQUIRED_RELEASE_SOURCE_JOBS) {
		const matches = jobs.filter((job) => job.name === name);
		if (
			matches.length !== 1 ||
			matches[0].status !== "completed" ||
			matches[0].conclusion !== "success"
		) {
			throw new Error(`Source job missing, duplicate or unsuccessful: ${name}`);
		}
	}
	const name = `release-bundle-${sourceRunId}-${source.run_attempt}`;
	const artifacts = await ciApiList(
		run,
		`actions/runs/${sourceRunId}/artifacts`,
		"artifacts",
		repository,
	);
	const matches = artifacts.filter(
		(value) =>
			typeof value === "object" && value !== null && "name" in value && value.name === name,
	);
	if (matches.length !== 1)
		throw new Error("Exact source bundle artifact missing or duplicated; cannot rebuild");
	const listed = artifactSchema.parse(matches[0]);
	const artifact = artifactSchema.parse(
		await ciApi(run, `actions/artifacts/${listed.id}`, repository),
	);
	if (
		artifact.id !== listed.id ||
		artifact.name !== name ||
		artifact.digest !== listed.digest ||
		artifact.size_in_bytes !== listed.size_in_bytes ||
		artifact.workflow_run.id !== sourceRunId ||
		artifact.workflow_run.repository_id !== source.repository.id ||
		artifact.workflow_run.head_repository_id !== source.repository.id ||
		artifact.workflow_run.head_sha !== source.head_sha ||
		artifact.workflow_run.head_branch !== defaultBranch
	)
		throw new Error("Artifact API provenance mismatch");
	// Never overwrite or merge a prior directory. Temporary extraction is an owned sibling.
	const destination = resolve(options.destination);
	const parent = dirname(destination);
	if ((await realpath(parent)) !== parent)
		throw new Error("Bundle destination parent must not contain symlinks");
	try {
		await lstat(destination);
		throw new Error("Bundle destination already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const disk = await statfs(parent);
	if (disk.bavail * disk.bsize < artifact.size_in_bytes + FREE_SPACE_RESERVE) {
		throw new Error("Insufficient disk space for bounded bundle restore");
	}
	const temporary = await mkdtemp(join(parent, `.${basename(destination)}-restore-`));
	const archive = join(temporary, "bundle.zip");
	const extracted = join(temporary, "extracted");
	try {
		await downloadArchive(
			artifact,
			repository,
			archive,
			env,
			options.fetch ?? fetch,
			options.signal,
		);
		await mkdir(extracted);
		await promisify(execFile)(
			"python3",
			["-I", "-c", EXTRACT_BUNDLE, archive, extracted, String(MAX_RELEASE_BUNDLE_BYTES)],
			{
				timeout: RESTORE_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
				signal: options.signal,
			},
		);
		const manifestValue = JSON.parse(await readReleaseText(join(extracted, "manifest.json")));
		const plan = validateCiReleasePlan(manifestValue.plan);
		if (
			plan.repository !== repository ||
			(plan.defaultBranch ?? "main") !== defaultBranch ||
			plan.runId !== sourceRunId ||
			plan.runAttempt !== source.run_attempt ||
			plan.workflowCommit !== source.head_sha ||
			plan.tag !== options.tag
		) {
			throw new Error("Bundle manifest does not match source run provenance");
		}
		await revalidateCiReleasePlan(plan, { root: options.root, publish: false, run, env });
		await verifyReleaseBundle(extracted, plan);
		await rename(extracted, destination);
		return {
			plan,
			artifactId: artifact.id,
			artifactDigest: artifact.digest,
			sourceRunId,
			sourceRunAttempt: source.run_attempt,
			destination,
		};
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
