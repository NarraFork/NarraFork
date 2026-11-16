import { afterEach, describe, expect, test } from "bun:test";
import { AppError, ValidationError } from "@server/lib/errors";
import { setOutboundFetchOverrideForTest } from "@server/lib/net/outbound-fetch";
import {
	downloadGitHubSkill,
	GITHUB_SKILL_IMPORT_LIMITS as limits,
	parseGitHubSkillUrl,
	validateImportedSkillPath,
} from "../skill-github-import";

const source = "https://github.com/owner/repo/tree/main/my-skill";
const rootSha = "a".repeat(40);
const targetSha = "b".repeat(40);
const middleSha = "c".repeat(40);
const blobSha = (index: number) => (index + 100).toString(16).padStart(40, "0");
const content = new TextEncoder().encode("---\nname: demo\n---\nSkill instructions\n");
const noSignal = () => new AbortController().signal;

interface FixtureFile {
	path: string;
	bytes: Uint8Array;
	executable?: boolean;
}

type Intercept = (resource: string, init?: RequestInit) => Response | Promise<Response> | undefined;

function directory(path: string, sha = middleSha) {
	return { path, type: "tree", mode: "040000", sha };
}

function blob(path = "SKILL.md", index = 0, size = content.byteLength) {
	return { path, type: "blob", mode: "100644", sha: blobSha(index), size };
}

function tree(entries: unknown[], sha = targetSha, extra: Record<string, unknown> = {}) {
	return { sha, truncated: false, tree: entries, ...extra };
}

function fixture(
	files: FixtureFile[] = [{ path: "SKILL.md", bytes: content }],
	intercept?: Intercept,
) {
	const calls: { resource: string; url: string; init?: RequestInit }[] = [];
	const directories = new Set<string>();
	const entries: unknown[] = [];
	files.forEach((file, index) => {
		const segments = file.path.split("/");
		for (let count = 1; count < segments.length; count++) {
			const path = segments.slice(0, count).join("/");
			if (directories.has(path)) continue;
			directories.add(path);
			entries.push(directory(path));
		}
		entries.push({
			...blob(file.path, index, file.bytes.byteLength),
			mode: file.executable ? "100755" : "100644",
		});
	});
	setOutboundFetchOverrideForTest(async (input, init) => {
		const url = String(input);
		const prefix = "https://api.github.com/repos/owner/repo/git/";
		expect(url.startsWith(prefix)).toBe(true);
		const resource = url.slice(prefix.length);
		calls.push({ resource, url, init });
		const replacement = intercept?.(resource, init);
		if (replacement) return replacement;
		if (resource === "trees/main")
			return Response.json(tree([directory("my-skill", targetSha)], rootSha));
		if (resource === `trees/${targetSha}?recursive=1`) return Response.json(tree(entries));
		if (resource.startsWith("trees/"))
			return new Response("Private upstream details", { status: 404 });
		const index = files.findIndex((_, index) => resource === `blobs/${blobSha(index)}`);
		if (index >= 0) return new Response(new Uint8Array(files[index].bytes));
		throw new Error(`Unexpected fixture request: ${resource}`);
	});
	return { calls, entries };
}

async function expectCode(promise: Promise<unknown>, code: string, status?: number) {
	const error = await promise.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(AppError);
	expect((error as AppError).code).toBe(code);
	if (status !== undefined) expect((error as AppError).statusCode).toBe(status);
	expect((error as AppError).message).not.toContain("Private upstream details");
	return error as AppError;
}

function streamed(chunks: Uint8Array[], onCancel?: () => void) {
	let cursor = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks[cursor++];
				if (chunk) controller.enqueue(chunk);
				else controller.close();
			},
			cancel: onCancel,
		}),
	);
}

afterEach(() => setOutboundFetchOverrideForTest(null));

