import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig, SQLiteSyncDialect, SQLiteTable } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { posixPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { normalizeOAuthClientPolicy } from "../lib/oauth-client-policy";

// Real isolated database and all production authorization; only transport is simulated.
const sqlite = new Database(":memory:");
const dialect = new SQLiteSyncDialect();
const tables = Object.values(schema).filter((value) => is(value, SQLiteTable));
for (const table of tables) {
	const config = getTableConfig(table);
	const columns = config.columns.map((column) => {
		const value = column.default;
		let defaultSql = "";
		if (value !== undefined) {
			const literal =
				typeof value === "object" && value !== null && "queryChunks" in value
					? dialect.sqlToQuery(value as Parameters<typeof dialect.sqlToQuery>[0]).sql
					: typeof value === "string"
						? `'${value.replaceAll("'", "''")}'`
						: typeof value === "boolean"
							? Number(value)
							: value === null
								? "NULL"
								: typeof value === "object"
									? `'${JSON.stringify(value).replaceAll("'", "''")}'`
									: value;
			defaultSql = ` DEFAULT ${literal}`;
		}
		return `"${column.name}" ${column.getSQLType()} ${column.primary ? "PRIMARY KEY" : ""} ${column.notNull ? "NOT NULL" : ""}${defaultSql}`;
	});
	sqlite.run(`CREATE TABLE "${config.name}" (${columns.join(",")})`);
}
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
mock.module("../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
const connection = await import("../services/device-connection-service");
const { setRemoteBackendResolver } = await import("../lib/agent/execution/registry");
const { executionPolicyEngine } = await import("../services/execution-policy/engine");
const { narratorAttachmentRoutes } = await import("./narrator-attachments");
const { previewNarratorAttachment } = await import("../services/narrator-attachment-preview");
let actor: string;
let narrator: string;
let device: string;
let message: string;
let attachment: string;
let root: string;
let path: string;
let bytes: Uint8Array;
let readHook: (() => Promise<void>) | undefined;
let identityHook: (() => Promise<void>) | undefined;
let online: ReturnType<typeof spyOn>;
let reads: string[];

beforeEach(async () => {
	for (const table of tables) sqlite.run(`DELETE FROM "${getTableConfig(table).name}"`);
	executionPolicyEngine.clear();
	[actor, narrator, device, message, attachment] = Array.from({ length: 5 }, generateId);
	root = await mkdtemp(join(tmpdir(), "attachment-preview-"));
	path = join(root, "same-name.txt");
	await writeFile(path, "HOST DECOY MUST NEVER APPEAR");
	bytes = new TextEncoder().encode("original remote bytes\n");
	reads = [];
	readHook = undefined;
	identityHook = undefined;
	const now = new Date().toISOString();
	await db
		.insert(schema.users)
		.values({ id: actor, username: actor, passwordHash: "fixture", role: "user", createdAt: now });
	await db.insert(schema.narrators).values({
		id: narrator,
		ownerUserId: actor,
		cwd: root,
		defaultDeviceId: device,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(schema.remoteDevices).values({
		id: device,
		name: "fixture",
		slug: device,
		tokenHash: "fixture",
		tokenPrefix: "fixture",
		scope: "global",
		ownerScope: "private",
		createdBy: actor,
		createdAt: now,
		updatedAt: now,
	});
	const block = {
		type: "text_file",
		filename: "same-name.txt",
		filePath: path,
		size: bytes.byteLength,
		attachmentId: attachment,
		deviceId: device,
		contextKey: "original",
		sourceNarratorId: narrator,
		attachmentOrigin: { version: 1, projectId: null },
		attachmentWorkspace: {
			revision: 0,
			deviceId: device,
			cwd: root,
			pathFlavor: "posix",
			contextKey: "original",
			capabilities: { switchDirectory: true },
		},
	};
	await db.insert(schema.narratorMessages).values({
		id: message,
		narratorId: narrator,
		role: "user",
		contentJson: [block],
		createdAt: now,
	});
	await db
		.insert(schema.narratorMessageRefs)
		.values({ id: generateId(), narratorId: narrator, messageId: message, seq: 1 });
	online = spyOn(connection, "isDeviceOnline").mockReturnValue(true);
	const backend = {
		kind: "remote",
		deviceId: device,
		paths: posixPathSemantics,
		pathFlavor: "posix",
		runtimeGeneration: 7,
		async resolvePathIdentity(target: string) {
			await identityHook?.();
			return { lexicalPath: target, canonicalPath: target, exists: true, runtimeGeneration: 7 };
		},
		async statFile(target: string) {
			return {
				isFile: target === path,
				isDirectory: target === root,
				size: bytes.byteLength,
				resolvedPath: target,
			};
		},
		async readFileBytes(target: string, options: { maxBytes: number }) {
			reads.push(target);
			await readHook?.();
			return {
				bytes: bytes.slice(0, options.maxBytes),
				truncated: bytes.byteLength > options.maxBytes,
				totalSize: bytes.byteLength,
				resolvedPath: target,
			};
		},
	} as unknown as ExecutionBackend;
	setRemoteBackendResolver((id) => (id === device ? backend : null));
});
afterEach(async () => {
	online.mockRestore();
	setRemoteBackendResolver(null);
	await rm(root, { recursive: true, force: true });
});
afterAll(() => sqlite.close());

function app() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: actor, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error) =>
			new Response(JSON.stringify({ error: error.message }), {
				status: error instanceof AppError ? error.statusCode : 500,
			}),
	);
	app.route("/api/narrators", narratorAttachmentRoutes);
	return app;
}
const preview = (suffix = "", nid = narrator, mid = message, aid = attachment) =>
	app().request(`/api/narrators/${nid}/messages/${mid}/attachments/${aid}/preview${suffix}`);

test("original remote bytes, never host decoy, even after default workspace switches", async () => {
	await db
		.update(schema.narrators)
		.set({ cwd: "/different", defaultDeviceId: "local" })
		.where(eq(schema.narrators.id, narrator));
	const response = await preview();
	expect(response.status).toBe(200);
	expect(await response.text()).toBe("original remote bytes\n");
	expect(response.headers.get("X-Attachment-Truncated")).toBe("false");
	expect(reads).toEqual([path]);
});
test("unknown legacy provenance is rejected without source reads", async () => {
	await db
		.update(schema.narratorMessages)
		.set({
			contentJson: [
				{
					type: "text_file",
					filename: "same-name.txt",
					filePath: path,
					size: 10,
					attachmentId: attachment,
				},
			],
		})
		.where(eq(schema.narratorMessages.id, message));
	expect((await preview()).status).toBe(409);
	expect(reads).toEqual([]);
});
test("unauthenticated route rejects before lookup", async () => {
	const unauthenticated = new Hono();
	unauthenticated.onError(
		(error) =>
			new Response(error.message, { status: error instanceof AppError ? error.statusCode : 500 }),
	);
	unauthenticated.route("/api/narrators", narratorAttachmentRoutes);
	expect(
		(
			await unauthenticated.request(
				`/api/narrators/${narrator}/messages/${message}/attachments/${attachment}/preview`,
			)
		).status,
	).toBe(401);
	expect(reads).toEqual([]);
});

test("inconsistent original device provenance refuses without reading any bytes", async () => {
	const row = await db.query.narratorMessages.findFirst({
		where: eq(schema.narratorMessages.id, message),
	});
	const block = { ...(row?.contentJson as Array<Record<string, unknown>>)[0], deviceId: "local" };
	await db
		.update(schema.narratorMessages)
		.set({ contentJson: [block] })
		.where(eq(schema.narratorMessages.id, message));
	expect((await preview()).status).toBe(409);
	expect(reads).toEqual([]);
});

test("selectors cannot substitute a path or another message/attachment", async () => {
	expect((await preview("?path=/etc/passwd")).status).toBe(400);
	expect((await preview("", narrator, generateId())).status).toBe(404);
	expect((await preview("", narrator, message, generateId())).status).toBe(404);
	const other = generateId();
	await db.insert(schema.narrators).values({
		id: other,
		ownerUserId: actor,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	expect((await preview("", other)).status).toBe(404);
	expect(reads).toEqual([]);
});
async function addDeny() {
	await db.insert(schema.narratorBlacklistDirs).values({
		id: generateId(),
		narratorId: narrator,
		path: root,
		denyLevel: "denyAll",
		targetKind: "device",
		targetValue: device,
		pathFlavor: "posix",
		createdAt: new Date().toISOString(),
	});
	executionPolicyEngine.invalidate(narrator);
}
test("current path deny refuses bytes", async () => {
	await addDeny();
	expect((await preview()).status).toBe(403);
	expect(reads).toEqual([]);
});
test("device revocation and loss of narrator read permission refuse bytes", async () => {
	await db
		.update(schema.remoteDevices)
		.set({ revokedAt: new Date().toISOString() })
		.where(eq(schema.remoteDevices.id, device));
	expect((await preview()).status).toBe(403);
	await db
		.update(schema.remoteDevices)
		.set({ revokedAt: null })
		.where(eq(schema.remoteDevices.id, device));
	await db
		.update(schema.narrators)
		.set({ ownerUserId: "different", visibility: "private" })
		.where(eq(schema.narrators.id, narrator));
	expect([403, 404]).toContain((await preview()).status);
	expect(reads).toEqual([]);
});
test("request cancellation rejects a hanging transport without returning bytes", async () => {
	const controller = new AbortController();
	readHook = async () => {
		controller.abort(new Error("cancel fixture request"));
		await new Promise(() => {});
	};
	await expect(
		previewNarratorAttachment(narrator, actor, message, attachment, controller.signal),
	).rejects.toThrow("cancel fixture request");
	expect(reads).toEqual([path]);
});

test("revocation during bytes await never releases bytes", async () => {
	readHook = async () => {
		await db
			.update(schema.remoteDevices)
			.set({ revokedAt: new Date().toISOString() })
			.where(eq(schema.remoteDevices.id, device));
	};
	const response = await preview();
	expect(response.status).toBe(403);
	expect(await response.text()).not.toContain("original remote bytes");
});
test("narrator ACL withdrawal during last canonical await refuses bytes", async () => {
	readHook = async () => {
		identityHook = async () => {
			identityHook = undefined;
			await db
				.update(schema.narrators)
				.set({ ownerUserId: "different", visibility: "private" })
				.where(eq(schema.narrators.id, narrator));
		};
	};
	const response = await preview();
	expect([403, 404]).toContain(response.status);
	expect(await response.text()).not.toContain("original remote bytes");
});

test("deny inserted during last canonical await is caught by synchronous final fence", async () => {
	readHook = async () => {
		identityHook = async () => {
			identityHook = undefined;
			await addDeny();
		};
	};
	const response = await preview();
	expect(response.status).toBe(403);
	expect(await response.text()).not.toContain("original remote bytes");
});
test("OAuth-owned original device Read ceiling is enforced, including mid-read withdrawal", async () => {
	const client = generateId();
	const grant = generateId();
	const now = new Date().toISOString();
	const policy = normalizeOAuthClientPolicy({
		deviceAccess: { host: "denied", global: "readOnly", selfRegistered: "readOnly" },
	});
	await db.insert(schema.oauthClients).values({
		id: client,
		clientId: client,
		name: "fixture",
		publicClient: true,
		redirectUris: [],
		scopes: ["device.provision"],
		grantTypes: ["authorization_code"],
		policyJson: policy,
		createdBy: actor,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(schema.integrationAuthorities).values({
		id: grant,
		kind: "oauth_grant",
		integrationType: "oauth_client",
		integrationId: client,
		ownerUserId: actor,
		state: "active",
		policyJson: policy,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(schema.integrationResourceBindings).values({
		id: generateId(),
		resourceType: "device",
		resourceId: device,
		sourceType: "oauth_client",
		sourceId: client,
		authorityType: "oauth_grant",
		authorityId: grant,
		state: "active",
		createdAt: now,
		updatedAt: now,
	});
	expect((await preview()).status).toBe(200);
	readHook = async () => {
		await db
			.update(schema.oauthClients)
			.set({
				policyJson: normalizeOAuthClientPolicy({
					deviceAccess: { host: "denied", global: "denied", selfRegistered: "denied" },
				}),
			})
			.where(eq(schema.oauthClients.id, client));
	};
	const response = await preview();
	expect(response.status).toBe(403);
	expect(await response.text()).not.toContain("original remote bytes");
});

test("bounded byte read refuses growth after stat rather than returning a prefix", async () => {
	readHook = async () => {
		bytes = new Uint8Array(1024 * 1024 + 1).fill(65);
	};
	const response = await preview();
	expect(response.status).toBe(413);
	expect(reads).toEqual([path]);
	expect(await response.text()).not.toContain("AAAA");
});

test("transport stall times out with no source bytes", async () => {
	readHook = async () => {
		await new Promise(() => {});
	};
	const response = await preview();
	expect(response.status).toBe(504);
	expect(await response.text()).not.toContain("original remote bytes");
}, 10_000);

test("oversized or binary attachment refuses rather than treating partial bytes as complete", async () => {
	bytes = new Uint8Array(1024 * 1024 + 1).fill(65);
	expect((await preview()).status).toBe(413);
	expect(reads).toEqual([]);
	bytes = new Uint8Array([0, 1, 2]);
	expect((await preview()).status).toBe(415);
});
