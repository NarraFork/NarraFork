import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidGitHubRepository } from "../../shared/github-repository";
import { parseReleasePatchName, validateReleasePatchMetadata } from "../../shared/release-patch";
import { compareReleaseVersions, isValidReleaseVersion } from "../../shared/release-version";
import {
	MAX_UPDATE_INDEX_BYTES,
	MAX_UPDATE_NOTES_BYTES,
	mergeUpdateIndex,
	parseUpdateIndex,
	parseUpdateIndexRelease,
	parseUpdateNotes,
	UPDATE_INDEX_BRANCH,
	UPDATE_INDEX_FILE,
	UPDATE_INDEX_PLATFORMS,
	type UpdateIndexAsset,
	type UpdateIndexRelease,
	type UpdateIndexV1,
} from "../../shared/update-index";
import { type GhRunner, githubReleaseBody } from "./github-release";
import { type GitHubReleaseSummary, listGitHubReleaseSummaries } from "./github-release-summary";
import { type PreparedUpdateNotes, prepareUpdateNotes, textIdentity } from "./update-index";

const MAX_REQUEST = 2 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const branchRef = `refs/heads/${UPDATE_INDEX_BRANCH}`;
interface RemoteAsset {
	id: number;
	name: string;
	size: number;
	state: string;
	digest: string | null;
}
interface PublicRelease {
	id: number;
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	published_at: string;
}
function boundedRunner(signal?: AbortSignal): GhRunner {
	return (args) =>
		new Promise<string>((resolve, reject) => {
			signal?.throwIfAborted();
			const child = spawn("gh", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
			});
			const maximum = args.includes("Accept: application/octet-stream")
				? 64 * 1024
				: args[1] === "graphql"
					? 1024 * 1024
					: MAX_OUTPUT;
			const chunks: Buffer[] = [];
			let stdout = 0;
			let stderr = "";
			let stderrBytes = 0;
			let failure: Error | undefined;
			const stop = (error: Error) => {
				failure ??= error;
				child.kill("SIGKILL");
			};
			const timer = setTimeout(() => stop(new Error("Update index gh request timed out")), 30_000);
			const abort = () => stop(new Error("Update index publication aborted"));
			signal?.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.length;
				if (stdout > maximum) stop(new Error("Update index output limit"));
				else chunks.push(chunk);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stderrBytes > 64 * 1024) stop(new Error("Update index diagnostic limit"));
				else stderr += chunk.toString("utf8");
			});
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
			};
			child.on("error", (error) => {
				cleanup();
				reject(error);
			});
			child.on("close", (code) => {
				cleanup();
				if (failure || code !== 0)
					reject(failure ?? new Error(`gh failed: ${stderr.slice(0, 8192)}`));
				else {
					try {
						resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
					} catch (error) {
						reject(error);
					}
				}
			});
		});
}
function status(error: unknown, codes: number[]) {
	const e = error as { status?: number; stderr?: string | Buffer; message?: string };
	return (
		codes.includes(e.status ?? 0) ||
		codes.some((code) =>
			new RegExp(`(?:HTTP |status[:= ]+)${code}\\b`, "i").test(
				`${e.message ?? ""} ${e.stderr ?? ""}`,
			),
		)
	);
}
function assertSha(value: unknown): asserts value is string {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error("Invalid Git object SHA");
}
function validId(value: unknown): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0)
		throw new Error("Invalid Release asset ID");
}
function assertAsset(expected: UpdateIndexAsset, actual: RemoteAsset | undefined) {
	if (
		!actual ||
		actual.state !== "uploaded" ||
		actual.name !== expected.name ||
		actual.size !== expected.size ||
		actual.digest !== `sha256:${expected.sha256}`
	)
		throw new Error(`Public Release asset identity mismatch: ${expected.name}`);
}

