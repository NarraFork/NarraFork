import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	realpath,
	rename,
	rm,
	statfs,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { updateServerChildEnvironment } from "../../shared/update-server-child-env";
import { hashReleaseFile, readReleaseText } from "./ci-release-io";
import { assertCiMainAncestor, ciApi, ciApiList, ciGhRunner, parseCiId } from "./ci-release-plan";
import type { GhRunner } from "./github-release";

const MAX_ARCHIVE = 24 * 1024 ** 3;
const TIMEOUT = 15 * 60_000;
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const envelopeSchema = z
	.object({
		schemaVersion: z.literal(1),
		kind: z.enum(["main", "helpers", "executor"]),
		repository: z.string().regex(/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/),
		defaultBranch: z.string().min(1).max(200),
		tag: z.string().min(1).max(160),
		version: z.string().min(1).max(100),
		commit,
		sourceRunId: id,
		sourceRunAttempt: id,
		bridgeRunId: id,
		bridgeRunAttempt: id,
		controlCommit: commit,
		serverUrl: z.string().url(),
		manifestSha256: sha,
		sealSha256: sha,
	})
	.strict();
export type BridgeEnvelope = z.infer<typeof envelopeSchema>;
export type BridgeIdentity = Omit<
	BridgeEnvelope,
	"schemaVersion" | "bridgeRunId" | "bridgeRunAttempt" | "controlCommit" | "sealSha256"
