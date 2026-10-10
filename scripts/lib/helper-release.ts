import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type DistributionLicense,
	HELPER_BINARY_MAX_BYTES,
	HELPER_MANIFEST_FILENAME,
	HELPER_MANIFEST_MAX_BYTES,
	HELPER_RELEASE_TAG,
	parseExecutorReleaseManifest,
	parseHelperManifest,
} from "../../shared/helper-distribution";
import { EXECUTOR_MANIFEST_FILENAME } from "../../shared/remote-executor";
import { updateServerChildEnvironment } from "../../shared/update-server-child-env";
import { type GhRunner, validateGitHubRepository } from "./github-release";
import { listGitHubReleaseSummaries } from "./github-release-summary";

export const HELPER_LICENSE_FILES = [
	"ripgrep.txt",
	"pcre2.txt",
	"zstd.txt",
	"musl.txt",
	"gcc-runtime.txt",
	"llvm-compiler-rt.txt",
	"mingw-w64-runtime.txt",
] as const;
export const EXECUTOR_LICENSE_FILES = [
	"go-stdlib.txt",
	"go-doublestar.txt",
	"go-coder-websocket.txt",
	"go-creack-pty.txt",
	"go-x-sys.txt",
	"go-purego.txt",
] as const;
export type HelperReleaseKind = "helpers" | "executor";
export interface HelperReleaseOptions {
	repository: string;
	kind: HelperReleaseKind;
	version: string;
	protocolVersion: number;
	commit: string;
	bundleDir: string;
	run?: GhRunner;
	signal?: AbortSignal;
}
interface RemoteAsset {
	id: number;
	name: string;
	size: number;
	state: string;
	digest: string | null;
}
interface RemoteRelease {
	id: number;
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	assets: RemoteAsset[];
}
interface ReleaseDescription {
	tag: string;
	manifestName: string;
	files: DistributionLicense[];
}

