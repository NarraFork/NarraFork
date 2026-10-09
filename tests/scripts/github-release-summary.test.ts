import { describe, expect, test } from "bun:test";
import { listGitHubReleaseSummaries } from "../../scripts/lib/github-release-summary";

const repository = "Example/Custom";
function page(start = 1, length = 1, hasNextPage = false, endCursor: string | null = null) {
	return {
		data: {
			repository: {
				nameWithOwner: repository,
				releases: {
					nodes: Array.from({ length }, (_, index) => ({
						databaseId: start + index,
						tagName: `v1.${start + index}.0`,
						isDraft: false,
						isPrerelease: false,
						publishedAt: "2026-10-08T00:00:00Z",
						releaseAssets: { totalCount: 160 },
					})),
					pageInfo: { hasNextPage, endCursor },
				},
			},
		},
	};
}

describe("bounded GitHub release summaries", () => {
	test("requests only lightweight GraphQL fields and maps releases", async () => {
		const calls: string[][] = [];
		const result = await listGitHubReleaseSummaries((args) => {
			calls.push(args);
			return JSON.stringify(page());
		}, repository);
		expect(result).toEqual([
			{
				id: 1,
				tagName: "v1.1.0",
				draft: false,
				prerelease: false,
				publishedAt: "2026-10-08T00:00:00Z",
				assetCount: 160,
			},
		]);
		const args = calls[0];
		expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
		expect(args).toContain("owner=Example");
		expect(args).toContain("name=Custom");
		const query = args.find((arg) => arg.startsWith("query=")) ?? "";
		expect(query).toContain("releases(first:100,after:$cursor)");
		expect(query).toContain("releaseAssets(first:1){totalCount}");
		expect(query).not.toMatch(/\b(body|description|downloadUrl|url)\b/);
	});
	test("cursor pagination accepts a complete last full page", async () => {
		let calls = 0;
		const result = await listGitHubReleaseSummaries((args) => {
			calls++;
			if (calls === 2) expect(args).toContain("cursor=next");
			return JSON.stringify(calls === 1 ? page(1, 100, true, "next") : page(101, 100));
		}, repository);
		expect(result).toHaveLength(200);
		expect(calls).toBe(2);
	});
	test("ten pages cannot silently truncate additional releases", async () => {
		let calls = 0;
		await expect(
			listGitHubReleaseSummaries(() => {
				calls++;
				return JSON.stringify(page(calls * 100, 100, true, String(calls)));
			}, repository),
		).rejects.toThrow("pagination limit");
		expect(calls).toBe(10);
	});
	test("fails on invalid nodes, foreign repository, GraphQL errors and bad pages", async () => {
		const invalid: unknown[] = [null, {}, { errors: [{ message: "rate limit" }], ...page() }];
		for (const mutate of [
			(value: ReturnType<typeof page>) => {
				value.data.repository.nameWithOwner = "Other/Repo";
			},
			(value: ReturnType<typeof page>) => {
				value.data.repository.releases.nodes[0].databaseId = 0;
			},
			(value: ReturnType<typeof page>) => {
				value.data.repository.releases.nodes[0].releaseAssets.totalCount = -1;
			},
			(value: ReturnType<typeof page>) => {
				value.data.repository.releases.nodes.push(value.data.repository.releases.nodes[0]);
			},
			(value: ReturnType<typeof page>) => {
				value.data.repository.releases.pageInfo.hasNextPage = true;
			},
		]) {
			const value = page();
			mutate(value);
			invalid.push(value);
		}
		for (const value of invalid)
			await expect(
				listGitHubReleaseSummaries(() => JSON.stringify(value), repository),
			).rejects.toThrow();
		await expect(listGitHubReleaseSummaries(() => "{", repository)).rejects.toThrow();
		await expect(
			listGitHubReleaseSummaries(() => " ".repeat(1024 * 1024 + 1), repository),
		).rejects.toThrow("limit");
	});
	test("repeated cursors and transport errors are not an empty history", async () => {
		let calls = 0;
		await expect(
			listGitHubReleaseSummaries(
				() => JSON.stringify(page(++calls * 100, 100, true, "same")),
				repository,
			),
		).rejects.toThrow("pagination");
		await expect(
			listGitHubReleaseSummaries(() => {
				throw new Error("HTTP 403");
			}, repository),
		).rejects.toThrow("403");
	});
});
