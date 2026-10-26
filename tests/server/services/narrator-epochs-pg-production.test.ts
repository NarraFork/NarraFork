import { expect, mock, test } from "bun:test";
import { createPostgresClient } from "../../../server/db/postgres-client";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
} from "../../../server/db/postgres-schema";
import { withPostgres } from "../../db/pg-test-harness";
import { getTestDb } from "../../setup";
import { migrationSql } from "./read/pg-parity-matrix";

getTestDb();
const realDb = { ...(await import("../../../server/db")) };
const realAgent = { ...(await import("../../../server/lib/agent")) };

const integration = process.env.PG_INTEGRATION === "1" ? test : test.skip;

integration(
	"PG17 production epoch JSON projection and latest top-level step",
	async () => {
		const outcome = await withPostgres(async ({ port, credentials, exec }) => {
			for (const migration of await migrationSql()) expect((await exec(migration)).code).toBe(0);
			const client = createPostgresClient({
				driver: "bun-sql",
				url: `postgres://${credentials.user}:${credentials.password}@127.0.0.1:${port}/${credentials.database}`,
			});
			try {
				mock.module("../../../server/lib/agent", () => ({
					...realAgent,
					resolveEpochTarget: (model: string) => ({ fingerprint: model, cacheTtlMs: null }),
				}));
				mock.module("../../../server/db", () => ({
					...realDb,
					db: client.db,
					activeDatabaseBackend: "postgres",
				}));

				mock.module("../../../server/services/narrator-store", () => ({
					narratorStore: {
						openEpoch: async () => ({ id: "epoch-new" }),
						appendToolChange: async () => {},
					},
				}));
				const { toolLoadingEpochOf, reconcileEpoch } = await import(
					"../../../server/services/narrator-epochs"
				);
				await client.db.insert(narrators).values({
					id: "epoch-pg",
					createdAt: "2024-01-01T00:00:00.000Z",
					updatedAt: "2024-01-01T00:00:00.000Z",
				});
				const message = (
					id: string,
					role: string,
					contentJson: unknown[],
					extra: Record<string, unknown> = {},
				) => ({
					id,
					narratorId: "epoch-pg",
					role,
					contentJson,
					createdAt: "2024-01-01T00:00:00.000Z",
					...extra,
				});
				await client.db.insert(narratorMessages).values([
					message("compact-old", "system", [
						{
							type: "compact",
							status: "complete",
							epoch: { reason: "compact", toolNames: ["old"] },
						},
					]),
					message("compact-current", "system", [
						{
							type: "compact",
							status: "complete",
							epoch: {
								reason: "compact",
								target: "test",
								toolNames: ["mcp__one__read"],
								definitionSnapshots: [
									{ name: "mcp__one__read", description: "one", parameters: { type: "object" } },
								],
							},
						},
					]),
					message("step-old", "assistant", [{ type: "text", text: "old" }], {
						provider: "old-provider",
						model: "old-model",
						createdAt: "2020-01-01T00:00:00.000Z",
					}),
					message("step-current", "assistant", [{ type: "text", text: "current" }], {
						provider: "test-provider",
						model: "test-model",
					}),
					message("step-child", "assistant", [{ type: "text", text: "child" }], {
						parentToolUseId: "step-current",
						provider: "wrong-provider",
						model: "wrong-model",
					}),
				]);
				await client.db.insert(narratorMessageRefs).values([
					{ id: "r1", narratorId: "epoch-pg", messageId: "compact-old", seq: 0, isCompact: 1 },
					{ id: "r2", narratorId: "epoch-pg", messageId: "compact-current", seq: 1, isCompact: 1 },
					{ id: "r3", narratorId: "epoch-pg", messageId: "step-old", seq: 2 },
					{ id: "r4", narratorId: "epoch-pg", messageId: "step-child", seq: 3 },
					{ id: "r5", narratorId: "epoch-pg", messageId: "step-current", seq: 4 },
				]);
				expect(await toolLoadingEpochOf("epoch-pg", [])).toMatchObject({
					target: "test",
					toolNames: ["mcp__one__read"],
				});
				const result = await reconcileEpoch({
					narratorId: "epoch-pg",
					messages: [],
					managed: new Set(["mcp__one__read"]),
					current: ["mcp__one__read"],
					model: "next",
					provider: "next",
					noticeText: () => "notice",
					resolveTarget: (model) => ({ fingerprint: model, cacheTtlMs: null }),
				});
				expect(result).toMatchObject({
					changed: true,
					epoch: { markerId: "epoch-new", target: "next" },
				});
			} catch (error) {
				console.error("PG epoch fixture failed", error);
				throw error;
			} finally {
				mock.module("../../../server/db", () => realDb);
				mock.module("../../../server/lib/agent", () => realAgent);
				mock.restore();
				await client.close();
			}
		});
		expect(outcome).toBeUndefined();
	},
	60_000,
);
