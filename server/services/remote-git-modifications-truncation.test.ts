import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { db } from "../db";
import { narrators, remoteDevices, users } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { localBackend, setRemoteBackendResolver } from "../lib/agent/execution/registry";
import { generateId } from "../lib/id";
import { narratorGitRoutes } from "../routes/git";

afterEach(() => setRemoteBackendResolver(null));

for (const [count, upstreamTruncated] of [
	[200, false],
	[201, false],
	[1, true],
	[0, true],
] as const) {
	test(`remote modifications preserve incompleteness for ${count} files, upstream ${upstreamTruncated}`, async () => {
		const owner = generateId();
		const deviceId = generateId();
		const narratorId = generateId();
		const root = `/remote-fixture/${narratorId}`;
		const timestamp = new Date().toISOString();
		await db.insert(users).values({
			id: owner,
			username: owner,
			passwordHash: "fixture",
			createdAt: timestamp,
		});
		await db.insert(remoteDevices).values({
			id: deviceId,
			name: "Remote truncation fixture",
			slug: deviceId,
			tokenHash: deviceId,
			tokenPrefix: "fixture",
			createdBy: owner,
			scope: "global",
			ownerScope: "private",
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		await db.insert(narrators).values({
			id: narratorId,
			title: "Remote truncation fixture",
			cwd: root,
			defaultDeviceId: deviceId,
			ownerUserId: owner,
			visibility: "private",
			writeAudience: "owner",
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		const backend = {
			...localBackend,
			kind: "remote",
			deviceId,
			runtimeGeneration: 1,
			defaultCwd: root,
			supportsGitWorkspace: true,
			async gitWorkspace(input: { operation: string }) {
				if (input.operation === "probe")
					return { state: "ready", rootPath: root, repositoryPath: `${root}/.git` };
				if (input.operation === "status")
					return {
						outputs: {
							status: Array.from({ length: count }, (_, i) => `?? file-${i}.txt\0`).join(""),
						},
						truncated: upstreamTruncated,
					};
				throw new Error(`Unexpected operation: ${input.operation}`);
			},
			resolvePathIdentity: async (path: string) => ({
				lexicalPath: path,
				canonicalPath: path,
				exists: true,
				runtimeGeneration: 1,
			}),
		} as unknown as ExecutionBackend;
		setRemoteBackendResolver(() => backend);
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("user", { sub: owner, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		});
		app.route("/narrators", narratorGitRoutes);
		const response = await app.request(
			`/narrators/${narratorId}/git/modifications?scope=uncommitted`,
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		const incomplete = upstreamTruncated || count > 200;
		expect(body.hasMore).toBe(incomplete);
		expect(body.completeness).toMatchObject({
			fileHistoryComplete: !incomplete,
			contributorsTruncated: incomplete,
			countsLowerBound: incomplete,
			warningScanComplete: !incomplete,
		});
	});
}