>;
const ENVELOPE = "bridge-envelope.json";
/** All publisher stages share one workflow-created deadline, not fresh per-stage budgets. */
export function ciBridgeDeadlineSignal(env: NodeJS.ProcessEnv, parent: AbortSignal): AbortSignal {
	const raw = env.NF_RELEASE_DEADLINE_MS;
	const now = Date.now();
	if (
		raw !== undefined &&
		(!/^[1-9]\d{0,15}$/.test(raw) ||
			!Number.isSafeInteger(Number(raw)) ||
			Number(raw) > now + 30 * 60_000)
	)
		throw new Error("Invalid CI publication deadline");
	const remaining = raw === undefined ? 25 * 60_000 : Math.max(0, Number(raw) - now);
	return AbortSignal.any([
		parent,
		remaining === 0
			? AbortSignal.abort(new Error("CI publication deadline expired"))
			: AbortSignal.timeout(remaining),
	]);
}
export interface BridgeProcessOptions {
	signal?: AbortSignal;
	environment?: NodeJS.ProcessEnv;
	timeoutMs: number;
	maximumOutputBytes: number;
}
/** Only gh api's first diagnostic line is authoritative, never a response body or token. */
function failedGhApiStatus(command: string, args: string[], stderr: string): number | undefined {
	if (command !== "gh" || args[0] !== "api") return undefined;
	const lines = stderr.split(/\r?\n/);
	const diagnostic = /^gh: ([^\p{Cc}]+) \(HTTP ([45]\d{2})\)$/u.exec(lines[0] ?? "");
	if (!diagnostic) return undefined;
	// Ambiguous/malformed extra diagnoses and status text inside messages fail closed.
	if (/\bHTTP\s+\d/.test(diagnostic[1] ?? "")) return undefined;
	if (lines.slice(1).some((line) => /^gh:/.test(line) || /\bHTTP\s+\d/.test(line)))
		return undefined;
	const status = Number(diagnostic[2]);
	// Missing is deliberately narrower than arbitrary server-supplied error messages.
	if (status === 404 && diagnostic[1] !== "Not Found") return undefined;
	return status;
}
/** Bounded asynchronous children; failure/abort waits for close before filesystem cleanup. */
export async function runBridgeProcess(
	command: string,
	args: string[],
	options: BridgeProcessOptions,
): Promise<string> {
	if (
		!Number.isSafeInteger(options.maximumOutputBytes) ||
		options.maximumOutputBytes < 1 ||
		options.maximumOutputBytes > 1024 * 1024 ||
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1 ||
		options.timeoutMs > TIMEOUT
	)
		throw new Error("Invalid CI subprocess budget");
	const env = options.environment ?? process.env;
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		AbortSignal.timeout(options.timeoutMs),
	]);
	signal.throwIfAborted();
	const childEnv = {
		...updateServerChildEnvironment(env),
		GH_HOST: "github.com",
		GH_PROMPT_DISABLED: "1",
	};
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
	const cancel = () => {
		child.kill("SIGKILL");
	};
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	const collect = async (stream: NodeJS.ReadableStream) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		let exceeded = false;
		try {
			for await (const chunk of stream) {
				const buffer = Buffer.from(chunk);
				bytes += buffer.length;
				if (bytes > options.maximumOutputBytes) {
					exceeded = true;
					throw new Error("GitHub publication output exceeds limit");
				}
				chunks.push(buffer);
			}
			return Buffer.concat(chunks, bytes).toString("utf8");
		} catch {
			cancel();
			throw new Error(
				exceeded
					? "GitHub publication output exceeds limit"
					: "GitHub publication output collection failed",
			);
		}
	};
	let spawnFailed = false;
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		// Do not expose native errors (which can contain paths/arguments/secrets).
		child.once("error", () => {
			spawnFailed = true;
			cancel();
		});
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	try {
		// Nonzero close must not race ahead of the bounded stderr reader. Rejected
		// readers already kill the child; every path waits for close and both readers.
		const [stdout, stderr, closed] = await Promise.allSettled([
			collect(child.stdout),
			collect(child.stderr),
			exit,
		]);
		signal.throwIfAborted();
		if (spawnFailed) throw new Error("GitHub publication subprocess failed");
		if (stdout.status === "rejected") throw stdout.reason;
		if (stderr.status === "rejected") throw stderr.reason;
		if (closed.status === "rejected") throw new Error("GitHub publication subprocess failed");
		if (spawnFailed || closed.value.signal || closed.value.code !== 0) {
			const status =
				!spawnFailed && !closed.value.signal && closed.value.code !== null
					? failedGhApiStatus(command, args, stderr.value)
					: undefined;
			throw new Error(
				`GitHub publication subprocess failed${status === undefined ? "" : ` (HTTP ${status})`}`,
			);
		}
		return stdout.value;
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
export function createBridgeGhRunner(
	parent: AbortSignal,
	env: NodeJS.ProcessEnv = process.env,
): GhRunner {
	return (args) =>
		runBridgeProcess("gh", args, {
			signal: parent,
			environment: env,
			timeoutMs: 5 * 60_000,
			maximumOutputBytes: 1024 * 1024,
		});
}
export async function hasMirrorFailureReceipt(
	path: string,
	status: "partial" | "PUBLISHED_NOT_MIRRORED",
): Promise<boolean> {
	try {
		const value: unknown = JSON.parse(await readReleaseText(path, 1024 * 1024));
		return (
			value !== null && typeof value === "object" && "status" in value && value.status === status
		);
	} catch {
		return false;
	}
}
export const BRIDGE_PREPARE_STEP = "Prepare immutable update server bridge";
export const BRIDGE_UPLOAD_STEP = "Seal immutable update server bridge artifact";
export function bridgeArtifactName(kind: BridgeEnvelope["kind"], runId: number, attempt: number) {
	return `update-server-bridge-${kind}-${parseCiId(runId)}-${parseCiId(attempt)}`;
}
export function assertBridgeMode(options: {
	publish: string;
	mirrorOnly: string;
	indexOnly?: string;
	sourceRunId?: string;
	bridgeRunId?: string;
}) {
	for (const value of [options.publish, options.mirrorOnly, options.indexOnly ?? "false"])
		if (value !== "true" && value !== "false") throw new Error("Invalid bridge publication mode");
	if (options.mirrorOnly === "true") {
		if (options.publish !== "true" || options.indexOnly === "true")
			throw new Error("mirror-only requires publish=true and index-only=false");
		parseCiId(options.sourceRunId);
		parseCiId(options.bridgeRunId);
	} else if (options.bridgeRunId) throw new Error("bridge-run-id is only valid for mirror-only");
}
export function validateBridgeEnvelope(value: unknown, identity: BridgeIdentity): BridgeEnvelope {
	const envelope = envelopeSchema.parse(value);
	for (const [key, expected] of Object.entries(identity)) {
		if (envelope[key as keyof BridgeEnvelope] !== expected)
			throw new Error(`Bridge envelope identity mismatch: ${key}`);
	}
	return envelope;
}
export async function writeBridgeEnvelope(
	bridgeDir: string,
	identity: BridgeIdentity,
	sealSha256: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	const envelope = envelopeSchema.parse({
		...identity,
		schemaVersion: 1,
		sealSha256,
		bridgeRunId: parseCiId(env.GITHUB_RUN_ID),
		bridgeRunAttempt: parseCiId(env.GITHUB_RUN_ATTEMPT),
		controlCommit: env.GITHUB_SHA,
	});
	await writeFile(join(bridgeDir, ENVELOPE), `${JSON.stringify(envelope, null, 2)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	return envelope;
}

const runSchema = z.object({
	id,
	run_attempt: id,
	workflow_id: id,
	path: z.string(),
	event: z.literal("workflow_dispatch"),
	head_branch: z.string(),
	head_sha: commit,
	status: z.enum(["completed", "in_progress"]),
	repository: z.object({ id, full_name: z.string() }),
	head_repository: z.object({ id, full_name: z.string() }),
});
const artifactSchema = z.object({
	id,
	name: z.string(),
	expired: z.literal(false),
	size_in_bytes: id.max(MAX_ARCHIVE),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	workflow_run: z.object({
		id,
		repository_id: id,
		head_repository_id: id,
		head_sha: commit,
		head_branch: z.string(),
	}),
});
type Artifact = z.infer<typeof artifactSchema>;
export interface RestoreBridgeOptions {
	identity: BridgeIdentity;
	bridgeRunId: number;
	/** Defaults to the source run's current attempt. Specify the original attempt after a rerun. */
	bridgeRunAttempt?: number;
	destination: string;
	run?: GhRunner;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	/** First publication must prove that the upload step completed in this protected job. */
	uploadedArtifactId?: string;
	uploadedArtifactDigest?: string;
}
export function validateBridgePreparationJobs(
	value: unknown,
	source: z.infer<typeof runSchema>,
	attempt: number,
	kind: BridgeEnvelope["kind"],
) {
	const jobs = z
		.array(
			z.object({
				id,
				run_id: id,
				run_attempt: id,
				head_sha: commit,
				name: z.string(),
				steps: z.array(
					z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }),
				),
			}),
		)
		.parse(value);
	const name = kind === "main" ? "Publish verified release" : "Publish approved helper draft";
	const matches = jobs.filter((job) => job.name === name);
	if (matches.length !== 1) throw new Error("Missing unique protected bridge publisher job");
	const job = matches[0];
	if (
		!job ||
		job.run_id !== source.id ||
		job.run_attempt !== attempt ||
		job.head_sha !== source.head_sha
	)
		throw new Error("Bridge preparation job provenance mismatch");
	for (const name of [BRIDGE_PREPARE_STEP, BRIDGE_UPLOAD_STEP]) {
		const steps = job.steps.filter((step) => step.name === name);
		if (
			steps.length !== 1 ||
			steps[0]?.status !== "completed" ||
			steps[0]?.conclusion !== "success"
		)
			throw new Error("Bridge preparation/upload did not succeed");
	}
}
async function resolveArtifact(options: RestoreBridgeOptions) {
	const env = options.env ?? process.env;
	const run = options.run ?? ciGhRunner(env);
	const expected = options.identity;
	if (
		env.GITHUB_REPOSITORY?.toLowerCase() !== expected.repository.toLowerCase() ||
		env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
		env.GITHUB_REF !== `refs/heads/${expected.defaultBranch}`
	)
		throw new Error("Bridge restore requires trusted default-branch dispatch");
	const workflowPath =
		expected.kind === "main"
			? ".github/workflows/release.yml"
			: ".github/workflows/helpers-release.yml";
	const source = runSchema.parse(
		await ciApi(run, `actions/runs/${parseCiId(options.bridgeRunId)}`, expected.repository),
	);
	if (
		source.id !== options.bridgeRunId ||
		source.path !== workflowPath ||
		source.head_branch !== expected.defaultBranch ||
		source.repository.full_name.toLowerCase() !== expected.repository.toLowerCase() ||
		source.head_repository.full_name.toLowerCase() !== expected.repository.toLowerCase() ||
		source.repository.id !== source.head_repository.id ||
		(source.status !== "completed" &&
			(String(source.id) !== env.GITHUB_RUN_ID ||
				String(source.run_attempt) !== env.GITHUB_RUN_ATTEMPT))
	)
		throw new Error("Untrusted bridge workflow run");
	const attempt =
		options.bridgeRunAttempt === undefined
			? source.run_attempt
			: parseCiId(options.bridgeRunAttempt);
	if (attempt > source.run_attempt) throw new Error("Unknown bridge run attempt");
	const workflow = z
		.object({ id, path: z.literal(workflowPath), state: z.literal("active") })
		.parse(await ciApi(run, `actions/workflows/${source.workflow_id}`, expected.repository));
	if (workflow.id !== source.workflow_id) throw new Error("Unknown bridge workflow identity");
	await assertCiMainAncestor(run, source.head_sha, expected.repository, expected.defaultBranch);
	validateBridgePreparationJobs(
		await ciApiList(
			run,
			`actions/runs/${source.id}/attempts/${attempt}/jobs`,
			"jobs",
			expected.repository,
		),
		source,
		attempt,
		expected.kind,
	);
	const name = bridgeArtifactName(expected.kind, source.id, attempt);
	const matches = (
		await ciApiList(run, `actions/runs/${source.id}/artifacts`, "artifacts", expected.repository)
	).filter(
		(item) => item !== null && typeof item === "object" && "name" in item && item.name === name,
	);
	if (matches.length !== 1) throw new Error("Missing unique immutable bridge artifact");
	const listed = artifactSchema.parse(matches[0]);
	const artifact = artifactSchema.parse(
		await ciApi(run, `actions/artifacts/${listed.id}`, expected.repository),
	);
	if (
		artifact.id !== listed.id ||
		artifact.name !== name ||
		artifact.digest !== listed.digest ||
		artifact.size_in_bytes !== listed.size_in_bytes ||
		artifact.workflow_run.id !== source.id ||
		artifact.workflow_run.repository_id !== source.repository.id ||
		artifact.workflow_run.head_repository_id !== source.repository.id ||
		artifact.workflow_run.head_sha !== source.head_sha ||
		artifact.workflow_run.head_branch !== expected.defaultBranch
	)
		throw new Error("Bridge artifact provenance mismatch");
	if (options.uploadedArtifactId !== undefined || options.uploadedArtifactDigest !== undefined) {
		const digest = options.uploadedArtifactDigest?.replace(/^sha256:/, "");
		if (
			parseCiId(options.uploadedArtifactId) !== artifact.id ||
			`sha256:${digest}` !== artifact.digest ||
			String(source.id) !== env.GITHUB_RUN_ID ||
			String(attempt) !== env.GITHUB_RUN_ATTEMPT
		)
			throw new Error("Bridge upload receipt mismatch");
	}
	return { artifact, source, attempt };
}
async function download(artifact: Artifact, options: RestoreBridgeOptions, path: string) {
	const env = options.env ?? process.env;
	const token = env.GH_TOKEN || env.GITHUB_TOKEN;
	if (!token) throw new Error("Bridge artifact download requires GitHub authentication");
	const signal = AbortSignal.any([
		AbortSignal.timeout(TIMEOUT),
		...(options.signal ? [options.signal] : []),
	]);
	let url = `https://api.github.com/repos/${options.identity.repository}/actions/artifacts/${artifact.id}/zip`;
	let response: Response | undefined;
	for (let hop = 0; hop <= 3; hop++) {
		response = await (options.fetch ?? fetch)(url, {
			redirect: "manual",
			signal,
			headers:
				hop === 0
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
		if (!location || hop === 3) throw new Error("Invalid bridge artifact redirect");
		const next = new URL(location, url);
		if (
			next.protocol !== "https:" ||
			next.username ||
			next.password ||
			![".blob.core.windows.net", ".githubusercontent.com"].some((suffix) =>
				next.hostname.endsWith(suffix),
			)
		)
			throw new Error("Untrusted bridge artifact redirect");
		url = next.href;
	}
	if (!response?.ok || !response.body) throw new Error("Bridge artifact download failed");
	const length = response.headers.get("content-length");
	if (length && (!/^\d+$/.test(length) || Number(length) !== artifact.size_in_bytes)) {
		await response.body.cancel();
		throw new Error("Bridge artifact size mismatch");
	}
	const file = await open(path, "wx", 0o600);
	const reader = response.body.getReader();
	const hash = createHash("sha256");
	let count = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			if (chunk.done) break;
			count += chunk.value.byteLength;
			if (count > artifact.size_in_bytes) throw new Error("Bridge archive exceeds size limit");
			hash.update(chunk.value);
			let offset = 0;
			while (offset < chunk.value.length) {
				const result = await file.write(chunk.value, offset, chunk.value.length - offset);
				if (!result.bytesWritten) throw new Error("Bridge archive write stalled");
				offset += result.bytesWritten;
			}
		}
		if (count !== artifact.size_in_bytes || `sha256:${hash.digest("hex")}` !== artifact.digest)
			throw new Error("Bridge archive digest mismatch");
	} finally {
		await reader.cancel();
		await file.close();
	}
}
// ZIP64 is required for eight-platform bridge patches. Reject traversal, links,
// duplicates and compression bombs before writing any archive-selected path.
const EXTRACT = `
import os, re, resource, shutil, stat, sys, zipfile
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024**2, 512 * 1024**2))
resource.setrlimit(resource.RLIMIT_CPU, (900,900))
archive, dest, maximum = sys.argv[1], sys.argv[2], int(sys.argv[3])
with zipfile.ZipFile(archive) as z:
    entries = z.infolist()
    if len(entries) > 256: raise ValueError('entry budget')
    seen = set(); total = 0
    for e in entries:
        name = e.filename; kind = stat.S_IFMT(e.external_attr >> 16)
        if name in seen or e.flag_bits & 1: raise ValueError('duplicate/encrypted entry')
        seen.add(name)
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,255}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,255})?/?', name) or '..' in name: raise ValueError('unsafe path')
        if e.is_dir():
            if kind not in (0,stat.S_IFDIR): raise ValueError('unsafe directory')
            continue
        if kind not in (0,stat.S_IFREG): raise ValueError('nonregular entry')
        limit = 1024**2 if name.endswith('.json') else 1024**3
        if not 0 < e.file_size <= limit: raise ValueError('file budget')
        total += e.file_size
        if total + os.stat(archive).st_size > maximum: raise ValueError('archive expansion budget')
    if 'bridge-envelope.json' not in seen: raise ValueError('missing envelope')
    if shutil.disk_usage(dest).free < total + 4*1024**3: raise ValueError('disk budget')
    written = 0
    for e in entries:
        if e.is_dir(): continue
        path = os.path.join(dest,*e.filename.split('/')); os.makedirs(os.path.dirname(path),exist_ok=True)
        count = 0
        with z.open(e) as src, open(path,'xb') as out:
            while True:
                chunk = src.read(1024**2)
                if not chunk: break
                count += len(chunk); written += len(chunk)
                if count > e.file_size or written + os.stat(archive).st_size > maximum: raise ValueError('inflated archive')
                out.write(chunk)
        if count != e.file_size: raise ValueError('truncated entry')
`;
export async function restoreUpdateServerBridgeArtifact(options: RestoreBridgeOptions) {
	const { artifact, source, attempt } = await resolveArtifact(options);
	const destination = resolve(options.destination);
	const parent = dirname(destination);
	if ((await realpath(parent)) !== parent)
		throw new Error("Bridge restore parent contains symlinks");
	try {
		await lstat(destination);
		throw new Error("Bridge restore destination already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const disk = await statfs(parent);
	if (disk.bavail * disk.bsize < artifact.size_in_bytes + 4 * 1024 ** 3)
		throw new Error("Insufficient bridge restore disk space");
	const temporary = await mkdtemp(join(parent, `.${basename(destination)}-bridge-`));
	try {
		const archive = join(temporary, "archive.zip");
		const extracted = join(temporary, "extracted");
		await mkdir(extracted);
		await download(artifact, options, archive);
		await runBridgeProcess("python3", ["-c", EXTRACT, archive, extracted, String(MAX_ARCHIVE)], {
			timeoutMs: TIMEOUT,
			maximumOutputBytes: 64 * 1024,
			signal: options.signal,
		});
		const envelope = validateBridgeEnvelope(
			JSON.parse(await readReleaseText(join(extracted, ENVELOPE), 64 * 1024)),
			options.identity,
		);
		if (
			envelope.bridgeRunId !== source.id ||
			envelope.bridgeRunAttempt !== attempt ||
			envelope.controlCommit !== source.head_sha
		)
			throw new Error("Bridge envelope run provenance mismatch");
		const sealName =
			envelope.kind === "main" ? "prepared-main-mirror.json" : "tools-mirror-seal.json";
		if (
			(await hashReleaseFile(join(extracted, sealName), 1024 * 1024, options.signal)).sha256 !==
			envelope.sealSha256
		)
			throw new Error("Bridge seal digest mismatch");
		await rename(extracted, destination);
		return { envelope, artifactId: artifact.id, artifactDigest: artifact.digest };
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
