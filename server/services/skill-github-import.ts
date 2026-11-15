import { AppError, ValidationError } from "@server/lib/errors";
import { outboundFetch } from "@server/lib/net/outbound-fetch";

export interface DownloadedSkillFile {
	path: string;
	bytes: Uint8Array;
	executable?: boolean;
}

export const GITHUB_SKILL_IMPORT_LIMITS = Object.freeze({
	urlLength: 2048,
	metadataBytes: 1024 * 1024,
	skillBytes: 200_000,
	fileBytes: 1024 * 1024,
	files: 100,
	entries: 512,
	totalBytes: 10 * 1024 * 1024,
	depth: 8,
	refAttempts: 16,
	concurrency: 4,
	pathLength: 2048,
	segmentBytes: 255,
});

interface GitHubSkillLocation {
	owner: string;
	repo: string;
	refAndPath: string[];
}

interface GitTreeEntry {
	path: string;
	sha: string;
	type: "blob" | "tree" | "commit";
	mode: "100644" | "100755" | "040000" | "120000" | "160000";
	size?: number;
}

interface GitTree {
	sha: string;
	entries: GitTreeEntry[];
}

const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)$/i;
const encoder = new TextEncoder();

function invalidMetadata(): ValidationError {
	return new ValidationError("GitHub returned invalid skill metadata.", "SKILL_GITHUB_METADATA");
}

function aborted(): AppError {
	return new AppError(
		"GitHub skill import was cancelled or timed out.",
		408,
		"SKILL_GITHUB_ABORTED",
	);
}

function checkAbort(signal: AbortSignal): void {
	if (signal.aborted) throw aborted();
}

/** Check before URL normalization: URL() would silently remove encoded dot segments. */
export function parseGitHubSkillUrl(value: string): GitHubSkillLocation {
	const invalid = () =>
		new ValidationError(
			"Use a public https://github.com/owner/repo/tree/ref/directory URL.",
			"SKILL_GITHUB_URL",
		);
	if (
		typeof value !== "string" ||
		value.length > GITHUB_SKILL_IMPORT_LIMITS.urlLength ||
		/[\s\\?#]/u.test(value)
	) {
		throw invalid();
	}
	// Matching the authority ourselves also rejects an explicit default :443 port.
	const match = /^https:\/\/github\.com\/(.+)$/i.exec(value);
	if (!match) throw invalid();
	const rawSegments = match[1].replace(/\/$/, "").split("/");
	let segments: string[];
	try {
		segments = rawSegments.map((segment) => decodeURIComponent(segment));
	} catch {
		throw invalid();
	}
	if (
		segments.length < 4 ||
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				/[\p{Cc}\p{Cs}/\\]/u.test(segment) ||
				/%(?:2e|2f|5c|25)/i.test(segment),
		) ||
		!/[a-z0-9]/i.test(segments[0]) ||
		!/^[a-z0-9-]{1,39}$/i.test(segments[0]) ||
		!/^[a-z0-9_.-]{1,100}$/i.test(segments[1]) ||
		segments[2] !== "tree" ||
		segments.length - 3 > GITHUB_SKILL_IMPORT_LIMITS.refAttempts
	) {
		throw invalid();
	}
	return { owner: segments[0], repo: segments[1], refAndPath: segments.slice(3) };
}

