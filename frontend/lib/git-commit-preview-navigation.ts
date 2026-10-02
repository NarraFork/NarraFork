import { GIT_COMMIT_SHA_PATTERN } from "@shared/git-commit-preview";
import { defaultStringifySearch } from "@tanstack/react-router";
import type { GitTarget } from "./api/git";
import { assetUrl } from "./base-path";

export const COMMIT_PREVIEW_FILE_MAX_LENGTH = 4096;
const WORKSPACE_KEY_MAX_LENGTH = 4096;

export interface CommitPreviewSearch {
	file?: string;
	workspaceKey?: string;
	/** Invalid input is rendered in-page, preserving the fixed owner backlink. */
	invalid?: true;
}

export function validateCommitPreviewSearch(search: Record<string, unknown>): CommitPreviewSearch {
	const { file, workspaceKey } = search;
	// Keep rejection stable through the Router's canonical URL replacement.
	if (search.invalid === true) return { invalid: true };
	if (
		(file !== undefined &&
			(typeof file !== "string" || !file.length || file.length > COMMIT_PREVIEW_FILE_MAX_LENGTH)) ||
		(workspaceKey !== undefined &&
			(typeof workspaceKey !== "string" ||
				!workspaceKey.length ||
				workspaceKey.length > WORKSPACE_KEY_MAX_LENGTH))
	) {
		return { invalid: true };
	}
	// Ignore all other keys. In particular, rootPath/cwd/canWrite are never authority.
	return { file: file as string | undefined, workspaceKey: workspaceKey as string | undefined };
}

/** Internal Router address; its basepath is added by Router navigation. */
export function buildCommitPreviewHref(
	target: GitTarget,
	sha: string,
	file?: string | null,
): string {
	if (!GIT_COMMIT_SHA_PATTERN.test(sha)) throw new Error("A full commit SHA is required");
	const owner =
		typeof target === "string"
			? `chapters/${encodeURIComponent(target)}`
			: `narrators/${encodeURIComponent(target.narratorId)}`;
	// Use the Router's own string encoding: numeric/JSON-looking filenames must
	// be quoted or its default parser would silently change their value/type.
	const params = new URLSearchParams(
		defaultStringifySearch({
			file: file ?? undefined,
			workspaceKey: typeof target === "string" ? undefined : target.workspaceKey,
		}),
	);
	const query = params.toString();
	return `/git/${owner}/commits/${sha.toLowerCase()}${query ? `?${query}` : ""}`;
}

/** Browser address for native anchors and copied links, including the app mount. */
export function buildCommitPreviewBrowserHref(
	target: GitTarget,
	sha: string,
	file?: string | null,
): string {
	return assetUrl(buildCommitPreviewHref(target, sha, file));
}
