import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import {
	computeBinaryMetadataFromBuffer,
	formatChecksumsReport,
	formatMetadataJson,
	formatSha256Sums,
} from "../../scripts/lib/binary-metadata";
import { githubReleaseBody } from "../../scripts/lib/github-release";

const sourceRoot = resolve(import.meta.dir, "../..");
const version = "1.2.1";
const repository = "Example/Repair";
const changelog = { en: "Verified published notes", "zh-CN": "已验证的发布说明" };
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeExecutable(path: string, content: string) {
	if (process.platform === "win32") {
		const entry = `${path}.ts`;
		writeFileSync(entry, content);
		execFileSync(process.execPath, ["build", entry, "--compile", "--outfile", `${path}.exe`], {
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		});
	} else {
		writeFileSync(path, `#!${process.execPath}\n${content}`);
		chmodSync(path, 0o755);
	}
}

/** No commits are created: this isolated primary git directory borrows an existing local object. */
function fixture() {
	const root = mkdtempSync(join(sourceRoot, ".narrafork/release-index-cli-"));
	roots.push(root);
	const realGit = Bun.which("git");
	if (!realGit) throw new Error("git is required for release CLI fixtures");
	const git = (args: string[], cwd = root) =>
		execFileSync(realGit, args, {
			cwd,
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		});
	const commit = git(["rev-parse", "HEAD"], sourceRoot).trim();
	const objects = git(
		["rev-parse", "--path-format=absolute", "--git-path", "objects"],
		sourceRoot,
	).trim();
	git(["init", "--quiet"]);
	writeFileSync(join(root, ".git/objects/info/alternates"), `${objects.replaceAll("\\", "/")}\n`);
	git(["update-ref", `refs/tags/v${version}`, commit]);
	const beforeRef = git(["show-ref"]).trim();
	mkdirSync(join(root, "scripts"));
	copyFileSync(join(sourceRoot, "scripts/release.ts"), join(root, "scripts/release.ts"));
	for (const [from, to] of [
		["scripts/lib", "scripts/lib"],
		["server", "server"],
		["shared", "shared"],
		["node_modules", "node_modules"],
	])
		symlinkSync(
			join(sourceRoot, from),
			join(root, to),
			process.platform === "win32" ? "junction" : "dir",
		);
	copyFileSync(join(sourceRoot, "tsconfig.json"), join(root, "tsconfig.json"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ version, type: "module" }));
	mkdirSync(join(root, "changelogs"));
	writeFileSync(join(root, "changelogs", `v${version}.json`), JSON.stringify(changelog));
	const bytes = Buffer.from("original published executable fixture");
	const name = `narrafork-${version}-linux-x64`;
	const metadata = computeBinaryMetadataFromBuffer(name, bytes, {
		version,
		platformId: "linux-x64",
		target: "bun-linux-x64",
		commit,
		repository,
		buildDate: "2026-10-08T00:00:00.000Z",
	});
	const sidecar = formatMetadataJson(metadata);
	const wire = {
		repository: repository.toLowerCase(),
		commit,
		version,
		release: {
			id: 1,
			tag_name: `v${version}`,
			draft: false,
			prerelease: false,
			published_at: "2026-10-08T00:00:00Z",
			body: githubReleaseBody(changelog),
		},
		assets: [
			{ id: 101, name, size: bytes.length, state: "uploaded", digest: `sha256:${metadata.sha256}` },
			{
				id: 102,
				name: `${name}.metadata.json`,
				size: Buffer.byteLength(sidecar),
				state: "uploaded",
				digest: `sha256:${createHash("sha256").update(sidecar).digest("hex")}`,
			},
		],
		sidecar,
	};
	const wirePath = join(root, "remote.json");
	writeFileSync(wirePath, JSON.stringify(wire));
	const ghLog = join(root, "gh-calls.jsonl");
	const gitLog = join(root, "git-calls.jsonl");
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeExecutable(
		join(bin, "gh"),
		`
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.NF_FIXTURE_GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "api" || args.some(arg => ["--method", "-X", "-f", "-F", "--input"].includes(arg))) throw new Error("Fixture forbids all remote writes");
const state = JSON.parse(readFileSync(process.env.NF_FIXTURE_WIRE, "utf8"));
const prefix = "repos/" + state.repository + "/";
if (!args[1].startsWith(prefix)) throw new Error("Unexpected repository");
const path = args[1].slice(prefix.length);
let value;
if (path === "releases/tags/v" + state.version) value = args.includes("{body}") ? {body: state.release.body} : state.release;
else if (path === "git/ref/tags/v" + state.version) value = {ref: "refs/tags/v" + state.version, object: {type: "commit", sha: state.commit}};
else if (path === "releases/1/assets?per_page=100&page=1") value = state.assets;
else if (path === "releases/assets/102" && args.includes("Accept: application/octet-stream")) { process.stdout.write(state.sidecar); process.exit(0); }
else throw new Error("Fixture rejects unexpected API: " + path);
process.stdout.write(JSON.stringify(value));
`,
	);
	writeExecutable(
		join(bin, "git"),
		`
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(process.env.NF_FIXTURE_GIT_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "rev-parse") throw new Error("Fixture forbids source git mutation");
process.stdout.write(execFileSync(process.env.NF_FIXTURE_REAL_GIT, args, { timeout: 5000, maxBuffer: 1024 * 1024 }));
`,
	);
	const env = {
		...process.env,
		PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
		GH_TOKEN: "fixture-only",
		GITHUB_TOKEN: "fixture-only",
		GH_HOST: "github.com",
		NF_FIXTURE_GH_LOG: ghLog,
		NF_FIXTURE_GIT_LOG: gitLog,
		NF_FIXTURE_WIRE: wirePath,
		NF_FIXTURE_REAL_GIT: realGit,
	};
	const calls = (path: string): string[][] =>
		existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	function run(flags: string[]) {
		const child = Bun.spawnSync(
			[
				process.execPath,
				"scripts/release.ts",
				version,
				"--target=github",
				`--github-repository=${repository}`,
				"--platform=linux-x64",
				...flags,
			],
			{
				cwd: root,
				env,
				stdout: "pipe",
				stderr: "pipe",
				timeout: 30_000,
			},
		);
		return {
			code: child.exitCode,
			output: `${new TextDecoder().decode(child.stdout)}${new TextDecoder().decode(child.stderr)}`,
		};
	}
	return {
		root,
		run,
		wire,
		wirePath,
		ghCalls: () => calls(ghLog),
		gitCalls: () => calls(gitLog),
		assertSourceUntouched() {
			expect(git(["show-ref"]).trim()).toBe(beforeRef);
			expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe(version);
		},
		createDist() {
			mkdirSync(join(root, "dist"));
			writeFileSync(join(root, "dist", name), bytes);
			writeFileSync(join(root, "dist", `${name}.metadata.json`), sidecar);
			writeFileSync(
				join(root, "dist", `narrafork-${version}-SHA256SUMS`),
				formatSha256Sums([metadata]),
			);
			writeFileSync(
				join(root, "dist", `narrafork-${version}-checksums.txt`),
				formatChecksumsReport(version, [metadata]),
			);
		},
	};
}

