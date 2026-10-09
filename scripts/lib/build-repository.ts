import { execFileSync } from "node:child_process";
import {
	isValidGitHubRepository,
	OFFICIAL_GITHUB_REPOSITORY,
} from "../../shared/github-repository";

export function githubRepositoryFromOrigin(origin: string): string | undefined {
	const match =
		/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^\s?#]+)$/.exec(
			origin,
		);
	const repository = match?.[1].replace(/\.git$/, "");
	return isValidGitHubRepository(repository) ? repository : undefined;
}

/** Build-time only; root is the source checkout, never an application project. */
export function resolveBuildGitHubRepository(options: {
	root: string;
	env?: NodeJS.ProcessEnv;
	origin?: string;
}): string {
	const env = options.env ?? process.env;
	const explicit = env.NF_BUILD_GITHUB_REPOSITORY;
	const ci = env.GITHUB_ACTIONS === "true";
	if (explicit !== undefined && !isValidGitHubRepository(explicit))
		throw new Error("Invalid NF_BUILD_GITHUB_REPOSITORY");
	if (ci && !isValidGitHubRepository(env.GITHUB_REPOSITORY))
		throw new Error("Invalid CI GITHUB_REPOSITORY");
	if (ci && explicit !== undefined && explicit !== env.GITHUB_REPOSITORY)
		throw new Error("Build repository must match CI GITHUB_REPOSITORY");
	if (explicit) return explicit;
	if (ci) return env.GITHUB_REPOSITORY as string;
	let origin = options.origin;
	if (origin === undefined) {
		try {
			origin = execFileSync("git", ["remote", "get-url", "origin"], {
				cwd: options.root,
				encoding: "utf8",
				timeout: 5000,
				maxBuffer: 16 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch {
			// Source archives without git retain the official compatibility default.
		}
	}
	return githubRepositoryFromOrigin(origin ?? "") ?? OFFICIAL_GITHUB_REPOSITORY;
}