/** Portable relative paths only; call again immediately before writing imported files. */
export function validateImportedSkillPath(path: string): void {
	const invalid = () =>
		new ValidationError("The skill contains an unsafe or unsupported path.", "SKILL_GITHUB_PATH");
	if (
		typeof path !== "string" ||
		!path ||
		path.length > GITHUB_SKILL_IMPORT_LIMITS.pathLength ||
		/[\p{Cc}\p{Cs}<>:"|?*\\]/u.test(path)
	) {
		throw invalid();
	}
	const segments = path.split("/");
	if (segments.length > GITHUB_SKILL_IMPORT_LIMITS.depth) {
		throw new ValidationError("The skill exceeds the path depth limit of 8.", "SKILL_GITHUB_LIMIT");
	}
	for (const segment of segments) {
		const basename = segment.split(".", 1)[0].replace(/[ .]+$/, "");
		if (
			!segment ||
			segment === "." ||
			segment === ".." ||
			/[ .]$/.test(segment) ||
			encoder.encode(segment).byteLength > GITHUB_SKILL_IMPORT_LIMITS.segmentBytes ||
			WINDOWS_RESERVED.test(basename)
		) {
			throw invalid();
		}
	}
}

function discardResponse(response: Response): void {
	// Cleanup must not inherit a stalled transport's cancellation promise.
	try {
		void response.body?.cancel().catch(() => {});
	} catch {
		// A non-conforming transport may already have locked/closed the stream.
	}
}

/** Race even test/custom transports which ignore AbortSignal; dispose late responses. */
function withAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
	disposeLate?: (value: T) => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(aborted());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		promise.then(
			(value) => {
				if (settled) {
					disposeLate?.(value);
					return;
				}
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

async function requestGitHub(
	location: GitHubSkillLocation,
	resource: string,
	signal: AbortSignal,
	raw = false,
	allowMissing = false,
): Promise<Response | null> {
	checkAbort(signal);
	try {
		const response = await withAbort(
			outboundFetch(
				`https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}/git/${resource}`,
				{
					signal,
					redirect: "manual",
					credentials: "omit",
					headers: {
						Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
						"User-Agent": "NarraFork-Skill-Import",
						"X-GitHub-Api-Version": "2022-11-28",
					},
				},
				{ retryPolicy: "never" },
			),
			signal,
			discardResponse,
		);
		if (signal.aborted) {
			discardResponse(response);
			throw aborted();
		}
		if (response.status === 200 && !response.redirected) return response;
		discardResponse(response);
		if (response.redirected || (response.status >= 300 && response.status < 400)) {
			throw new ValidationError("GitHub redirects are not allowed.", "SKILL_GITHUB_REDIRECT");
		}
		if (response.status === 403 || response.status === 429) {
			throw new AppError(
				"GitHub's public API rate limit was reached or access was denied. Try again later.",
				429,
				"SKILL_GITHUB_RATE_LIMITED",
			);
		}
		if (response.status === 404) {
			if (allowMissing) return null;
			throw new AppError(
				"The GitHub skill resource was not found. Only public repositories are supported.",
				404,
				"SKILL_GITHUB_NOT_FOUND",
			);
		}
		throw new AppError("GitHub could not provide the skill resource.", 502, "SKILL_GITHUB_REQUEST");
	} catch (error) {
		if (signal.aborted) throw aborted();
		if (error instanceof AppError) throw error;
		throw new AppError("Unable to download the skill from GitHub.", 502, "SKILL_GITHUB_REQUEST");
	}
}

async function readLimitedBody(
	response: Response,
	limit: number,
	signal: AbortSignal,
	expectedBytes?: number,
): Promise<Uint8Array> {
	if (signal.aborted) {
		discardResponse(response);
		throw aborted();
	}
	const tooLarge = () =>
		new ValidationError("The GitHub response exceeds the byte limit.", "SKILL_GITHUB_LIMIT");
	const length = response.headers.get("content-length");
	if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
		discardResponse(response);
		throw invalidMetadata();
	}
	if (length !== null && Number(length) > limit) {
		discardResponse(response);
		throw tooLarge();
	}
	if (!response.body) {
		if (expectedBytes !== undefined && expectedBytes !== 0) throw invalidMetadata();
		return new Uint8Array();
	}
	const reader = response.body.getReader();
	let cancelled = false;
	const cancel = () => {
		if (cancelled) return;
		cancelled = true;
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	// One bounded buffer, not one retained object per potentially one-byte chunk.
	const buffer = new Uint8Array(expectedBytes ?? limit);
	let offset = 0;
	let completed = false;
	try {
		while (true) {
			checkAbort(signal);
			const { done, value } = await withAbort(reader.read(), signal);
			checkAbort(signal);
			if (done) {
				completed = true;
				break;
			}
			if (!(value instanceof Uint8Array)) throw invalidMetadata();
			if (offset + value.byteLength > limit) throw tooLarge();
			if (offset + value.byteLength > buffer.byteLength) throw invalidMetadata();
			buffer.set(value, offset);
			offset += value.byteLength;
		}
		if (expectedBytes !== undefined && offset !== expectedBytes) throw invalidMetadata();
		return offset === buffer.byteLength ? buffer : buffer.slice(0, offset);
	} catch (error) {
		if (signal.aborted) throw aborted();
		if (error instanceof AppError) throw error;
		throw new AppError("Unable to read the GitHub response.", 502, "SKILL_GITHUB_REQUEST");
	} finally {
		signal.removeEventListener("abort", cancel);
		if (!completed) cancel();
		reader.releaseLock();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTree(value: unknown, recursive: boolean, expectedSha?: string): GitTree {
	if (
		!isRecord(value) ||
		typeof value.sha !== "string" ||
		!SHA_PATTERN.test(value.sha) ||
		(expectedSha !== undefined && value.sha.toLowerCase() !== expectedSha) ||
		value.truncated !== false ||
		!Array.isArray(value.tree)
	) {
		throw invalidMetadata();
	}
	if (value.tree.length > GITHUB_SKILL_IMPORT_LIMITS.entries) {
		throw new ValidationError("The GitHub tree exceeds the 512-entry limit.", "SKILL_GITHUB_LIMIT");
	}
	const entries: GitTreeEntry[] = [];
	const sourceNames = new Set<string>();
	const paths = new Map<string, { path: string; type: "tree" | "blob"; explicit: boolean }>();
	for (const entry of value.tree) {
		if (
			!isRecord(entry) ||
			typeof entry.path !== "string" ||
			typeof entry.sha !== "string" ||
			!SHA_PATTERN.test(entry.sha) ||
			!(
				(entry.type === "tree" && entry.mode === "040000") ||
				(entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")) ||
				(!recursive && entry.type === "blob" && entry.mode === "120000") ||
				(!recursive && entry.type === "commit" && entry.mode === "160000")
			) ||
			(entry.type === "blob" &&
				(!Number.isSafeInteger(entry.size) || (entry.size as number) < 0)) ||
			(entry.size !== undefined &&
				(!Number.isSafeInteger(entry.size) || (entry.size as number) < 0))
		) {
			throw invalidMetadata();
		}
		if (!recursive) {
			// Ancestors are navigation metadata, not imported files. Unrelated Git names,
			// symlinks and submodules must not apply the target's portable-path policy.
			if (
				!entry.path ||
				entry.path === "." ||
				entry.path === ".." ||
				entry.path.includes("/") ||
				entry.path.includes("\0") ||
				sourceNames.has(entry.path)
			) {
				throw invalidMetadata();
			}
			sourceNames.add(entry.path);
		} else {
			validateImportedSkillPath(entry.path);
			const segments = entry.path.split("/");
			if ([".narrafork-source.json", "skill.md.disabled"].includes(segments[0].toLowerCase())) {
				throw new ValidationError(
					"The skill contains a reserved local metadata file.",
					"SKILL_GITHUB_PATH",
				);
			}
			for (let depth = 1; depth <= segments.length; depth++) {
				const path = segments.slice(0, depth).join("/");
				const key = path.normalize("NFC").toUpperCase().toLowerCase();
				const explicit = depth === segments.length;
				const type = explicit ? (entry.type as "tree" | "blob") : "tree";
				const existing = paths.get(key);
				if (
					existing &&
					(existing.path !== path || existing.type !== type || (existing.explicit && explicit))
				) {
					throw new ValidationError(
						"The skill contains duplicate or conflicting file and directory paths.",
						"SKILL_GITHUB_PATH",
					);
				}
				paths.set(key, { path, type, explicit: explicit || existing?.explicit === true });
			}
		}
		entries.push({
			path: entry.path,
			sha: entry.sha.toLowerCase(),
			type: entry.type as GitTreeEntry["type"],
			mode: entry.mode as GitTreeEntry["mode"],
			size: entry.size as number | undefined,
		});
	}
	// A recursive tree must include its parents; never invent missing metadata.
	if ([...paths.values()].some((path) => !path.explicit)) throw invalidMetadata();
	return { sha: value.sha.toLowerCase(), entries };
}

async function loadTree(
	location: GitHubSkillLocation,
	ref: string,
	signal: AbortSignal,
	options: { recursive?: boolean; allowMissing?: boolean; expectedSha?: string } = {},
): Promise<GitTree | null> {
	const response = await requestGitHub(
		location,
		`trees/${encodeURIComponent(ref)}${options.recursive ? "?recursive=1" : ""}`,
		signal,
		false,
		options.allowMissing,
	);
	if (!response) return null;
	const bytes = await readLimitedBody(response, GITHUB_SKILL_IMPORT_LIMITS.metadataBytes, signal);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw invalidMetadata();
	}
	return validateTree(value, options.recursive === true, options.expectedSha);
}

async function locateSkillTree(
	location: GitHubSkillLocation,
	signal: AbortSignal,
): Promise<GitTree> {
	const { refAndPath } = location;
	for (let length = refAndPath.length; length >= 1; length--) {
		let tree = await loadTree(location, refAndPath.slice(0, length).join("/"), signal, {
			allowMissing: true,
		});
		if (!tree) continue; // Only a 404 may try a shorter ref prefix.
		const directory = refAndPath.slice(length);
		if (directory.length) validateImportedSkillPath(directory.join("/"));
		let sha = tree.sha;
		for (let index = 0; index < directory.length; index++) {
			const entry = tree.entries.find((entry) => entry.path === directory[index]);
			if (!entry) {
				throw new AppError(
					"The GitHub skill directory was not found.",
					404,
					"SKILL_GITHUB_NOT_FOUND",
				);
			}
			if (entry.type !== "tree") {
				throw new ValidationError(
					"The GitHub skill URL must select a directory.",
					"SKILL_GITHUB_URL",
				);
			}
			sha = entry.sha;
			if (index < directory.length - 1) {
				tree = (await loadTree(location, sha, signal, { expectedSha: sha })) as GitTree;
			}
		}
		return (await loadTree(location, sha, signal, {
			recursive: true,
			expectedSha: sha,
		})) as GitTree;
	}
	throw new AppError(
		"The GitHub repository or ref was not found. Only public repositories are supported.",
		404,
		"SKILL_GITHUB_NOT_FOUND",
	);
}

function collectFiles(tree: GitTree): (GitTreeEntry & { size: number })[] {
	const files = tree.entries.filter((entry) => entry.type === "blob") as (GitTreeEntry & {
		size: number;
	})[];
	if (!files.some((file) => file.path === "SKILL.md")) {
		throw new ValidationError(
			"The selected directory must contain SKILL.md.",
			"SKILL_GITHUB_SKILL_MISSING",
		);
	}
	if (files.length > GITHUB_SKILL_IMPORT_LIMITS.files) {
		throw new ValidationError("The skill exceeds the 100-file limit.", "SKILL_GITHUB_LIMIT");
	}
	let total = 0;
	for (const file of files) {
		const limit =
			file.path === "SKILL.md"
				? GITHUB_SKILL_IMPORT_LIMITS.skillBytes
				: GITHUB_SKILL_IMPORT_LIMITS.fileBytes;
		if (file.size > limit) {
			throw new ValidationError("A skill file exceeds the byte limit.", "SKILL_GITHUB_LIMIT");
		}
		total += file.size;
		if (total > GITHUB_SKILL_IMPORT_LIMITS.totalBytes) {
			throw new ValidationError(
				"The skill exceeds the 10 MiB total byte limit.",
				"SKILL_GITHUB_LIMIT",
			);
		}
	}
	return files;
}

/** The owning service supplies the 45-second deadline and two-import admission budget. */
export async function downloadGitHubSkill(
	url: string,
	signal: AbortSignal,
): Promise<DownloadedSkillFile[]> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		checkAbort(controller.signal);
		const location = parseGitHubSkillUrl(url);
		const files = collectFiles(await locateSkillTree(location, controller.signal));
		const results = new Array<DownloadedSkillFile>(files.length);
		let cursor = 0;
		let failed = false;
		let failure: unknown;
		const worker = async () => {
			while (!failed && !controller.signal.aborted) {
				const index = cursor++;
				const file = files[index];
				if (!file) return;
				try {
					const response = (await requestGitHub(
						location,
						`blobs/${file.sha}`,
						controller.signal,
						true,
					)) as Response;
					const limit =
						file.path === "SKILL.md"
							? GITHUB_SKILL_IMPORT_LIMITS.skillBytes
							: GITHUB_SKILL_IMPORT_LIMITS.fileBytes;
					results[index] = {
						path: file.path,
						bytes: await readLimitedBody(response, limit, controller.signal, file.size),
						executable: file.mode === "100755",
					};
				} catch (error) {
					if (!failed) {
						failed = true;
						failure = error;
						controller.abort();
					}
					return;
				}
			}
		};
		await Promise.all(
			Array.from(
				{ length: Math.min(files.length, GITHUB_SKILL_IMPORT_LIMITS.concurrency) },
				worker,
			),
		);
		if (failed) throw failure;
		checkAbort(controller.signal);
		return results;
	} finally {
		signal.removeEventListener("abort", onAbort);
		controller.abort();
	}
}
