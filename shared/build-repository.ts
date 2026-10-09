import { isValidGitHubRepository, OFFICIAL_GITHUB_REPOSITORY } from "./github-repository";

declare const __NARRAFORK_BUILD_REPOSITORY__: string;

// A compile-time constant only. Never inspect runtime env or the user's working repository.
const repository =
	typeof __NARRAFORK_BUILD_REPOSITORY__ === "undefined"
		? OFFICIAL_GITHUB_REPOSITORY
		: __NARRAFORK_BUILD_REPOSITORY__;
if (!isValidGitHubRepository(repository)) throw new Error("Invalid compiled GitHub repository");
export const BUILD_GITHUB_REPOSITORY: string = repository;