export async function helperFileIdentity(
	path: string,
	maximum = HELPER_BINARY_MAX_BYTES,
): Promise<DistributionLicense> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.size < 1 || stat.size > maximum)
		throw new Error(`Invalid helper file size/type: ${path}`);
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of createReadStream(path)) {
		size += chunk.length;
		if (size > maximum) throw new Error("Helper asset exceeds limit");
		hash.update(chunk);
	}
	if (size !== stat.size) throw new Error("Helper file changed while reading");
	return { name: path.split(/[\\/]/).at(-1) as string, size, sha256: hash.digest("hex") };
}
function describe(
	value: unknown,
	options: Omit<HelperReleaseOptions, "bundleDir">,
): ReleaseDescription {
	validateGitHubRepository(options.repository);
	if (!/^[0-9a-f]{40}$/.test(options.commit)) throw new Error("Expected exact source commit");
	const identity = { repository: options.repository, commit: options.commit };
	let result: ReleaseDescription;
	if (options.kind === "helpers") {
		const manifest = parseHelperManifest(value, identity);
		result = {
			tag: manifest.tag,
			manifestName: HELPER_MANIFEST_FILENAME,
			files: [...manifest.files, ...manifest.licenses],
		};
	} else {
		const outer = parseExecutorReleaseManifest(value, {
			...identity,
			version: options.version,
			protocolVersion: options.protocolVersion,
		});
		result = {
			tag: outer.tag,
			manifestName: EXECUTOR_MANIFEST_FILENAME,
			files: [
				...Object.values(outer.manifest.platforms).map((entry) => ({
					name: entry.filename,
					size: entry.size,
					sha256: entry.sha256,
				})),
				...outer.licenses,
			],
		};
	}
	const required = options.kind === "helpers" ? HELPER_LICENSE_FILES : EXECUTOR_LICENSE_FILES;
	if (required.some((name) => !result.files.some((file) => file.name === name)))
		throw new Error("Incomplete helper license materials");
	return result;
}
async function call(
	options: { run?: GhRunner; signal?: AbortSignal },
	args: string[],
	maximum = 128 * 1024,
): Promise<string> {
	options.signal?.throwIfAborted();
	if (options.run) {
		const result = await options.run(args);
		options.signal?.throwIfAborted();
		if (Buffer.byteLength(result) > maximum) throw new Error("Helper GitHub output exceeds limit");
		return result;
	}
	const proc = Bun.spawn(["gh", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...updateServerChildEnvironment(), GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
	});
	const timeout = AbortSignal.timeout(args[0] === "api" ? 10_000 : 300_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const cancel = () => proc.kill();
	signal.addEventListener("abort", cancel, { once: true });
	const collect = async (stream: ReadableStream<Uint8Array>, limit: number) => {
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of stream) {
			size += chunk.byteLength;
			if (size > limit) {
				proc.kill();
				throw new Error("Helper GitHub output exceeds limit");
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks, size).toString("utf8");
	};
	try {
		const [stdout, stderr, exit] = await Promise.all([
			collect(proc.stdout, maximum),
			collect(proc.stderr, 8192),
			proc.exited,
		]);
		signal.throwIfAborted();
		if (exit !== 0) throw new Error(`gh failed: ${stderr}`);
		return stdout;
	} finally {
		signal.removeEventListener("abort", cancel);
		if (proc.exitCode === null) proc.kill();
	}
}
export async function resolveHelperTagCommit(
	options: { repository: string; run?: GhRunner; signal?: AbortSignal },
	tag: string,
): Promise<string> {
	validateGitHubRepository(options.repository);
	if (tag !== HELPER_RELEASE_TAG && !/^executor-v\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/.test(tag))
		throw new Error("Invalid fixed helper release tag");
	const parseObject = (raw: string): { type: string; sha: string } => {
		const object = (JSON.parse(raw) as { object?: { type?: unknown; sha?: unknown } }).object;
		if (
			!object ||
			(object.type !== "tag" && object.type !== "commit") ||
			typeof object.sha !== "string" ||
			!/^[0-9a-f]{40}$/.test(object.sha)
		)
			throw new Error("Invalid helper tag reference object");
		return { type: object.type, sha: object.sha };
	};
	let object = parseObject(
		await call(options, [
			"api",
			`repos/${options.repository}/git/ref/tags/${encodeURIComponent(tag)}`,
		]),
	);
	const seen = new Set<string>();
	for (let depth = 0; object.type === "tag" && depth < 4; depth++) {
		if (seen.has(object.sha)) throw new Error("Helper annotated tag cycle");
		seen.add(object.sha);
		object = parseObject(
			await call(options, ["api", `repos/${options.repository}/git/tags/${object.sha}`]),
		);
	}
	if (object.type !== "commit") throw new Error("Helper annotated tag peeling limit reached");
	return object.sha;
}
async function getRelease(
	options: { repository: string; run?: GhRunner; signal?: AbortSignal },
	tag: string,
	allowDraftLookup = false,
): Promise<RemoteRelease | undefined> {
	let text: string;
	let summary: Awaited<ReturnType<typeof listGitHubReleaseSummaries>>[number] | undefined;
	try {
		text = await call(options, ["api", `repos/${options.repository}/releases/tags/${tag}`]);
	} catch (error) {
		if (!allowDraftLookup || !/HTTP 404\b/.test(String(error))) throw error;
		// /releases/tags excludes drafts. Enumerate authenticated, bounded summaries
		// to completion before declaring absence; never enumerate bodies/assets.
		const releases = await listGitHubReleaseSummaries(
			(args) => call(options, args, 1024 * 1024),
			options.repository,
		);
		const matches = releases.filter((release) => release.tagName === tag);
		if (matches.length > 1) throw new Error("Ambiguous helper release tag");
		summary = matches[0];
		if (!summary) return undefined;
		if (summary.assetCount > 45) throw new Error("Helper release asset count exceeds limit");
		text = await call(options, ["api", `repos/${options.repository}/releases/${summary.id}`]);
	}
	if (Buffer.byteLength(text) > 128 * 1024) throw new Error("Release metadata exceeds limit");
	const value = JSON.parse(text) as RemoteRelease;
	if (
		!Number.isSafeInteger(value.id) ||
		value.id < 1 ||
		value.tag_name !== tag ||
		typeof value.draft !== "boolean" ||
		typeof value.prerelease !== "boolean" ||
		!Array.isArray(value.assets) ||
		value.assets.length > 45
	)
		throw new Error("Invalid helper release metadata");
	if (
		summary &&
		(value.id !== summary.id ||
			value.draft !== summary.draft ||
			value.prerelease !== summary.prerelease ||
			value.assets.length !== summary.assetCount)
	)
		throw new Error("Helper release summary/ID/asset completeness mismatch");
	const names = new Set<string>();
	for (const asset of value.assets) {
		if (
			!Number.isSafeInteger(asset.id) ||
			asset.id < 1 ||
			!Number.isSafeInteger(asset.size) ||
			asset.size < 1 ||
			asset.size > HELPER_BINARY_MAX_BYTES ||
			typeof asset.name !== "string" ||
			names.has(asset.name) ||
			asset.state !== "uploaded"
		)
			throw new Error("Invalid/duplicate helper release asset");
		names.add(asset.name);
	}
	return value;
}
function assertRemoteFiles(
	release: RemoteRelease,
	files: DistributionLicense[],
	exact = true,
): void {
	if (exact && release.assets.length !== files.length)
		throw new Error("Remote helper asset set is not exact");
	for (const remote of release.assets) {
		const file = files.find((entry) => entry.name === remote.name);
		if (!file || remote.size !== file.size || remote.digest !== `sha256:${file.sha256}`)
			throw new Error(`Remote helper size/SHA-256 mismatch: ${remote.name}`);
	}
}
async function verifyOne(
	options: Omit<HelperReleaseOptions, "bundleDir" | "commit">,
): Promise<void> {
	validateGitHubRepository(options.repository);
	const tag = options.kind === "helpers" ? HELPER_RELEASE_TAG : `executor-v${options.version}`;
	const commit = await resolveHelperTagCommit(options, tag);
	const release = await getRelease(options, tag);
	if (!release || release.draft || release.prerelease)
		throw new Error("Helper dependency is not public and stable");
	const manifestName =
		options.kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME;
	const asset = release.assets.find((entry) => entry.name === manifestName);
	if (!asset || asset.size > HELPER_MANIFEST_MAX_BYTES)
		throw new Error("Missing/oversized helper manifest");
	const raw = await call(
		options,
		[
			"api",
			`repos/${options.repository}/releases/assets/${asset.id}`,
			"-H",
			"Accept: application/octet-stream",
		],
		HELPER_MANIFEST_MAX_BYTES,
	);
	const bytes = Buffer.from(raw);
	if (bytes.length !== asset.size || bytes.length > HELPER_MANIFEST_MAX_BYTES)
		throw new Error("Helper manifest size mismatch");
	const manifestFile = {
		name: manifestName,
		size: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	const description = describe(JSON.parse(raw), { ...options, commit });
	assertRemoteFiles(release, [...description.files, manifestFile]);
}
/** Read-only readiness gate. No latest, index, draft creation, upload, or tag mutation. */
export async function verifyPublishedHelperDependencies(options: {
	repository: string;
	helpersTag: string;
	executorVersion: string;
	protocolVersion: number;
	run?: GhRunner;
	signal?: AbortSignal;
}): Promise<void> {
	validateGitHubRepository(options.repository);
	if (
		options.helpersTag !== HELPER_RELEASE_TAG ||
		!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/.test(options.executorVersion) ||
		!Number.isSafeInteger(options.protocolVersion) ||
		options.protocolVersion < 1
	)
		throw new Error("Invalid helper dependency declaration");
	await verifyOne({ ...options, kind: "helpers", version: "1.0.0" });
	await verifyOne({ ...options, kind: "executor", version: options.executorVersion });
}
export async function validateHelperReleaseBundle(
	options: HelperReleaseOptions,
): Promise<ReleaseDescription> {
	const manifestName =
		options.kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME;
	await helperFileIdentity(join(options.bundleDir, manifestName), HELPER_MANIFEST_MAX_BYTES);
	const description = describe(
		JSON.parse(await readFile(join(options.bundleDir, manifestName), "utf8")),
		options,
	);
	const files = [
		...description.files,
		await helperFileIdentity(join(options.bundleDir, manifestName), HELPER_MANIFEST_MAX_BYTES),
	];
	const names = await readdir(options.bundleDir);
	if (
		names.length !== files.length ||
		names.some((name) => !files.some((file) => file.name === name))
	)
		throw new Error("Local helper bundle asset set is not exact");
	for (const file of files) {
		const actual = await helperFileIdentity(join(options.bundleDir, file.name));
		if (actual.size !== file.size || actual.sha256 !== file.sha256)
			throw new Error(`Local helper size/SHA-256 mismatch: ${file.name}`);
	}
	return { ...description, files };
}
/** Explicit publisher only. Existing public releases are immutable; draft recovery never clobbers. */
export async function publishHelperRelease(
	options: HelperReleaseOptions & { dryRun?: boolean; beforeWrite?: () => Promise<void> },
): Promise<void> {
	const description = await validateHelperReleaseBundle(options);
	if (options.dryRun) return; // Deliberately before even read-only remote queries.
	const beforeWrite = async () => {
		await options.beforeWrite?.();
		if ((await resolveHelperTagCommit(options, description.tag)) !== options.commit)
			throw new Error("Helper tag changed before remote write");
	};
	if ((await resolveHelperTagCommit(options, description.tag)) !== options.commit)
		throw new Error("Helper tag/source mismatch");
	let release = await getRelease(options, description.tag, true);
	if (release && !release.draft) throw new Error("Public helper release is immutable");
	if (!release) {
		await beforeWrite();
		await call(options, [
			"release",
			"create",
			description.tag,
			"--repo",
			options.repository,
			"--verify-tag",
			"--draft",
			"--latest=false",
			"--title",
			description.tag,
			"--notes",
			"Immutable auxiliary binaries and license materials. Linux ARM64 ripgrep requires glibc; Alpine/Termux are not supported.",
		]);
		release = await getRelease(options, description.tag, true);
	}
	if (!release?.draft || release.prerelease) throw new Error("Expected stable helper draft");
	assertRemoteFiles(release, description.files, false);
	const draft = release;
	if (description.files.some((file) => !draft.assets.some((asset) => asset.name === file.name)))
		await beforeWrite();
	for (const file of description.files) {
		if (release.assets.some((asset) => asset.name === file.name)) continue;
		await call(options, [
			"release",
			"upload",
			description.tag,
			join(options.bundleDir, file.name),
			"--repo",
			options.repository,
		]);
	}
	const uploaded = await getRelease(options, description.tag, true);
	if (!uploaded?.draft || uploaded.id !== release.id)
		throw new Error("Helper draft changed before publication");
	assertRemoteFiles(uploaded, description.files);
	if ((await resolveHelperTagCommit(options, description.tag)) !== options.commit)
		throw new Error("Helper tag changed before publication");
	await beforeWrite();
	await call(options, [
		"release",
		"edit",
		description.tag,
		"--repo",
		options.repository,
		"--draft=false",
		"--latest=false",
		"--verify-tag",
	]);
	await verifyOne(options);
}