function publicReleaseReader(repository: string, run: GhRunner) {
	const prefix = `repos/${repository}`;
	async function api(path: string, projection?: string): Promise<unknown> {
		return JSON.parse(
			await run(["api", `${prefix}/${path}`, ...(projection ? ["--jq", projection] : [])]),
		);
	}
	async function tagCommit(tag: string): Promise<string> {
		let result = (await api(`git/ref/tags/${encodeURIComponent(tag)}`)) as {
			ref: string;
			object: { type: string; sha: string };
		};
		if (result.ref !== `refs/tags/${tag}`) throw new Error("Release tag ref mismatch");
		for (let i = 0; i < 5; i++) {
			assertSha(result.object.sha);
			if (result.object.type === "commit") return result.object.sha;
			if (result.object.type !== "tag") throw new Error("Release tag is not a commit");
			result = (await api(`git/tags/${result.object.sha}`)) as typeof result;
		}
		throw new Error("Release annotated tag depth exceeded");
	}
	async function publicRelease(tag: string): Promise<PublicRelease> {
		const result = (await api(
			`releases/tags/${encodeURIComponent(tag)}`,
			"{id,tag_name,draft,prerelease,published_at}",
		)) as PublicRelease;
		validId(result.id);
		if (
			result.tag_name !== tag ||
			result.draft !== false ||
			typeof result.prerelease !== "boolean" ||
			typeof result.published_at !== "string"
		)
			throw new Error("Update index requires a public Release");
		return result;
	}
	async function assets(id: number): Promise<Map<string, RemoteAsset>> {
		const result = new Map<string, RemoteAsset>();
		for (let page = 1; page <= 3; page++) {
			const entries = (await api(
				`releases/${id}/assets?per_page=100&page=${page}`,
				"map({id,name,size,state,digest})",
			)) as RemoteAsset[];
			if (!Array.isArray(entries) || entries.length > 100)
				throw new Error("Invalid Release assets page");
			for (const entry of entries) {
				validId(entry.id);
				if (typeof entry.name !== "string" || entry.name.length > 512 || result.has(entry.name))
					throw new Error("Duplicate/invalid Release asset");
				result.set(entry.name, entry);
				if (result.size > 200) throw new Error("Release asset count exceeded");
			}
			if (entries.length < 100) return result;
		}
		throw new Error("Release assets pagination truncated");
	}
	async function sidecar(
		asset: RemoteAsset,
	): Promise<{ raw: string; value: Record<string, unknown> }> {
		if (
			asset.state !== "uploaded" ||
			!Number.isSafeInteger(asset.size) ||
			asset.size <= 0 ||
			asset.size > 64 * 1024
		)
			throw new Error("Invalid Release sidecar");
		const raw = await run([
			"api",
			`${prefix}/releases/assets/${asset.id}`,
			"-H",
			"Accept: application/octet-stream",
		]);
		const identity = textIdentity(raw);
		if (
			identity.size !== asset.size ||
			(asset.digest && asset.digest !== `sha256:${identity.sha256}`)
		)
			throw new Error("Release sidecar hash mismatch");
		return { raw, value: JSON.parse(raw) };
	}
	function checkBinaryMetadata(
		meta: Record<string, unknown>,
		file: UpdateIndexRelease["files"][number],
		record: UpdateIndexRelease,
	) {
		if (
			meta.name !== file.name ||
			meta.version !== record.version ||
			meta.platform !== file.platform ||
			meta.target !== `bun-${file.platform.replace(/^win-/, "windows-")}` ||
			typeof meta.commit !== "string" ||
			!/^[a-f0-9]{7,40}$/.test(meta.commit) ||
			!record.commit.startsWith(meta.commit) ||
			meta.size !== file.size ||
			meta.sha256 !== file.sha256 ||
			meta.sha512 !== file.sha512 ||
			(meta.repository !== undefined &&
				(typeof meta.repository !== "string" || meta.repository.toLowerCase() !== repository))
		)
			throw new Error("Public binary sidecar identity mismatch");
	}
	async function verify(record: UpdateIndexRelease): Promise<UpdateIndexRelease> {
		const remote = await publicRelease(record.tag);
		if ((await tagCommit(record.tag)) !== record.commit)
			throw new Error("Public Release tag commit mismatch");
		const available = await assets(remote.id);
		for (const file of record.files) {
			assertAsset(file, available.get(file.name));
			const metadata = available.get(file.metadata.name);
			if (!metadata) throw new Error("Missing public binary sidecar");
			const decoded = await sidecar(metadata);
			if (
				decoded.raw.length > 64 * 1024 ||
				textIdentity(decoded.raw).sha256 !== file.metadata.sha256 ||
				metadata.size !== file.metadata.size
			)
				throw new Error("Binary sidecar identity mismatch");
			checkBinaryMetadata(decoded.value, file, record);
			for (const patch of file.patches) {
				assertAsset(patch, available.get(patch.name));
				const metadata = available.get(patch.metadata.name);
				if (!metadata) throw new Error("Missing public patch sidecar");
				const decoded = await sidecar(metadata);
				if (
					textIdentity(decoded.raw).sha256 !== patch.metadata.sha256 ||
					metadata.size !== patch.metadata.size
				)
					throw new Error("Patch sidecar identity mismatch");
				validateReleasePatchMetadata(decoded.value, {
					fromVersion: patch.fromVersion,
					toVersion: record.version,
					patchSize: patch.size,
					newFileSize: file.size,
					newFileSha512: file.sha512,
				});
			}
		}
		return parseUpdateIndexRelease({
			...record,
			prerelease: remote.prerelease,
			publishedAt: remote.published_at,
		});
	}
	async function historical(summary: GitHubReleaseSummary): Promise<UpdateIndexRelease> {
		const tag = summary.tagName;
		const remote = await publicRelease(tag);
		if (
			remote.id !== summary.id ||
			remote.prerelease !== summary.prerelease ||
			remote.published_at !== summary.publishedAt
		)
			throw new Error("Bootstrap Release changed after summary discovery");
		const commit = await tagCommit(tag);
		const version = tag.slice(1);
		const available = await assets(remote.id);
		if (available.size !== summary.assetCount)
			throw new Error("Bootstrap Release asset count changed");
		const files: UpdateIndexRelease["files"] = [];
		for (const [platform, suffix] of Object.entries(UPDATE_INDEX_PLATFORMS)) {
			const name = `narrafork-${version}-${suffix}`;
			const binary = available.get(name);
			const metadata = available.get(`${name}.metadata.json`);
			if (!binary && !metadata) continue;
			if (!binary || !metadata) throw new Error("Cannot bootstrap unpaired public binary");
			const decoded = await sidecar(metadata);
			const file = {
				name,
				platform,
				size: binary.size,
				sha256: decoded.value.sha256 as string,
				sha512: decoded.value.sha512 as string,
				metadata: { name: metadata.name, ...textIdentity(decoded.raw) },
				patches: [],
			};
			assertAsset(file, binary);
			files.push(file);
			checkBinaryMetadata(decoded.value, file, { version, commit } as UpdateIndexRelease);
		}
		return parseUpdateIndexRelease({
			version,
			tag,
			commit,
			prerelease: remote.prerelease,
			publishedAt: remote.published_at,
			files,
		});
	}
	return { verify, historical, publicRelease, tagCommit, assets, sidecar, checkBinaryMetadata };
}