describe("public GitHub URL and portable path validation", () => {
	test("accepts explicit tree URLs, escaped Unicode, slash refs and a trailing slash", () => {
		expect(parseGitHubSkillUrl(`${source}/`)).toEqual({
			owner: "owner",
			repo: "repo",
			refAndPath: ["main", "my-skill"],
		});
		expect(
			parseGitHubSkillUrl("https://github.com/owner/repo/tree/feature/skills/%E4%B8%AD%E6%96%87")
				.refAndPath,
		).toEqual(["feature", "skills", "中文"]);
		expect(parseGitHubSkillUrl("https://github.com/owner/repo/tree/main").refAndPath).toEqual([
			"main",
		]);
	});

	test.each([
		"http://github.com/owner/repo/tree/main/demo",
		"https://gitlab.com/owner/repo/tree/main/demo",
		"https://github.com.evil.test/owner/repo/tree/main/demo",
		"https://evil.test/github.com/owner/repo/tree/main/demo",
		"https://github.com@evil.test/owner/repo/tree/main/demo",
		"https://user:password@github.com/owner/repo/tree/main/demo",
		"https://github.com:443/owner/repo/tree/main/demo",
		"https://github.com:8443/owner/repo/tree/main/demo",
		"https://raw.githubusercontent.com/owner/repo/main/SKILL.md",
		"https://github.com/owner/repo/blob/main/SKILL.md",
		"https://github.com/owner/repo",
		"https://github.com/owner/repo/tree/",
		"https://github.com/owner/repo/tree/main/../demo",
		"https://github.com/owner/repo/tree/main/%2e%2e/demo",
		"https://github.com/owner/repo/tree/main/.%2E/demo",
		"https://github.com/owner/repo/tree/main/%252e%252e/demo",
		"https://github.com/owner/repo/tree/main/%2fetc",
		"https://github.com/owner/repo/tree/main/%5cetc",
		"https://github.com/owner/repo/tree/main/%255cetc",
		"https://github.com/owner/repo/tree/main/%00file",
		"https://github.com/owner/repo/tree/main/%0afile",
		"https://github.com/owner/repo/tree/main/\\etc",
		"https://github.com/owner/repo/tree/main//demo",
		"https://github.com/owner/repo/tree/main/%",
		`${source}?download=1`,
		`${source}#readme`,
		` ${source}`,
		`${source}\n`,
		`${source}/${"x".repeat(limits.urlLength)}`,
		`https://github.com/owner/repo/tree/${Array(17).fill("ref").join("/")}`,
	])("rejects unsafe URL before any request: %s", async (url) => {
		const { calls } = fixture();
		await expectCode(downloadGitHubSkill(url, noSignal()), "SKILL_GITHUB_URL", 400);
		expect(calls).toHaveLength(0);
	});

	test.each([
		"",
		"/etc/passwd",
		"../evil",
		"a/../evil",
		"a/./evil",
		"a//evil",
		"a/",
		"C:/evil",
		"a\\evil",
		"//server/share",
		"NUL",
		"CON.txt",
		"aux.md",
		"LPT9",
		"COM1.txt",
		"COM¹.txt",
		"conin$",
		"con .txt",
		"file.",
		"file ",
		"dir./file",
		"file:ads",
		"bad<name",
		"bad>name",
		"bad|name",
		"bad?name",
		"bad*name",
		'bad"name',
		"bad\0name",
		"bad\nname",
		"bad\ud800name",
		"x".repeat(256),
		`${Array(8).fill("a").join("/")}/file`,
	])("rejects unsupported imported path: %s", (path) => {
		expect(() => validateImportedSkillPath(path)).toThrow(ValidationError);
	});

	test.each([
		"SKILL.md",
		"scripts/run.sh",
		"中文/数据.bin",
		"COM10.txt",
		"a.b",
		`${Array(7).fill("a").join("/")}/file`,
	])("accepts safe imported path: %s", (path) => {
		expect(() => validateImportedSkillPath(path)).not.toThrow();
	});
});

describe("reserved local metadata protection", () => {
	test.each([
		".narrafork-source.json",
		".NARRAFORK-SOURCE.JSON",
		"SKILL.md.disabled",
		"skill.MD.DISABLED",
	])("rejects a reserved target-root file %s before downloading blobs", async (path) => {
		const { calls } = fixture([
			{ path: "SKILL.md", bytes: content },
			{ path, bytes: new TextEncoder().encode("{}") },
		]);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_PATH");
		expect(calls.some((call) => call.resource.startsWith("blobs/"))).toBe(false);
	});

	test.each([
		".narrafork-source.json",
		"SKILL.md.disabled",
	])("does not confuse reserved name %s in unrelated ancestors or a nested directory", async (name) => {
		const nested = `assets/${name}`;
		fixture(
			[
				{ path: "SKILL.md", bytes: content },
				{ path: nested, bytes: new TextEncoder().encode("{}") },
			],
			(resource) =>
				resource === "trees/main"
					? Response.json(
							tree(
								[blob(name, 9), blob(name.toUpperCase(), 10), directory("my-skill", targetSha)],
								rootSha,
							),
						)
					: undefined,
		);
		expect((await downloadGitHubSkill(source, noSignal())).map((file) => file.path)).toEqual([
			"SKILL.md",
			nested,
		]);
	});
});

