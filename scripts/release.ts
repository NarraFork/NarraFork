/**
 * GitHub is the publication authority. The default update-server target only
 * mirrors an already-public GitHub Release, without local builds or dist files.
 * --dry-run is an offline mirror intent; --preview verifies GitHub read-only.
 * GitHub --dry-run retains build/local-validation and index-repair semantics.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { isValidReleaseVersion } from "../shared/release-version";
import { resolveBuildGitHubRepository } from "./lib/build-repository";
import { publishGitHubRelease, validateGitHubRepository } from "./lib/github-release";
import { validatePublishedPatchSources } from "./lib/local-github-patch-source";
import { dispatchMainRelease, releaseSourceDeclaresRemotePeer } from "./lib/main-release-dispatch";
import { getUnexpectedReleaseChanges, resolveGitCommit } from "./lib/release-git";
import { resolvePlatformSuffixes } from "./lib/stable-baseline-patch";
import { prepareUpdateIndexRelease } from "./lib/update-index";
import { preparePublishedUpdateIndexRelease, publishUpdateIndex } from "./lib/update-index-github";

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const DIST_DIR = join(ROOT, "dist");
const args = process.argv.slice(2);
const optionNames = args.filter((arg) => arg.startsWith("--")).map((arg) => arg.split("=")[0]);
if (new Set(optionNames).size !== optionNames.length) {
	console.error("Duplicate release option");
	process.exit(1);
}
if (args.filter((arg) => !arg.startsWith("--")).length > 1) {
	console.error("Expected one release version");
	process.exit(1);
}
const deprecatedOverwriteArg = args.find((argument) => argument.startsWith("--overwrite-release"));
if (deprecatedOverwriteArg) {
	console.error(
		"--overwrite-release is no longer supported because published release identities are immutable. Publish a new version instead.",
	);
	process.exit(1);
}
const version = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const preview = args.includes("--preview");
const skipBuild = args.includes("--skip-build");
const indexOnly = args.includes("--index-only");
const publishIndex = args.includes("--publish-index");
if (publishIndex && (!indexOnly || dryRun)) {
	console.error("--publish-index requires --index-only and cannot be combined with --dry-run");
	process.exit(1);
}
const uploadOnly = args.includes("--upload-only") || indexOnly;
const changelogArg = args.find((a) => a.startsWith("--changelog="))?.slice("--changelog=".length);
const platformArg = args.find((a) => a.startsWith("--platform="))?.slice("--platform=".length);
const target =
	args.find((a) => a.startsWith("--target="))?.slice("--target=".length) ?? "update-server";
if (target !== "github" && target !== "update-server") {
	console.error("Invalid release target; expected github or update-server");
	process.exit(1);
}
if (indexOnly && target !== "github") {
	console.error("--index-only requires --target=github");
	process.exit(1);
}
if (preview && (dryRun || target !== "update-server")) {
	console.error("--preview is an online read-only mirror preview, not --dry-run or a GitHub build");
	process.exit(1);
}
const obsolete = args.find(
	(a) => a.startsWith("--patch-from") || a.startsWith("--skip-stable-patch"),
);
if (obsolete) {
	console.error(
		`${obsolete} is obsolete: patches are generated once by GitHub Release CI from public GitHub binaries; mirrors never generate patches`,
	);
	process.exit(1);
}
if (target === "update-server" && (skipBuild || changelogArg)) {
	console.error(
		"--skip-build and --changelog are obsolete for mirrors: only already-public GitHub bytes are used; --upload-only remains compatible and needs no dist",
	);
	process.exit(1);
}
for (const argument of args.filter((arg) => arg.startsWith("--"))) {
	if (
		![
			"--dry-run",
			"--preview",
			"--skip-build",
			"--upload-only",
			"--index-only",
			"--publish-index",
		].includes(argument) &&
		!["--target=", "--github-repository=", "--platform=", "--changelog="].some((prefix) =>
			argument.startsWith(prefix),
		)
	) {
		console.error(
			`${argument} is obsolete/unsupported; mirror only public GitHub assets, with --preview for online verification`,
		);
		process.exit(1);
	}
}
if (!version) {
	console.error("Usage: bun scripts/release.ts <version> [options]");
	console.error("  --target=<target>     update-server (default mirror) or github (publication)");
	console.error("  --github-repository=<owner/repo>  Default: CI repository or GitHub origin");
	console.error("  --platform=<target>   Select platform (e.g. windows-x64)");
	console.error("  --dry-run             Offline mirror intent; GitHub build/local validation");
	console.error("  --preview             Online read-only mirror preview; no token needed");
	console.error("  --upload-only         Mirror compatibility alias (no dist); GitHub uses dist");
	console.error("  --index-only          GitHub read-only online repair; no dist/build required");
	console.error("  --publish-index       With --index-only, explicitly write the metadata branch");
	console.error("  --skip-build          GitHub local preview/legacy only: use existing dist");
	console.error("  --changelog=<file>    GitHub only: localized release notes");
	process.exit(1);
}
if (!isValidReleaseVersion(version)) {
	console.error(`Invalid version format: ${version} (expected: x.y.z or x.y.z-prerelease)`);
	process.exit(1);
}
const githubRepository =
	args.find((a) => a.startsWith("--github-repository="))?.slice("--github-repository=".length) ??
	resolveBuildGitHubRepository({ root: ROOT });
try {
	validateGitHubRepository(githubRepository);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
const platformSuffixes = resolvePlatformSuffixes(platformArg);
if (platformSuffixes.size === 0) {
	console.error(
		target === "github"
			? "Invalid platform count: no release platforms selected"
			: "Unknown platform: no release platforms selected",
	);
	process.exit(1);
}

function loadUpdateServerConfig(): { serverUrl: string; token: string } {
	const configPath = join(homedir(), ".narrafork", "update-server.json");
	let fileConfig: { serverUrl?: string; token?: string } = {};
	if (existsSync(configPath)) {
		try {
			fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch {
			// Environment overrides retain compatibility with malformed config files.
		}
	}
	return {
		serverUrl:
			process.env.NF_UPDATE_SERVER ??
			fileConfig.serverUrl ??
			"https://narrafork-update.b.domexie.cn",
		token: process.env.NF_UPDATE_TOKEN ?? fileConfig.token ?? "",
	};
}

// Mirror returns before baseline/changelog/bump/build/tag and never requires dist.
if (target === "update-server") {
	if (dryRun) {
		console.log(
			`Offline mirror intent: main ${githubRepository} v${version}; no network, build, mutation, dist or token access. Use --preview for online public Release verification.`,
		);
		process.exit(0);
	}
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25 * 60_000)]);
	try {
		const { mirrorPublishedGitHubRelease } = await import("./mirror-update-server");
		const receipt = await mirrorPublishedGitHubRelease({
			kind: "main",
			repository: githubRepository,
			tag: `v${version}`,
			...(platformArg ? { platforms: [...platformSuffixes.keys()] } : {}),
			dryRun: preview,
			signal,
			...(preview ? {} : { config: loadUpdateServerConfig() }),
		});
		console.log(JSON.stringify(receipt, null, 2));
	} catch (error) {
		console.error(
			`Mirror failed; an already-public GitHub Release is required. Publish via the primary GitHub entry first; no automatic publication is attempted. ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
	process.exit();
}

// GitHub publishing never reads update-server configuration or credentials.
let changelog: string | Record<string, string> | undefined;
const changelogPath = changelogArg ?? join(ROOT, "changelogs", `v${version}.json`);
if (existsSync(changelogPath)) {
	const raw = readFileSync(changelogPath, "utf-8");
	try {
		const parsed = JSON.parse(raw);
		changelog =
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as Record<string, string>)
				: raw;
	} catch {
		changelog = raw;
	}
	console.log(`Loaded changelog from ${changelogPath}`);
} else if (changelogArg) {
	console.error(`Changelog file not found: ${changelogArg}`);
	process.exit(1);
}
const releaseCommitPaths = ["package.json"];
if (existsSync(changelogPath)) {
	const relChangelog = relative(ROOT, changelogPath);
	if (relChangelog && !relChangelog.startsWith("..") && !isAbsolute(relChangelog)) {
		releaseCommitPaths.push(relChangelog);
	} else {
		console.warn(
			`Changelog ${changelogPath} is outside the repo; not adding it to the release commit`,
		);
	}
}
if (!uploadOnly && !dryRun) {
	const unexpectedChanges = getUnexpectedReleaseChanges(ROOT, releaseCommitPaths);
	if (unexpectedChanges.length > 0) {
		console.error(
			"Release worktree contains changes outside package.json and the version changelog:",
		);
		for (const change of unexpectedChanges) console.error(`   ${change}`);
		console.error("Commit or stash those changes before publishing so the binary matches its tag.");
		process.exit(1);
	}
}
// GitHub release operations must run in the primary checkout, never an isolated worktree.
if (!dryRun && (!indexOnly || publishIndex)) {
	const gitDirectories = execFileSync(
		"git",
		["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
		{ cwd: ROOT, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 },
	)
		.trim()
		.split("\n");
	if (gitDirectories.length !== 2 || gitDirectories[0] !== gitDirectories[1]) {
		console.error("GitHub releases must run in the primary repository checkout, not a worktree");
		process.exit(1);
	}
}

// Reject unsupported delegated-publication options before package writes or Git commits.
if (!dryRun && !indexOnly) {
	try {
		const source =
			resolveGitCommit(ROOT, `refs/tags/v${version}`) ?? resolveGitCommit(ROOT, "HEAD");
		if (
			source &&
			releaseSourceDeclaresRemotePeer(ROOT, source) &&
			(platformArg || changelogArg || skipBuild)
		)
			throw new Error(
				"A normal release with remote-peer uses the complete native CI matrix and committed changelogs/v<version>.json; --platform/--changelog/--skip-build are local preview or legacy options only",
			);
	} catch (error) {
		console.error(
			`Release option preflight failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}

// ── Step 1: Version bump ────────────────────────────────────────────────────
if (!uploadOnly) {
	const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
	const oldVersion = pkg.version;
	if (oldVersion === version) {
		console.log(`Version already ${version}, skipping bump`);
	} else {
		pkg.version = version;
		writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, "\t")}\n`);
		console.log(`Version bumped: ${oldVersion} → ${version}`);
	}
}

// ── Step 2: Git release commit ──────────────────────────────────────────────
if (!uploadOnly && !dryRun) {
	try {
		const status = execFileSync(
			"git",
			["status", "--porcelain=v1", "--untracked-files=all", "--", ...releaseCommitPaths],
			{ cwd: ROOT, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
		).trim();
		if (status) {
			execFileSync("git", ["add", "--", ...releaseCommitPaths], {
				cwd: ROOT,
				stdio: "inherit",
				timeout: 120_000,
			});
			execFileSync("git", ["commit", "-m", `release: v${version}`], {
				cwd: ROOT,
				stdio: "inherit",
				timeout: 120_000,
			});
			console.log(`Committed release: v${version}`);
		}
		const remainingChanges = getUnexpectedReleaseChanges(ROOT);
		if (remainingChanges.length > 0) {
			console.error("Release commit did not leave a clean worktree:");
			for (const change of remainingChanges) console.error(`   ${change}`);
			process.exit(1);
		}
	} catch (err) {
		console.error(`Git release commit failed: ${err}`);
		process.exit(1);
	}
}

// A real release with an optional peer uses the ordinary protected main CI run.
// This is deliberately after the mirror/index/dry-run boundaries and source commit,
// but before local product compilation: the main plan freezes peer identity first.
if (!dryRun && !indexOnly) {
	try {
		const tagRef = `refs/tags/v${version}`;
		const sourceCommit = resolveGitCommit(ROOT, tagRef) ?? resolveGitCommit(ROOT, "HEAD");
		if (!sourceCommit) throw new Error("Cannot resolve release source");
		if (releaseSourceDeclaresRemotePeer(ROOT, sourceCommit)) {
			if (platformArg || changelogArg || skipBuild)
				throw new Error(
					"A normal release with remote-peer uses the complete native CI matrix and committed changelogs/v<version>.json; --platform/--changelog are local preview options only",
				);
			if (!uploadOnly) {
				const head = resolveGitCommit(ROOT, "HEAD");
				if (!head || head !== sourceCommit || getUnexpectedReleaseChanges(ROOT).length > 0)
					throw new Error("Release source must be a clean HEAD before delegating to main CI");
				const existing = resolveGitCommit(ROOT, tagRef);
				if (existing && existing !== head) throw new Error("Existing NF tag does not match HEAD");
				if (!existing) {
					execFileSync("git", ["tag", `v${version}`], {
						cwd: ROOT,
						stdio: "inherit",
						timeout: 10_000,
					});
					console.log(
						`Tagged source v${version}; native build and peer release are handled by main CI`,
					);
				}
			}
			console.log(
				"Normal NF publication uses main Release CI; remote-peer updates are automatic, with no separate component publish command. Local dist is not uploaded on this path.",
			);
			const controller = new AbortController();
			const cancel = () =>
				controller.abort(
					new Error("Release wait cancelled; inspect the existing Actions run before retrying"),
				);
			process.once("SIGINT", cancel);
			process.once("SIGTERM", cancel);
			try {
				const receipt = await dispatchMainRelease({
					repository: githubRepository,
					version,
					commit: sourceCommit,
					signal: controller.signal,
					log: console.log,
				});
				console.log(
					`Main release run ${receipt.runId} succeeded: NF and any updated remote-peer were published by the same protected flow`,
				);
			} finally {
				process.removeListener("SIGINT", cancel);
				process.removeListener("SIGTERM", cancel);
			}
			process.exit(0);
		}
	} catch (error) {
		console.error(
			`Main release delegation failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}

// ── Step 3: Build ───────────────────────────────────────────────────────────
if (!skipBuild && !uploadOnly) {
	console.log(`Building ${platformArg ? `platform ${platformArg}` : "all platforms"}...`);
	const buildArgs = [
		"scripts/build-cross-platform.ts",
		...(platformArg ? [`--platform=${platformArg}`] : []),
	];
	try {
		execFileSync("bun", buildArgs, {
			cwd: ROOT,
			env: { ...process.env, NF_BUILD_GITHUB_REPOSITORY: githubRepository },
			stdio: "inherit",
			timeout: 600_000,
		});
	} catch {
		console.error("Build failed");
		process.exit(1);
	}
}

// ── Step 4: Tag the successfully built commit ───────────────────────────────
if (!uploadOnly && !dryRun) {
	try {
		const postBuildChanges = getUnexpectedReleaseChanges(ROOT);
		if (postBuildChanges.length > 0) {
			console.error("Build changed repository files after the release commit:");
			for (const change of postBuildChanges) console.error(`   ${change}`);
			console.error("Commit deterministic generated sources before tagging the release.");
			process.exit(1);
		}
		const headCommit = resolveGitCommit(ROOT, "HEAD");
		if (!headCommit) throw new Error("Cannot resolve HEAD");
		const tagRef = `refs/tags/v${version}`;
		const taggedCommit = resolveGitCommit(ROOT, tagRef);
		if (taggedCommit && taggedCommit !== headCommit) {
			console.error(
				`Tag v${version} already points to ${taggedCommit.slice(0, 12)}, not HEAD ${headCommit.slice(0, 12)}`,
			);
			process.exit(1);
		}
		if (taggedCommit) {
			console.log(`Tag v${version} already points to HEAD, skipping`);
		} else {
			execFileSync("git", ["tag", `v${version}`], { cwd: ROOT, stdio: "inherit", timeout: 10_000 });
			console.log(`Tagged: v${version}`);
		}
	} catch (err) {
		console.error(`Git tag failed: ${err}`);
		process.exit(1);
	}
}

// ── Step 5: GitHub publication / index repair ───────────────────────────────
let publicReleaseConfirmed = false;
try {
	const commit =
		resolveGitCommit(ROOT, `refs/tags/v${version}`) ??
		(dryRun && !indexOnly ? resolveGitCommit(ROOT, "HEAD") : null);
	if (!commit) throw new Error(`Missing local release tag v${version}`);
	if (indexOnly) {
		const prepared = await preparePublishedUpdateIndexRelease({
			repository: githubRepository,
			version,
			commit,
			changelog,
		});
		publicReleaseConfirmed = true;
		if (!publishIndex) {
			console.log(JSON.stringify(prepared, null, 2));
			console.log(
				"Read-only index repair preview complete; use --publish-index to write the metadata branch. No local dist is required and no Release/ref was changed.",
			);
			process.exit(0);
		}
		const receipt = await publishUpdateIndex({ repository: githubRepository, ...prepared });
		console.log(
			`GitHub update index repaired at ${receipt.commit} (generation ${receipt.generation}); Release assets unchanged`,
		);
		process.exit(0);
	}
	const options = {
		distDir: DIST_DIR,
		version,
		repository: githubRepository,
		platformSuffixes,
		commit,
		changelog,
		requireBuildRepository: true,
	};
	await validatePublishedPatchSources({ ...options, dryRun });
	const prepared = await prepareUpdateIndexRelease(options);
	const result = await publishGitHubRelease({ ...options, dryRun });
	if (!dryRun) {
		publicReleaseConfirmed = true;
		const receipt = await publishUpdateIndex({ repository: githubRepository, ...prepared });
		console.log(`GitHub update index: ${receipt.commit} (generation ${receipt.generation})`);
	}
	console.log(
		result.dryRun
			? `Dry run complete — validated ${result.assets.length} GitHub assets and bounded update-index record; no GitHub calls made`
			: `GitHub release v${version}: ${result.alreadyPublished ? "already published and verified" : "published"}`,
	);
	process.exit(0);
} catch (error) {
	console.error(
		`${publicReleaseConfirmed ? "PUBLISHED_NOT_INDEXED: Release is public; repair its index without rebuilding" : "GitHub release failed (any draft is retained)"}: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}
