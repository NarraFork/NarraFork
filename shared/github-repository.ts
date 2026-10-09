export const OFFICIAL_GITHUB_REPOSITORY = "NarraFork/NarraFork";

/** Only an owner/repo slug, never a URL, hostname, or traversal path. */
export function isValidGitHubRepository(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 140 || value.includes("..") || /\s/.test(value))
		return false;
	const parts = value.split("/");
	if (parts.length !== 2) return false;
	const [owner, repo] = parts;
	return (
		owner.length <= 39 &&
		/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(owner) &&
		repo.length >= 1 &&
		repo.length <= 100 &&
		repo !== "." &&
		/^[a-zA-Z0-9_.-]+$/.test(repo)
	);
}