describe("GitHub tree discovery and binary downloads", () => {
	test("returns the complete files and binary bytes with modes and fixed unauthenticated requests", async () => {
		const binary = Uint8Array.from([0, 255, 128, 13, 10, 0, 200]);
		const script = new TextEncoder().encode("#!/bin/sh\nexit 0\n");
		const { calls } = fixture(
			[
				{ path: "SKILL.md", bytes: content },
				{ path: "assets/data.bin", bytes: binary },
				{ path: "scripts/run.sh", bytes: script, executable: true },
				{ path: "empty", bytes: new Uint8Array() },
			],
			(resource) =>
				resource === `blobs/${blobSha(1)}`
					? streamed([binary.slice(0, 2), binary.slice(2)])
					: undefined,
		);
		expect(await downloadGitHubSkill(source, noSignal())).toEqual([
			{ path: "SKILL.md", bytes: content, executable: false },
			{ path: "assets/data.bin", bytes: binary, executable: false },
			{ path: "scripts/run.sh", bytes: script, executable: true },
			{ path: "empty", bytes: new Uint8Array(), executable: false },
		]);
		expect(calls.map((call) => call.resource)).toEqual([
			"trees/main%2Fmy-skill",
			"trees/main",
			`trees/${targetSha}?recursive=1`,
			...Array.from({ length: 4 }, (_, index) => `blobs/${blobSha(index)}`),
		]);
		for (const call of calls) {
			expect(new URL(call.url).hostname).toBe("api.github.com");
			expect(call.init?.redirect).toBe("manual");
			expect(call.init?.credentials).toBe("omit");
			expect(call.init?.signal).toBeInstanceOf(AbortSignal);
			const headers = new Headers(call.init?.headers);
			expect(headers.get("authorization")).toBeNull();
			expect(headers.get("user-agent")).toBe("NarraFork-Skill-Import");
			expect(headers.get("x-github-api-version")).toBe("2022-11-28");
			expect(headers.get("accept")).toBe(
				call.resource.startsWith("blobs/")
					? "application/vnd.github.raw+json"
					: "application/vnd.github+json",
			);
		}
	});

	test("tries longest slash ref first, only falls back on 404, and traverses directories by immutable SHA", async () => {
		const { calls } = fixture(undefined, (resource) => {
			if (resource === "trees/feature%2Fone")
				return Response.json(tree([directory("skills", middleSha)], rootSha));
			if (resource === `trees/${middleSha}`)
				return Response.json(tree([directory("demo", targetSha)], middleSha));
		});
		await downloadGitHubSkill(
			"https://github.com/owner/repo/tree/feature/one/skills/demo",
			noSignal(),
		);
		expect(calls.map((call) => call.resource)).toEqual([
			"trees/feature%2Fone%2Fskills%2Fdemo",
			"trees/feature%2Fone%2Fskills",
			"trees/feature%2Fone",
			`trees/${middleSha}`,
			`trees/${targetSha}?recursive=1`,
			`blobs/${blobSha(0)}`,
		]);
	});

	test("supports an explicit tree ref selecting the repository root", async () => {
		const { calls } = fixture(undefined, (resource) => {
			if (resource === "trees/main") return Response.json(tree([blob()], rootSha));
			if (resource === `trees/${rootSha}?recursive=1`)
				return Response.json(tree([blob()], rootSha));
		});
		expect(
			await downloadGitHubSkill("https://github.com/owner/repo/tree/main", noSignal()),
		).toHaveLength(1);
		expect(calls.map((call) => call.resource)).toEqual([
			"trees/main",
			`trees/${rootSha}?recursive=1`,
			`blobs/${blobSha(0)}`,
		]);
	});

	test("ignores all response-provided URLs and blob download_url fields", async () => {
		const { calls } = fixture(undefined, (resource) => {
			if (resource !== `trees/${targetSha}?recursive=1`) return;
			const response = Response.json(
				tree(
					[
						{
							...blob(),
							url: "http://127.0.0.1/private",
							download_url: "http://169.254.169.254/metadata",
						},
					],
					targetSha,
					{ url: "https://evil.test/tree" },
				),
			);
			Object.defineProperty(response, "url", { value: "https://evil.test/response" });
			return response;
		});
		await downloadGitHubSkill(source, noSignal());
		expect(calls.every((call) => call.url.startsWith("https://api.github.com/"))).toBe(true);
	});

	test("caps longest-ref resolution at sixteen requests", async () => {
		const { calls } = fixture();
		await expectCode(
			downloadGitHubSkill(
				`https://github.com/owner/repo/tree/${Array(16).fill("missing").join("/")}`,
				noSignal(),
			),
			"SKILL_GITHUB_NOT_FOUND",
			404,
		);
		expect(calls).toHaveLength(16);
	});

	test.each([403, 429, 401, 422, 500])("does not retry shorter refs on HTTP %s", async (status) => {
		const { calls } = fixture(
			undefined,
			() => new Response("Private upstream details", { status }),
		);
		await expectCode(
			downloadGitHubSkill(source, noSignal()),
			status === 403 || status === 429 ? "SKILL_GITHUB_RATE_LIMITED" : "SKILL_GITHUB_REQUEST",
			status === 403 || status === 429 ? 429 : 502,
		);
		expect(calls).toHaveLength(1);
	});

	test.each([
		300, 301, 302, 303, 304, 307, 308, 399,
	])("rejects every redirect status including %s", async (status) => {
		let cancelled = false;
		const { calls } = fixture(
			undefined,
			() =>
				new Response(
					status === 304
						? null
						: new ReadableStream({
								cancel() {
									cancelled = true;
								},
							}),
					{ status, headers: { location: "http://127.0.0.1/secret" } },
				),
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_REDIRECT", 400);
		expect(calls).toHaveLength(1);
		if (status !== 304) expect(cancelled).toBe(true);
	});

	test("rejects responses which already followed a redirect", async () => {
		const { calls } = fixture(undefined, () => {
			const response = Response.json(tree([blob()], rootSha));
			Object.defineProperty(response, "redirected", { value: true });
			return response;
		});
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_REDIRECT");
		expect(calls).toHaveLength(1);
	});

	test.each([
		"directory",
		"tree",
		"blob",
	])("reports missing %s without a fallback ref", async (missing) => {
		const { calls } = fixture(undefined, (resource) => {
			if (missing === "directory" && resource === "trees/main")
				return Response.json(tree([], rootSha));
			if (
				(missing === "tree" && resource.includes("recursive=")) ||
				(missing === "blob" && resource.startsWith("blobs/"))
			)
				return new Response("Private upstream details", { status: 404 });
		});
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_NOT_FOUND", 404);
		expect(calls.filter((call) => call.resource === "trees/main")).toHaveLength(1);
	});

	test("stops at a successful ref response whose metadata is invalid", async () => {
		const { calls } = fixture(undefined, () =>
			Response.json({ unexpected: "Private upstream details" }),
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_METADATA");
		expect(calls).toHaveLength(1);
	});

	test("decodes escaped source directory names once", async () => {
		fixture(undefined, (resource) =>
			resource === "trees/main"
				? Response.json(tree([directory("my skill 中文", targetSha)], rootSha))
				: undefined,
		);
		expect(
			await downloadGitHubSkill(
				"https://github.com/owner/repo/tree/main/my%20skill%20%E4%B8%AD%E6%96%87",
				noSignal(),
			),
		).toHaveLength(1);
	});

	test("does not treat a file selected in the URL as a skill directory", async () => {
		fixture(undefined, (resource) =>
			resource === "trees/main" ? Response.json(tree([blob("my-skill")], rootSha)) : undefined,
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_URL");
	});

	test.each([
		"skill.md",
		"nested/SKILL.md",
	])("requires exact root SKILL.md rather than %s", async (path) => {
		const { calls } = fixture([{ path, bytes: content }]);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_SKILL_MISSING");
		expect(calls.some((call) => call.resource.startsWith("blobs/"))).toBe(false);
	});
});

describe("ancestor metadata versus imported target policy", () => {
	test("ignores unrelated symlinks, submodules and nonportable names at every ancestor", async () => {
		const unrelated = [
			{ ...blob("CLAUDE.md", 1), mode: "120000" },
			{ path: "vendor", sha: blobSha(2), type: "commit", mode: "160000" },
			blob("CON", 3),
			blob("Readme", 4),
			blob("README", 5),
			directory("Assets"),
			blob("assets", 6),
			blob("file.", 7),
			blob("file:ads", 8),
			blob("back\\slash", 9),
			blob("é", 10),
			blob("e\u0301", 11),
			blob("large.bin", 12, limits.totalBytes + 1),
		];
		const { calls } = fixture(undefined, (resource) => {
			if (resource === "trees/main")
				return Response.json(tree([...unrelated, directory("skills", middleSha)], rootSha));
			if (resource === `trees/${middleSha}`)
				return Response.json(tree([...unrelated, directory("demo", targetSha)], middleSha));
		});
		expect(
			await downloadGitHubSkill("https://github.com/owner/repo/tree/main/skills/demo", noSignal()),
		).toEqual([{ path: "SKILL.md", bytes: content, executable: false }]);
		expect(
			calls.filter((call) => call.resource.startsWith("blobs/")).map((call) => call.resource),
		).toEqual([`blobs/${blobSha(0)}`]);
	});

	test.each([
		"",
		".",
		"..",
		"../outside",
		"/absolute",
		"a/b",
		"null\0byte",
	])("rejects invalid ancestor single-segment path %s", async (path) => {
		fixture(undefined, (resource) =>
			resource === "trees/main"
				? Response.json(tree([directory("my-skill", targetSha), blob(path, 1)], rootSha))
				: undefined,
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_METADATA");
	});

	test.each([
		{ ...blob("unrelated", 1), sha: "invalid" },
		{ ...blob("unrelated", 1), type: "commit", mode: "100644" },
		{ ...blob("unrelated", 1), type: "blob", mode: "160000" },
		{ ...blob("unrelated", 1), type: "tree", mode: "120000" },
		{ ...blob("unrelated", 1), mode: "120000", size: undefined },
		{ ...blob("unrelated", 1), size: -1 },
	])("still validates ancestor SHA, type/mode and size %#", async (entry) => {
		fixture(undefined, (resource) =>
			resource === "trees/main"
				? Response.json(tree([directory("my-skill", targetSha), entry], rootSha))
				: undefined,
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_METADATA");
	});

	test("rejects exact duplicate ancestor names to keep selection unambiguous", async () => {
		fixture(undefined, (resource) =>
			resource === "trees/main"
				? Response.json(
						tree([directory("my-skill", targetSha), directory("my-skill", middleSha)], rootSha),
					)
				: undefined,
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_METADATA");
	});

	test.each(["symlink", "submodule"])("does not navigate a selected %s", async (kind) => {
		const selected =
			kind === "symlink"
				? { ...blob("my-skill"), mode: "120000" }
				: { path: "my-skill", sha: targetSha, type: "commit", mode: "160000" };
		const { calls } = fixture(undefined, (resource) =>
			resource === "trees/main" ? Response.json(tree([selected], rootSha)) : undefined,
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_URL");
		expect(
			calls.some(
				(call) => call.resource.includes("recursive=") || call.resource.startsWith("blobs/"),
			),
		).toBe(false);
	});

	test.each([
		"CON",
		"name.",
		"name ",
		"file:ads",
	])("still rejects selected nonportable source directory %s", async (path) => {
		fixture(undefined, (resource) =>
			resource === "trees/main"
				? Response.json(tree([directory(path, targetSha)], rootSha))
				: undefined,
		);
		await expectCode(
			downloadGitHubSkill(
				`https://github.com/owner/repo/tree/main/${encodeURIComponent(path)}`,
				noSignal(),
			),
			"SKILL_GITHUB_PATH",
		);
	});

	test.each([
		"entries",
		"metadata bytes",
		"truncation",
	])("retains ancestor %s budget enforcement", async (budget) => {
		fixture(undefined, (resource) => {
			if (resource !== "trees/main") return;
			if (budget === "metadata bytes") return new Response(" ".repeat(limits.metadataBytes + 1));
			return Response.json(
				tree(
					budget === "entries"
						? Array.from({ length: limits.entries + 1 }, (_, i) => directory(`dir${i}`))
						: [directory("my-skill", targetSha)],
					rootSha,
					{ truncated: budget === "truncation" },
				),
			);
		});
		await expectCode(
			downloadGitHubSkill(source, noSignal()),
			budget === "truncation" ? "SKILL_GITHUB_METADATA" : "SKILL_GITHUB_LIMIT",
		);
	});

	test.each([
		"symlink",
		"submodule",
		"nonportable path",
		"case collision",
	])("still rejects %s when importing the repository root", async (kind) => {
		const entries: unknown[] = [blob()];
		if (kind === "symlink") entries.push({ ...blob("link", 1), mode: "120000" });
		if (kind === "submodule")
			entries.push({ path: "vendor", sha: middleSha, type: "commit", mode: "160000" });
		if (kind === "nonportable path") entries.push(blob("CON", 1));
		if (kind === "case collision") entries.push(blob("skill.MD", 1));
		const { calls } = fixture(undefined, (resource) =>
			resource === "trees/main" || resource === `trees/${rootSha}?recursive=1`
				? Response.json(tree(entries, rootSha))
				: undefined,
		);
		await expectCode(
			downloadGitHubSkill("https://github.com/owner/repo/tree/main", noSignal()),
			kind === "symlink" || kind === "submodule" ? "SKILL_GITHUB_METADATA" : "SKILL_GITHUB_PATH",
		);
		expect(calls.some((call) => call.resource === `trees/${rootSha}?recursive=1`)).toBe(true);
	});
});

describe("untrusted tree metadata and resource budgets", () => {
	test.each([
		["tree sha", tree([blob()], "invalid")],
		["wrong immutable sha", tree([blob()], rootSha)],
		["missing truncation", tree([blob()], targetSha, { truncated: undefined })],
		["truncated tree", tree([blob()], targetSha, { truncated: true })],
		["non-array entries", tree([blob()], targetSha, { tree: {} })],
		["null entry", tree([null])],
		["blob sha", tree([{ ...blob(), sha: "../outside" }])],
		["blob type", tree([{ ...blob(), type: "commit" }])],
		["symlink", tree([{ ...blob(), mode: "120000" }])],
		["submodule", tree([{ ...blob(), type: "commit", mode: "160000" }])],
		["invalid blob mode", tree([{ ...blob(), mode: "100664" }])],
		["tree mode mismatch", tree([{ ...blob(), type: "tree" }])],
		["invalid optional tree size", tree([blob(), { ...directory("assets"), size: -1 }])],
		["missing size", tree([{ ...blob(), size: undefined }])],
		["negative size", tree([{ ...blob(), size: -1 }])],
		["fractional size", tree([{ ...blob(), size: 1.5 }])],
		["string size", tree([{ ...blob(), size: "42" }])],
		["unsafe size", tree([{ ...blob(), size: Number.MAX_SAFE_INTEGER + 1 }])],
		["missing recursive parent", tree([blob(), blob("assets/file", 1)])],
	])("rejects %s before downloading any files", async (_name, metadata) => {
		const { calls } = fixture(undefined, (resource) =>
			resource.includes("recursive=") ? Response.json(metadata) : undefined,
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_METADATA");
		expect(calls.some((call) => call.resource.startsWith("blobs/"))).toBe(false);
	});

	test.each(
		[
			[blob(), blob()],
			[blob(), blob("skill.MD", 1)],
			[blob(), blob("assets", 1), directory("assets")],
			[blob(), directory("assets"), blob("Assets/file", 1)],
			[blob(), blob("assets/file", 1), blob("assets", 2)],
			[blob(), directory("assets"), directory("assets")],
			[blob(), blob("Straße", 1), blob("STRASSE", 2)],
			[blob(), blob("é", 1), blob("e\u0301", 2)],
		].map((entries) => ({ entries })),
	)("rejects duplicate and case-folded file/directory collisions %#", async ({ entries }) => {
		fixture(undefined, (resource) =>
			resource.includes("recursive=") ? Response.json(tree(entries)) : undefined,
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_PATH");
	});

	test.each([
		"../escape",
		"/absolute",
		"C:/absolute",
		"scripts\\bad",
		"NUL.txt",
		"file:ads",
		"a./file",
		"a /file",
	])("rejects malicious metadata path %s", async (path) => {
		fixture(undefined, (resource) =>
			resource.includes("recursive=") ? Response.json(tree([blob(), blob(path, 1)])) : undefined,
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_PATH");
	});

	test("rejects non-recursive metadata containing multi-component paths", async () => {
		fixture(undefined, (resource) =>
			resource === "trees/main"
				? Response.json(tree([directory("my-skill/subdir")], rootSha))
				: undefined,
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_METADATA");
	});

	test.each([
		"files",
		"entries",
		"depth",
		"skill bytes",
		"file bytes",
		"total bytes",
	])("rejects the %s budget before any blob fetch", async (budget) => {
		let entries: unknown[] = [blob()];
		if (budget === "files")
			entries = Array.from({ length: limits.files + 1 }, (_, i) =>
				blob(i === 0 ? "SKILL.md" : `file${i}`, i),
			);
		if (budget === "entries")
			entries.push(...Array.from({ length: limits.entries }, (_, i) => directory(`dir${i}`)));
		if (budget === "depth") entries.push(blob(`${Array(8).fill("a").join("/")}/file`, 1));
		if (budget === "skill bytes") entries = [blob("SKILL.md", 0, limits.skillBytes + 1)];
		if (budget === "file bytes") entries.push(blob("large.bin", 1, limits.fileBytes + 1));
		if (budget === "total bytes")
			entries.push(
				...Array.from({ length: 10 }, (_, i) => blob(`file${i}`, i + 1, limits.fileBytes)),
			);
		const { calls } = fixture(undefined, (resource) =>
			resource.includes("recursive=") ? Response.json(tree(entries)) : undefined,
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_LIMIT");
		expect(calls.some((call) => call.resource.startsWith("blobs/"))).toBe(false);
	});

	test("accepts exact SKILL.md, file and aggregate size boundaries", async () => {
		const files: FixtureFile[] = [{ path: "SKILL.md", bytes: new Uint8Array(limits.skillBytes) }];
		for (let i = 0; i < 9; i++)
			files.push({ path: `file${i}.bin`, bytes: new Uint8Array(limits.fileBytes) });
		files.push({
			path: "last.bin",
			bytes: new Uint8Array(limits.totalBytes - limits.skillBytes - 9 * limits.fileBytes),
		});
		fixture(files);
		const result = await downloadGitHubSkill(source, noSignal());
		expect(result.reduce((total, file) => total + file.bytes.byteLength, 0)).toBe(
			limits.totalBytes,
		);
		expect(result[0].bytes.byteLength).toBe(limits.skillBytes);
	});

	test("accepts exactly 512 metadata entries and eight path components", async () => {
		const directories = Array.from({ length: 7 }, (_, i) =>
			directory(
				Array(i + 1)
					.fill("nested")
					.join("/"),
			),
		);
		const entries = [
			blob(),
			...directories,
			blob(`${Array(7).fill("nested").join("/")}/file`, 1),
			...Array.from({ length: limits.entries - 9 }, (_, i) => directory(`empty${i}`)),
		];
		fixture(
			[
				{ path: "SKILL.md", bytes: content },
				{ path: "file", bytes: content },
			],
			(resource) => (resource.includes("recursive=") ? Response.json(tree(entries)) : undefined),
		);
		const files = await downloadGitHubSkill(source, noSignal());
		expect(files).toHaveLength(2);
		expect(files[1].path.split("/")).toHaveLength(8);
	});

	test("accepts exactly one hundred files", async () => {
		fixture(
			Array.from({ length: limits.files }, (_, i) => ({
				path: i === 0 ? "SKILL.md" : `file${i}`,
				bytes: new Uint8Array(),
			})),
		);
		expect(await downloadGitHubSkill(source, noSignal())).toHaveLength(limits.files);
	});

	test.each([
		"header",
		"stream",
	])("enforces the metadata byte limit via %s without truncating", async (kind) => {
		let cancelled = false;
		fixture(undefined, () =>
			kind === "header"
				? new Response(
						new ReadableStream({
							cancel() {
								cancelled = true;
							},
						}),
						{ headers: { "content-length": String(limits.metadataBytes + 1) } },
					)
				: streamed(
						[new Uint8Array(limits.metadataBytes), new Uint8Array(1), new Uint8Array(1)],
						() => {
							cancelled = true;
						},
					),
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_LIMIT");
		expect(cancelled).toBe(true);
	});

	test.each([
		"malformed JSON",
		"invalid UTF-8",
		"invalid content length",
	])("rejects %s metadata", async (kind) => {
		fixture(undefined, () =>
			kind === "invalid UTF-8"
				? new Response(Uint8Array.from([255, 254]))
				: new Response(
						"{",
						kind === "invalid content length"
							? { headers: { "content-length": "invalid" } }
							: undefined,
					),
		);
		await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_METADATA");
	});

	test.each([
		"truncated",
		"extra bytes",
		"file limit",
		"header limit",
	])("rejects %s blob data instead of trusting the advertised tree size", async (kind) => {
		fixture(undefined, (resource) => {
			if (!resource.startsWith("blobs/")) return;
			if (kind === "truncated") return new Response(content.slice(1));
			if (kind === "extra bytes") return streamed([content, new Uint8Array(1)]);
			if (kind === "file limit") return streamed([new Uint8Array(limits.skillBytes + 1)]);
			return new Response(null, { headers: { "content-length": String(limits.skillBytes + 1) } });
		});
		await expectCode(
			downloadGitHubSkill(source, noSignal()),
			kind.includes("limit") ? "SKILL_GITHUB_LIMIT" : "SKILL_GITHUB_METADATA",
		);
	});

	test("sanitizes transport and stream errors instead of leaking upstream messages", async () => {
		for (const body of [false, true]) {
			fixture(undefined, () => {
				if (!body) throw new Error("Private upstream details");
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("Private upstream details"));
						},
					}),
				);
			});
			await expectCode(downloadGitHubSkill(source, noSignal()), "SKILL_GITHUB_REQUEST", 502);
		}
	});
});

describe("bounded concurrency and reliable cancellation", () => {
	test("never starts network work for an already-aborted signal", async () => {
		const { calls } = fixture();
		await expectCode(
			downloadGitHubSkill(source, AbortSignal.abort("Private upstream details")),
			"SKILL_GITHUB_ABORTED",
			408,
		);
		expect(calls).toHaveLength(0);
	});

	test("cancels a fetch ignoring signal and disposes its late body", async () => {
		const entered = Promise.withResolvers<void>();
		const late = Promise.withResolvers<Response>();
		const disposed = Promise.withResolvers<void>();
		const controller = new AbortController();
		fixture(undefined, () => {
			entered.resolve();
			return late.promise;
		});
		const download = downloadGitHubSkill(source, controller.signal);
		const rejected = expectCode(download, "SKILL_GITHUB_ABORTED", 408);
		await entered.promise;
		controller.abort("Private upstream details");
		await rejected;
		late.resolve(
			new Response(
				new ReadableStream({
					cancel() {
						disposed.resolve();
					},
				}),
			),
		);
		await disposed.promise;
	});

	test.each([
		"metadata",
		"blob",
	])("cancels stalled %s reads even when the transport ignores signal", async (part) => {
		const reading = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		const controller = new AbortController();
		const { calls } = fixture(undefined, (resource) => {
			if (part === "blob" && !resource.startsWith("blobs/")) return;
			return new Response(
				new ReadableStream<Uint8Array>({
					pull() {
						reading.resolve();
						return new Promise(() => {});
					},
					cancel() {
						cancelled.resolve();
						return new Promise(() => {});
					},
				}),
			);
		});
		const result = expectCode(
			downloadGitHubSkill(source, controller.signal),
			"SKILL_GITHUB_ABORTED",
			408,
		);
		await reading.promise;
		controller.abort();
		await result;
		await cancelled.promise;
		expect(calls.at(-1)?.init?.signal?.aborted).toBe(true);
	});

	test("does not mistake the expected byte count for EOF on a stalled blob", async () => {
		const reading = Promise.withResolvers<void>();
		const controller = new AbortController();
		let cancelled = false;
		fixture(undefined, (resource) =>
			!resource.startsWith("blobs/")
				? undefined
				: new Response(
						new ReadableStream<Uint8Array>({
							start(stream) {
								stream.enqueue(content);
							},
							pull() {
								reading.resolve();
								return new Promise(() => {});
							},
							cancel() {
								cancelled = true;
							},
						}),
					),
		);
		const result = expectCode(
			downloadGitHubSkill(source, controller.signal),
			"SKILL_GITHUB_ABORTED",
		);
		await reading.promise;
		controller.abort();
		await result;
		expect(cancelled).toBe(true);
	});

	test("observes a parent deadline during a stalled body", async () => {
		const reading = Promise.withResolvers<void>();
		const parent = new AbortController();
		let cancelled = false;
		fixture(
			undefined,
			() =>
				new Response(
					new ReadableStream({
						pull() {
							reading.resolve();
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		);
		const result = expectCode(
			downloadGitHubSkill(source, parent.signal),
			"SKILL_GITHUB_ABORTED",
			408,
		);
		await reading.promise;
		const deadline = setTimeout(() => parent.abort(), 5);
		try {
			await result;
		} finally {
			clearTimeout(deadline);
		}
		expect(cancelled).toBe(true);
	});

	test("keeps at most four blob bodies in flight and preserves source order", async () => {
		let active = 0;
		let maximum = 0;
		const ready: (() => void)[] = [];
		let wake = Promise.withResolvers<void>();
		const files = Array.from({ length: 10 }, (_, i) => ({
			path: i === 0 ? "SKILL.md" : `file${i}`,
			bytes: Uint8Array.from([i]),
		}));
		fixture(files, (resource) => {
			if (!resource.startsWith("blobs/")) return;
			const index = files.findIndex((_, index) => resource === `blobs/${blobSha(index)}`);
			active++;
			maximum = Math.max(maximum, active);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						ready.push(() => {
							active--;
							controller.enqueue(files[index].bytes);
							controller.close();
						});
						wake.resolve();
					},
				}),
			);
		});
		const result = downloadGitHubSkill(source, noSignal());
		let completed = 0;
		while (completed < files.length) {
			const batch = Math.min(limits.concurrency, files.length - completed);
			while (ready.length < batch) {
				await wake.promise;
				wake = Promise.withResolvers<void>();
			}
			expect(active).toBe(batch);
			const releases = ready.splice(0).reverse();
			completed += releases.length;
			for (const release of releases) release();
		}
		expect((await result).map((file) => file.bytes[0])).toEqual(
			Array.from({ length: 10 }, (_, i) => i),
		);
		expect(maximum).toBe(limits.concurrency);
		expect(active).toBe(0);
	});

	test("cancels sibling bodies and starts no further blobs when one worker fails", async () => {
		const siblingReading = Promise.withResolvers<void>();
		const fail = Promise.withResolvers<Response>();
		let siblings = 0;
		let cancelled = 0;
		const files = Array.from({ length: 8 }, (_, i) => ({
			path: i === 0 ? "SKILL.md" : `file${i}`,
			bytes: content,
		}));
		const { calls } = fixture(files, (resource) => {
			if (!resource.startsWith("blobs/")) return;
			if (resource === `blobs/${blobSha(0)}`) return fail.promise;
			return new Response(
				new ReadableStream({
					pull() {
						if (++siblings === 3) siblingReading.resolve();
						return new Promise(() => {});
					},
					cancel() {
						cancelled++;
					},
				}),
			);
		});
		const result = expectCode(
			downloadGitHubSkill(source, noSignal()),
			"SKILL_GITHUB_RATE_LIMITED",
			429,
		);
		await siblingReading.promise;
		fail.resolve(new Response("Private upstream details", { status: 429 }));
		await result;
		expect(cancelled).toBe(3);
		expect(calls.filter((call) => call.resource.startsWith("blobs/"))).toHaveLength(4);
	});
});
