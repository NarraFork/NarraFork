import { z } from "zod";
import { isValidGitHubRepository } from "../../shared/github-repository";
import type { GhRunner } from "./github-release";

export interface GitHubReleaseSummary {
	id: number;
	tagName: string;
	draft: boolean;
	prerelease: boolean;
	publishedAt: string | null;
	assetCount: number;
}

const query = `query($owner:String!,$name:String!,$cursor:String){
 repository(owner:$owner,name:$name){nameWithOwner releases(first:100,after:$cursor){
 nodes{databaseId tagName isDraft isPrerelease publishedAt releaseAssets(first:1){totalCount}}
 pageInfo{hasNextPage endCursor}
 }}}
`;
const nodeSchema = z.object({
	databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	tagName: z.string().min(1).max(255),
	isDraft: z.boolean(),
	isPrerelease: z.boolean(),
	publishedAt: z.string().datetime().nullable(),
	releaseAssets: z.object({
		totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	}),
});
const responseSchema = z.object({
	data: z.object({
		repository: z.object({
			nameWithOwner: z.string().refine(isValidGitHubRepository),
			releases: z.object({
				nodes: z.array(nodeSchema).max(100),
				pageInfo: z.object({
					hasNextPage: z.boolean(),
					endCursor: z.string().min(1).max(1024).nullable(),
				}),
			}),
		}),
	}),
});

/** Bounded summaries only: never fetch release bodies or inline asset collections. */
export async function listGitHubReleaseSummaries(
	run: GhRunner,
	repository: string,
): Promise<GitHubReleaseSummary[]> {
	if (!isValidGitHubRepository(repository)) throw new Error("Invalid GitHub repository");
	const [owner, name] = repository.split("/");
	const releases: GitHubReleaseSummary[] = [];
	const ids = new Set<number>();
	const cursors = new Set<string>();
	let cursor: string | null = null;
	for (let page = 0; page < 10; page++) {
		const args = [
			"api",
			"graphql",
			"-f",
			`query=${query}`,
			"-f",
			`owner=${owner}`,
			"-f",
			`name=${name}`,
		];
		if (cursor !== null) args.push("-f", `cursor=${cursor}`);
		const raw = await run(args);
		if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("GitHub API output limit");
		const value = JSON.parse(raw);
		if (value?.errors !== undefined) throw new Error("GitHub release summary GraphQL errors");
		const result = responseSchema.parse(value).data.repository;
		if (result.nameWithOwner.toLowerCase() !== repository.toLowerCase())
			throw new Error("GitHub release summary repository mismatch");
		const { nodes, pageInfo } = result.releases;
		for (const node of nodes) {
			if (ids.has(node.databaseId)) throw new Error("Duplicate GitHub release summary");
			ids.add(node.databaseId);
			releases.push({
				id: node.databaseId,
				tagName: node.tagName,
				draft: node.isDraft,
				prerelease: node.isPrerelease,
				publishedAt: node.publishedAt,
				assetCount: node.releaseAssets.totalCount,
			});
		}
		if (!pageInfo.hasNextPage) return releases;
		if (nodes.length !== 100 || !pageInfo.endCursor || cursors.has(pageInfo.endCursor))
			throw new Error("Invalid GitHub release summary pagination");
		cursor = pageInfo.endCursor;
		cursors.add(cursor);
	}
	throw new Error("GitHub release summary pagination limit reached");
}