/** Repair reads already-published bytes; it never builds, uploads or mutates a Release. */
export async function preparePublishedUpdateIndexRelease(options: {
	repository: string;
	version: string;
	commit: string;
	changelog?: string | Record<string, string>;
	run?: GhRunner;
	signal?: AbortSignal;
}): Promise<{ release: UpdateIndexRelease; notes?: PreparedUpdateNotes }> {
	if (
		!isValidGitHubRepository(options.repository) ||
		!isValidReleaseVersion(options.version) ||
		!SHA.test(options.commit)
	)
		throw new Error("Invalid public Release repair identity");
	const repository = options.repository.toLowerCase();
	const notes =
		options.changelog === undefined ? undefined : prepareUpdateNotes({ ...options, repository });
	const signal = AbortSignal.any([
		AbortSignal.timeout(5 * 60_000),
		...(options.signal ? [options.signal] : []),
	]);
	const rawRun = options.run ?? boundedRunner(signal);
	const run: GhRunner = async (args) => {
		signal.throwIfAborted();
		const result = await rawRun(args);
		signal.throwIfAborted();
		if (
			Buffer.byteLength(result) >
			(args.includes("Accept: application/octet-stream") ? 64 * 1024 : MAX_OUTPUT)
		)
			throw new Error("Public Release repair output limit");
		return result;
	};
	const reader = publicReleaseReader(repository, run);
	const tag = `v${options.version}`;
	const remote = await reader.publicRelease(tag);
	if ((await reader.tagCommit(tag)) !== options.commit)
		throw new Error("Public Release repair tag commit mismatch");
	const available = await reader.assets(remote.id);
	const release = await reader.historical({
		id: remote.id,
		tagName: tag,
		draft: false,
		prerelease: remote.prerelease,
		publishedAt: remote.published_at,
		assetCount: available.size,
	});
	if (release.commit !== options.commit)
		throw new Error("Public Release repair tag changed during verification");
	let pairs = 0;
	for (const file of release.files) {
		const names = new Set(
			[...available.keys()]
				.filter(
					(name) =>
						name.startsWith(`${file.name}.from-`) || name.startsWith(`${file.name}.zstd-patch`),
				)
				.map((name) => (name.endsWith(".meta.json") ? name.slice(0, -10) : name)),
		);
		pairs += names.size;
		if (pairs > 64) throw new Error("Public Release repair patch pair limit");
		for (const name of names) {
			const parsed = parseReleasePatchName(file.name, name);
			const binary = available.get(name);
			const metadata = available.get(`${name}.meta.json`);
			if (!parsed || !binary || !metadata || !binary.digest?.startsWith("sha256:"))
				throw new Error("Invalid/unpaired public repair patch");
			const decoded = await reader.sidecar(metadata);
			const meta = validateReleasePatchMetadata(decoded.value, {
				...parsed,
				toVersion: release.version,
				patchSize: binary.size,
				newFileSize: file.size,
				newFileSha512: file.sha512,
			});
			const patch = {
				name,
				size: binary.size,
				sha256: binary.digest.slice(7),
				fromVersion: meta.fromVersion,
				metadata: { name: metadata.name, ...textIdentity(decoded.raw) },
			};
			assertAsset(patch, binary);
			file.patches.push(patch);
		}
	}
	if (notes) {
		const raw = await run([
			"api",
			`repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
			"--jq",
			"{body}",
		]);
		const body = JSON.parse(raw).body;
		if (
			typeof body !== "string" ||
			Buffer.byteLength(body) > MAX_UPDATE_NOTES_BYTES ||
			body !== githubReleaseBody(options.changelog)
		)
			throw new Error("Public Release repair changelog does not match published body");
		release.notes = { path: notes.path, size: notes.size, sha256: notes.sha256 };
	}
	return { release: parseUpdateIndexRelease(release), ...(notes ? { notes } : {}) };
}

/** The only remote write target is the fixed generated-data ref, never source refs/tags. */
export async function publishUpdateIndex(options: {
	repository: string;
	release: UpdateIndexRelease;
	notes?: PreparedUpdateNotes;
	run?: GhRunner;
	signal?: AbortSignal;
}): Promise<{ commit: string; generation: number; unchanged: boolean }> {
	if (!isValidGitHubRepository(options.repository)) throw new Error("Invalid GitHub repository");
	const repository = options.repository.toLowerCase();
	const release = parseUpdateIndexRelease(options.release);
	const notes = options.notes;
	if (Boolean(notes) !== Boolean(release.notes)) throw new Error("Update notes identity mismatch");
	if (notes) {
		const noteIdentity = textIdentity(notes.content);
		if (
			!release.notes ||
			notes.path !== release.notes.path ||
			notes.size !== noteIdentity.size ||
			notes.sha256 !== noteIdentity.sha256 ||
			notes.size !== release.notes.size ||
			notes.sha256 !== release.notes.sha256 ||
			notes.size > MAX_UPDATE_NOTES_BYTES
		)
			throw new Error("Update notes identity mismatch");
		parseUpdateNotes(JSON.parse(notes.content), repository, release.version);
	}
	const signal = AbortSignal.any([
		AbortSignal.timeout(5 * 60_000),
		...(options.signal ? [options.signal] : []),
	]);
	const rawRun = options.run ?? boundedRunner(signal);
	const run: GhRunner = async (args) => {
		signal.throwIfAborted();
		const result = await rawRun(args);
		signal.throwIfAborted();
		const maximum = args.includes("Accept: application/octet-stream")
			? 64 * 1024
			: args[1] === "graphql"
				? 1024 * 1024
				: MAX_OUTPUT;
		if (Buffer.byteLength(result) > maximum) throw new Error("Update index output limit");
		return result;
	};
	const prefix = `repos/${repository}`;
	async function api(path: string, projection?: string): Promise<unknown> {
		return JSON.parse(
			await run(["api", `${prefix}/${path}`, ...(projection ? ["--jq", projection] : [])]),
		);
	}
	async function verifyRepositoryTarget(): Promise<void> {
		const metadata = JSON.parse(
			await run(["api", prefix, "--jq", "{full_name,default_branch}"]),
		) as { full_name?: unknown; default_branch?: unknown };
		if (
			!isValidGitHubRepository(metadata.full_name) ||
			metadata.full_name.toLowerCase() !== repository
		)
			throw new Error("Update index repository identity mismatch");
		if (
			typeof metadata.default_branch !== "string" ||
			!metadata.default_branch ||
			metadata.default_branch === UPDATE_INDEX_BRANCH
		)
			throw new Error("Refusing to publish update index to repository default branch");
	}
	async function write(
		path: string,
		method: string,
		body: unknown,
	): Promise<Record<string, unknown>> {
		// A rename during blob creation must not turn the final ref update into a source write.
		if (path === "git/refs" || path === `git/refs/heads/${UPDATE_INDEX_BRANCH}`)
			await verifyRepositoryTarget();
		const content = JSON.stringify(body);
		if (Buffer.byteLength(content) > MAX_REQUEST)
			throw new Error("Update index request byte limit");
		signal.throwIfAborted();
		const directory = await mkdtemp(join(tmpdir(), "narrafork-update-index-"));
		try {
			const input = join(directory, "request.json");
			await writeFile(input, content, { flag: "wx", mode: 0o600 });
			return JSON.parse(
				await run(["api", `${prefix}/${path}`, "--method", method, "--input", input]),
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
	async function ref(): Promise<string | null> {
		try {
			const result = (await api(`git/ref/heads/${UPDATE_INDEX_BRANCH}`)) as {
				ref: string;
				object: { type: string; sha: string };
			};
			if (result.ref !== branchRef || result.object.type !== "commit")
				throw new Error("Invalid metadata branch ref");
			assertSha(result.object.sha);
			return result.object.sha;
		} catch (error) {
			if (status(error, [404])) return null;
			throw error;
		}
	}
	async function readFile(path: string, commit: string, maximum: number): Promise<string | null> {
		assertSha(commit);
		try {
			// Base64 wrapping would inflate valid 1 MiB notes beyond callers' 1 MiB gh budget.
			if (path.startsWith("notes/")) {
				const content = await run([
					"api",
					`${prefix}/contents/${path}?ref=${commit}`,
					"-H",
					"Accept: application/vnd.github.raw+json",
				]);
				if (!content || Buffer.byteLength(content) > maximum)
					throw new Error("Metadata notes readback byte limit");
				return content;
			}
			const file = (await api(
				`contents/${path}?ref=${commit}`,
				"{type,path,size,encoding,content}",
			)) as { type: string; path: string; size: number; encoding: string; content: string };
			if (
				file.type !== "file" ||
				file.path !== path ||
				file.encoding !== "base64" ||
				!Number.isSafeInteger(file.size) ||
				file.size <= 0 ||
				file.size > maximum ||
				typeof file.content !== "string" ||
				file.content.length > Math.ceil(maximum / 3) * 4 + Math.ceil(maximum / 40)
			)
				throw new Error(`Invalid metadata branch file: ${path}`);
			const bytes = Buffer.from(file.content.replace(/\n/g, ""), "base64");
			if (bytes.length !== file.size) throw new Error("Metadata branch file size mismatch");
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			if (status(error, [404])) return null;
			throw error;
		}
	}
	const { verify, historical } = publicReleaseReader(repository, run);
	const current = await verify(release);
	let bootstrap: UpdateIndexRelease[] | undefined;
	async function initial(): Promise<UpdateIndexV1> {
		if (!bootstrap) {
			const summaries = (await listGitHubReleaseSummaries(run, repository))
				.filter(
					(r) => !r.draft && r.tagName.startsWith("v") && isValidReleaseVersion(r.tagName.slice(1)),
				)
				.sort((a, b) => compareReleaseVersions(b.tagName.slice(1), a.tagName.slice(1)));
			const incomingSummary = summaries.find((entry) => entry.tagName === current.tag);
			if (
				incomingSummary &&
				(incomingSummary.prerelease !== current.prerelease ||
					incomingSummary.publishedAt !== current.publishedAt)
			)
				throw new Error("Incoming Release changed during bootstrap discovery");
			const selected = new Set([summaries[0], summaries.find((r) => !r.prerelease)]);
			bootstrap = [];
			for (const summary of selected)
				if (summary && summary.tagName !== current.tag) bootstrap.push(await historical(summary));
		}
		let index: UpdateIndexV1 | null = null;
		for (const entry of bootstrap) index = mergeUpdateIndex(index, entry, repository);
		// Bootstrap assembles several records, but publishes one catalog generation.
		return { ...mergeUpdateIndex(index, current, repository), generation: 1 };
	}
	async function blob(content: string): Promise<string> {
		const result = await write("git/blobs", "POST", { content, encoding: "utf-8" });
		assertSha(result.sha);
		return result.sha;
	}
	for (let attempt = 0; attempt < 3; attempt++) {
		await verifyRepositoryTarget();
		const head = await ref();
		let tree: string | undefined;
		let before: UpdateIndexV1 | null = null;
		if (head) {
			const commit = (await api(`git/commits/${head}`)) as { sha: string; tree: { sha: string } };
			if (commit.sha !== head) throw new Error("Metadata branch commit mismatch");
			assertSha(commit.tree.sha);
			tree = commit.tree.sha;
			const raw = await readFile(UPDATE_INDEX_FILE, head, MAX_UPDATE_INDEX_BYTES);
			if (!raw) throw new Error("Existing metadata branch has no index; refusing overwrite");
			before = parseUpdateIndex(JSON.parse(raw), repository);
		}
		const priorNotes = before?.releases.find((entry) => entry.version === current.version)?.notes;
		const incoming = !current.notes && priorNotes ? { ...current, notes: priorNotes } : current;
		const index = before ? mergeUpdateIndex(before, incoming, repository) : await initial();
		const oldNotes =
			head && notes ? await readFile(notes.path, head, MAX_UPDATE_NOTES_BYTES) : null;
		if (notes && oldNotes !== null && oldNotes !== notes.content)
			throw new Error("Content-addressed notes path already contains different bytes");
		if (head && before && index.generation === before.generation) {
			if (
				notes &&
				oldNotes === null &&
				index.releases.some((entry) => entry.version === current.version)
			)
				throw new Error("Existing index notes are missing");
			return { commit: head, generation: index.generation, unchanged: true };
		}
		const content = JSON.stringify(index);
		const entries = [
			{ path: UPDATE_INDEX_FILE, mode: "100644", type: "blob", sha: await blob(content) },
		];
		if (notes && oldNotes === null)
			entries.push({
				path: notes.path,
				mode: "100644",
				type: "blob",
				sha: await blob(notes.content),
			});
		const createdTree = await write("git/trees", "POST", {
			...(tree ? { base_tree: tree } : {}),
			tree: entries,
		});
		assertSha(createdTree.sha);
		const createdCommit = await write("git/commits", "POST", {
			message: `Update generated release index: ${current.tag}`,
			tree: createdTree.sha,
			parents: head ? [head] : [],
		});
		assertSha(createdCommit.sha);
		try {
			if (head)
				await write(`git/refs/heads/${UPDATE_INDEX_BRANCH}`, "PATCH", {
					sha: createdCommit.sha,
					force: false,
				});
			else await write("git/refs", "POST", { ref: branchRef, sha: createdCommit.sha });
		} catch (error) {
			if (status(error, [409, 422]) && attempt < 2) continue;
			throw error;
		}
		const committed = (await api(`git/commits/${createdCommit.sha}`, "{sha,tree,parents}")) as {
			sha: string;
			tree: { sha: string };
			parents: { sha: string }[];
		};
		if (
			committed.sha !== createdCommit.sha ||
			committed.tree.sha !== createdTree.sha ||
			!Array.isArray(committed.parents) ||
			JSON.stringify(committed.parents.map((parent) => parent.sha)) !==
				JSON.stringify(head ? [head] : [])
		)
			throw new Error("Published metadata commit readback mismatch");
		const readback = await readFile(UPDATE_INDEX_FILE, createdCommit.sha, MAX_UPDATE_INDEX_BYTES);
		if (
			!readback ||
			JSON.stringify(parseUpdateIndex(JSON.parse(readback), repository)) !== JSON.stringify(index)
		)
			throw new Error("Published update index readback mismatch");
		if (
			notes &&
			(await readFile(notes.path, createdCommit.sha, MAX_UPDATE_NOTES_BYTES)) !== notes.content
		)
			throw new Error("Published notes readback mismatch");
		if ((await ref()) !== createdCommit.sha)
			throw new Error("Metadata branch changed during readback; retry index-only repair");
		return { commit: createdCommit.sha, generation: index.generation, unchanged: false };
	}
	throw new Error("Update index ref conflict retry budget exceeded");
}
