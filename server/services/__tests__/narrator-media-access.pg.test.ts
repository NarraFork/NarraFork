/**
 * The upload reference lookup against a real PostgreSQL: the `octet_length` window
 * sizing and the `strpos` prefilter run in the database, not in a fake, so an argument
 * swap or a type mismatch in that SQL fails here.
 *
 * Gated by PG_INTEGRATION=1: when integration is requested, an unavailable database must
 * FAIL the test, never pass as "blocked".
 */
import { afterAll, expect, mock, test } from "bun:test";
import { mediaRefToContentBlock } from "@shared/media-attachments";
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import { migrate } from "drizzle-orm/pg-proxy/migrator";
import { migrationScript, psqlProxyCallback } from "../../../tests/db/pg-baseline-model";
import { withPostgres } from "../../../tests/db/pg-test-harness";
import * as pg from "../../db/postgres-schema";

const realDb = { ...(await import("../../db")) };
// The lookup reads `postgresRuntime.client.db` at call time; the client is set once the
// harness database exists.
const runtime: { client: { db: unknown } } = { client: { db: undefined } };
mock.module("../../db", () => ({ ...realDb, postgresRuntime: runtime }));
const { narratorReferencesImage, narratorReferencesMedia } = await import(
	"../narrator-media-access"
);
const { createPostgresClient } = await import("../../db/postgres-client");
afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
});

const NOW = "2026-11-03T00:00:00.000Z";

test.skipIf(process.env.PG_INTEGRATION !== "1")(
	"PostgreSQL proves content and tool-output references and rejects plain-string outputs",
	async () => {
		const result = await withPostgres(async ({ port, exec }) => {
			const proxyDb = drizzleProxy(psqlProxyCallback(exec)) as unknown as PgRemoteDatabase;
			await migrate(
				proxyDb,
				async (queries) => {
					const applied = await exec(migrationScript(queries));
					if (applied.code !== 0) throw new Error(`migration failed: ${applied.stderr}`);
				},
				{ migrationsFolder: "drizzle-postgres" },
			);
			const password = "upload-reference-test";
			await exec(`ALTER ROLE CURRENT_USER PASSWORD '${password}';`);
			const user = (await exec("SELECT current_user;")).stdout.trim();
			const client = createPostgresClient({
				driver: "bun-sql",
				url: `postgres://${encodeURIComponent(user)}:${password}@127.0.0.1:${port}/nf_harness`,
				max: 2,
				idleTimeout: 1,
				maxLifetime: 60,
				connectTimeout: 10,
			});
			runtime.client.db = client.db;
			try {
				const db = client.db;
				for (const id of ["source", "content-ctx", "tool-ctx", "text-ctx", "media-ctx"])
					await db.insert(pg.narrators).values({ id, createdAt: NOW, updatedAt: NOW });
				const image = {
					type: "image",
					imageId: "img00001",
					filename: "a.png",
					mediaType: "image/png",
					uploadNarratorId: "source",
				};
				const media = mediaRefToContentBlock({
					mediaId: "med00001",
					mediaType: "audio/wav",
					filename: "a.wav",
					size: 60,
					uploadNarratorId: "source",
				});
				const message = async (narratorId: string, seq: number, contentJson: unknown) => {
					const id = `${narratorId}-m${seq}`;
					await db.insert(pg.narratorMessages).values({
						id,
						narratorId,
						role: seq === 0 ? "user" : "assistant",
						contentJson,
						contentText: "",
						createdAt: NOW,
					});
					await db
						.insert(pg.narratorMessageRefs)
						.values({ id: `${id}-ref`, narratorId, messageId: id, seq });
					return id;
				};
				const tool = async (narratorId: string, messageId: string, outputJson: unknown) =>
					db.insert(pg.narratorToolCalls).values({
						id: `${messageId}-tool`,
						narratorId,
						messageId,
						toolUseId: `${messageId}-use`,
						toolName: "Read",
						status: "success",
						createdAt: NOW,
						outputJson,
					});
				// Filler before the reference, so the key read and window cut run over real rows.
				for (const ctx of ["content-ctx", "tool-ctx", "text-ctx", "media-ctx"])
					await message(ctx, 0, [{ type: "text", text: "x".repeat(4096) }]);

				await message("content-ctx", 1, [image]);
				expect(await narratorReferencesImage("content-ctx", "source", "img00001")).toBe(true);
				expect(await narratorReferencesImage("content-ctx", "other", "img00001")).toBe(false);
				expect(await narratorReferencesImage("content-ctx", "source", "img00002")).toBe(false);

				const toolMessage = await message("tool-ctx", 1, []);
				await tool("tool-ctx", toolMessage, {
					_text: "inspected",
					_images: [{ imageId: "img00001", mediaType: "image/png", uploadNarratorId: "source" }],
				});
				expect(await narratorReferencesImage("tool-ctx", "source", "img00001")).toBe(true);

				// A tool's plain-text output stays a string after the codec decodes it.
				const textMessage = await message("text-ctx", 1, []);
				await tool(
					"text-ctx",
					textMessage,
					JSON.stringify({
						_images: [{ imageId: "img00001", mediaType: "image/png", uploadNarratorId: "source" }],
						_media: [media],
					}),
				);
				expect(await narratorReferencesImage("text-ctx", "source", "img00001")).toBe(false);
				expect(await narratorReferencesMedia("text-ctx", "source", "med00001")).toBe(false);

				const mediaMessage = await message("media-ctx", 1, []);
				await tool("media-ctx", mediaMessage, { _text: "read", _media: [media] });
				expect(await narratorReferencesMedia("media-ctx", "source", "med00001")).toBe(true);
				return "ok";
			} catch (error) {
				// The harness reports only "callback failed"; keep the assertion that failed.
				console.error("Upload reference PostgreSQL fixture failed", error);
				throw error;
			} finally {
				runtime.client.db = undefined;
				await client.close();
			}
		});
		if (typeof result !== "string") {
			throw new Error(
				`PostgreSQL integration unavailable: ${result.status === "blocked" || result.status === "failed" ? result.reason : "unexpected harness result"}`,
			);
		}
		expect(result).toBe("ok");
	},
	420_000,
);
