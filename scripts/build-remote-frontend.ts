import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseRemoteFrontendCapability } from "../shared/remote-access/application";
import { remoteFrontendArtifactNames } from "../shared/remote-access/frontend-manifest";
import { resolveBuildGitHubRepository } from "./lib/build-repository";
import { runPublicationProcess } from "./lib/ci-publication-runtime";
import { buildRemoteFrontendArtifact } from "./lib/remote-frontend-artifact";

export async function buildRemoteFrontendCLI(
	args: string[] = process.argv.slice(2),
): Promise<void> {
	if (args.includes("--help")) {
		console.log(
			"Usage: bun scripts/build-remote-frontend.ts [--skip-build] [--output=DIR] [--repository=owner/repo] [--version=X.Y.Z] [--commit=40_HEX_SHA]",
		);
		return;
	}
	const root = resolve(import.meta.dirname, "..");
	const values = new Map<string, string>();
	let skipBuild = false;
	for (const arg of args) {
		if (arg === "--skip-build" && !skipBuild) {
			skipBuild = true;
			continue;
		}
		const match = /^--(output|repository|version|commit)=(.+)$/.exec(arg);
		if (!match || values.has(match[1])) throw new Error("REMOTE_FRONTEND_CLI_ARGUMENT_INVALID");
		values.set(match[1], match[2]);
	}
	const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
		version: string;
	};
	const version = values.get("version") ?? packageInfo.version;
	if (version !== packageInfo.version) throw new Error("REMOTE_FRONTEND_SOURCE_VERSION_MISMATCH");
	const repository = values.get("repository") ?? resolveBuildGitHubRepository({ root });
	const commit =
		values.get("commit") ??
		process.env.NF_BUILD_COMMIT ??
		(
			await runPublicationProcess("git", ["-C", root, "rev-parse", "HEAD"], {
				timeoutMs: 5000,
				maximumOutputBytes: 8192,
			})
		).trim();
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("REMOTE_FRONTEND_SOURCE_COMMIT_INVALID");
	const capability = parseRemoteFrontendCapability(
		JSON.parse(await readFile(join(root, "shared/remote-access/frontend-capability.json"), "utf8")),
	);
	const stop = new AbortController();
	const cancel = () => stop.abort(new Error("REMOTE_FRONTEND_BUILD_CANCELLED"));
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		if (!skipBuild)
			await runPublicationProcess(
				process.execPath,
				[
					join(root, "node_modules/vite/bin/vite.js"),
					"build",
					"--config",
					join(root, "frontend/vite.remote.config.ts"),
				],
				{
					signal: stop.signal,
					timeoutMs: 10 * 60_000,
					maximumOutputBytes: 1024 * 1024,
					environment: { ...process.env, NF_BUILD_GITHUB_REPOSITORY: repository },
				},
			);
		const outputDir = resolve(values.get("output") ?? join(root, "dist"));
		const manifest = await buildRemoteFrontendArtifact({
			root,
			inputDir: join(root, "dist/frontend-remote"),
			outputDir,
			target: { repository, version, commit, capability },
			signal: stop.signal,
		});
		console.log(
			JSON.stringify({
				buildId: manifest.buildId,
				outputDir,
				...remoteFrontendArtifactNames(version),
			}),
		);
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}
if (import.meta.main)
	buildRemoteFrontendCLI().catch((error) => {
		console.error(error instanceof Error ? error.message : "REMOTE_FRONTEND_BUILD_FAILED");
		process.exitCode = 1;
	});