describe("release index-only executable CLI", () => {
	for (const flags of [["--publish-index"], ["--index-only", "--publish-index", "--dry-run"]]) {
		test(`rejects conflicting flags before git or GitHub access: ${flags.join(" ")}`, () => {
			const f = fixture();
			const result = f.run(flags);
			expect(result.code).not.toBe(0);
			expect(result.output).toContain(
				"--publish-index requires --index-only and cannot be combined with --dry-run",
			);
			expect(f.ghCalls()).toEqual([]);
			expect(f.gitCalls()).toEqual([]);
			f.assertSourceUntouched();
		});
	}
	for (const flags of [["--index-only"], ["--index-only", "--dry-run"]]) {
		test(`previews a promoted public release without dist or writes: ${flags.join(" ")}`, () => {
			const f = fixture();
			expect(existsSync(join(f.root, "dist"))).toBe(false);
			const result = f.run(flags);
			expect(result.output).toContain("Read-only index repair preview complete");
			expect(result.code).toBe(0);
			expect(result.output).toContain('"prerelease": false');
			expect(result.output).toContain('"notes":');
			const calls = f.ghCalls();
			expect(calls.length).toBeGreaterThan(0);
			expect(
				calls.every(
					(args) => args[0] === "api" && !args.includes("--method") && !args.includes("-X"),
				),
			).toBe(true);
			expect(calls.some((args) => args.includes("{body}"))).toBe(true);
			expect(calls.some((args) => args.includes("Accept: application/octet-stream"))).toBe(true);
			expect(calls.some((args) => /git\/(?:refs|blobs|trees|commits)|heads\//.test(args[1]))).toBe(
				false,
			);
			expect(f.gitCalls().every((args) => args[0] === "rev-parse")).toBe(true);
			expect(existsSync(join(f.root, "dist"))).toBe(false);
			f.assertSourceUntouched();
		});
	}
	test("ordinary GitHub dry-run remains offline", () => {
		const f = fixture();
		f.createDist();
		const result = f.run(["--upload-only", "--dry-run"]);
		expect(result.output).toContain("no GitHub calls made");
		expect(result.code).toBe(0);
		expect(f.ghCalls()).toEqual([]);
		f.assertSourceUntouched();
	});
	test("draft index-only preview fails without attempting publication", () => {
		const f = fixture();
		f.wire.release.draft = true;
		writeFileSync(f.wirePath, JSON.stringify(f.wire));
		const result = f.run(["--index-only"]);
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("requires a public Release");
		expect(f.ghCalls().every((args) => args[0] === "api")).toBe(true);
		f.assertSourceUntouched();
	});
});
