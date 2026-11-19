import { describe, expect, test } from "bun:test";
import { currentPublicRelease } from "../../scripts/lib/mirror-public-github";
import { IndependentMirrorError } from "../../scripts/lib/update-server-main-mirror";
import { mirrorPublishedGitHubRelease } from "../../scripts/mirror-update-server";
import { mirrorFixture, repository } from "./mirror-fixture";

/** Regression for the real long-running main staging failure: no network, credentials or delay. */
describe("public GitHub asset identity excludes volatile response fields", () => {
	for (const volatile of ["download_count", "label", "url", "browser_download_url"])
		test(`${volatile} changes do not alter validated byte identity`, async () => {
			const f = mirrorFixture();
			Object.assign(f.assets[0], { [volatile]: volatile === "download_count" ? 40 : "old" });
			const before = await currentPublicRelease(f.run, repository, "v1.2.0");
			Object.assign(f.assets[0], { [volatile]: volatile === "download_count" ? 41 : "new" });
			const after = await currentPublicRelease(f.run, repository, "v1.2.0");
			expect(after.assets).toEqual(before.assets);
			expect(Object.keys(after.assets[0]).sort()).toEqual([
				"digest",
				"id",
				"name",
				"size",
				"state",
			]);
		});
	for (const field of ["id", "name", "size", "digest", "state"] as const)
		test(`${field} remains a binding identity or strict validation field`, async () => {
			const f = mirrorFixture();
			const before = await currentPublicRelease(f.run, repository, "v1.2.0");
			Object.assign(f.assets[0], {
				[field]: {
					id: 999,
					name: "renamed-asset",
					size: f.assets[0].size + 1,
					digest: `sha256:${"f".repeat(64)}`,
					state: "deleted",
				}[field],
			});
			if (field === "state")
				await expect(currentPublicRelease(f.run, repository, "v1.2.0")).rejects.toThrow(
					"digest/identity",
				);
			else
				expect((await currentPublicRelease(f.run, repository, "v1.2.0")).assets).not.toEqual(
					before.assets,
				);
		});
});

describe("main staging final authority regression", () => {
	for (const mutation of [
		"none",
		"download_count",
		"label",
		"url",
		"browser_download_url",
		"id",
		"name",
		"size",
		"digest",
		"state",
	] as const)
		test(`nine-minute staging accepts only unchanged identity: ${mutation}`, async () => {
			const f = mirrorFixture();
			Object.assign(f.assets[0], {
				download_count: 40,
				label: "old",
				url: "old",
				browser_download_url: "old",
			});
			const writes: string[] = [];
			const binaryId = f.assets[0].id;
			let now = Date.parse("2026-10-15T03:05:00.000Z");
			const client = {
				ensureCollection: async () => {},
				list: async () => [],
				deleteCollection: async () => {},
				put: async (path: string, body: ReadableStream<Uint8Array> | Uint8Array) => {
					if (body instanceof ReadableStream) await new Response(body).arrayBuffer();
					writes.push(path);
					return "created" as const;
				},
			};
			const operation = mirrorPublishedGitHubRelease({
				kind: "main",
				repository,
				tag: "v1.2.0",
				transport: "webdav",
				run: f.run,
				relay: {
					config: {
						url: "https://fixture-relay.invalid/private/",
						feed: "default",
						auth: { bearerToken: "fixture-token" },
					},
					signingKey: Buffer.alloc(32, 7).toString("base64"),
					client,
					now: () => new Date(now),
				},
				downloadAsset: async (options) => {
					await f.downloadAsset(options);
					if (options.assetId !== binaryId) return;
					now += 9 * 60_000;
					if (mutation !== "none")
						Object.assign(f.assets[0], {
							[mutation]: {
								download_count: 41,
								label: "new",
								url: "new",
								browser_download_url: "new",
								id: 999,
								name: "renamed-asset",
								size: f.assets[0].size + 1,
								digest: `sha256:${"f".repeat(64)}`,
								state: "deleted",
							}[mutation],
						});
				},
			});
			if (["id", "name", "size", "digest", "state"].includes(mutation)) {
				try {
					await operation;
					throw new Error("expected production rejection");
				} catch (error) {
					expect(error).toBeInstanceOf(IndependentMirrorError);
					const receipt = (error as IndependentMirrorError).receipt;
					expect(receipt.status).toBe("FAILED");
					expect(receipt.failureCode).toBe("MIRROR_FAILED");
					expect(receipt.uploaded).toHaveLength(5);
					expect(receipt.verified).toEqual([]);
					expect(receipt.relay).toBeUndefined();
				}
				expect(writes).toHaveLength(6); // five assets + commit payload, but no ready
				expect(writes.every((path) => path.includes("/objects/"))).toBe(true);
			} else {
				const receipt = await operation;
				expect(receipt.status).toBe("STAGED_FOR_PULL");
				expect(receipt.uploaded).toHaveLength(5);
				expect(receipt.verified).toEqual([]);
				expect(receipt.relay?.expiresAt).toBe("2026-10-22T03:05:00.000Z");
				expect(writes).toHaveLength(7);
				expect(writes.at(-1)).toContain("/ready/");
			}
			expect(f.httpCalls).toHaveLength(0);
		});
});
