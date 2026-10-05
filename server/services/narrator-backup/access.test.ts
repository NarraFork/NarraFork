import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { SQL } from "bun";
import { compileExecutionPolicy } from "../execution-policy/compiler";
import { normalizeExecutionPolicyRuleSet } from "../execution-policy/normalize";
import { authorizeBackupSource, requireBackupDeviceAccess } from "./access";
import { readArtifactObject, readNarratorBackupArtifact } from "./artifact";
import { BACKUP_TABLES, type BackupState } from "./contract";
import { validateRestoreTarget } from "./main-store";
import { boundedBackupGit, gitOid } from "./objects";
import { postgresBackupConnection } from "./postgres-main-store";
import { productionBackupSchema } from "./production-fixture.test-helper";
import { createSqliteNarratorBackupMainStore, sqliteBackupConnection } from "./sqlite-main-store";
import { collectBackupState } from "./state";
import { type BackupWorkerRequest, runBackupWorker } from "./worker";

const actor = { userId: "alice", isAdmin: false };
const now = "2026-10-03T00:00:00Z";
const directories: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
	for (const db of databases.splice(0)) db.close();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
function insert(db: Database, table: string, values: Record<string, string | number | null>) {
	const fields = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
		(row) => row.name,
	);
	const row = { ...values };
	for (const field of ["created_at", "updated_at"])
		if (fields.includes(field) && !Object.hasOwn(row, field)) row[field] = now;
	const keys = Object.keys(row);
	db.prepare(
		`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
	).run(...keys.map((key) => row[key]));
}
function narrator(db: Database, id: string, extra: Record<string, string | number | null> = {}) {
	insert(db, "narrators", {
		id,
		title: id,
		owner_user_id: "alice",
		visibility: "private",
		type: "primary",
		...extra,
	});
}
function message(
	db: Database,
	id: string,
	author: string,
	extra: Record<string, string | number | null> = {},
) {
	insert(db, "narrator_messages", {
		id,
		narrator_id: author,
		role: "assistant",
		content_json: JSON.stringify([{ type: "text", text: id }]),
		...extra,
	});
}
function ref(
	db: Database,
	id: string,
	owner: string,
	msg: string,
	seq: number,
	marker: string | null = null,
) {
	insert(db, "narrator_message_refs", {
		id,
		narrator_id: owner,
		message_id: msg,
		seq,
		segment_compact_id: marker,
	});
}
function tool(db: Database, id: string, owner: string, msg: string, result: string) {
	insert(db, "narrator_tool_calls", {
		id,
		narrator_id: owner,
		message_id: msg,
		tool_use_id: `${id}-use`,
		tool_name: "Task",
		input_json: "{}",
		status: "success",
		result_message_id: result,
	});
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "nf-backup-auth-review-"));
	directories.push(root);
	const databasePath = join(root, "source.db");
	await writeFile(databasePath, productionBackupSchema);
	const db = new Database(databasePath);
	databases.push(db);
	db.run("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250");
	for (const [id, role] of [
		["alice", "user"],
		["bob", "user"],
		["admin", "admin"],
	])
		insert(db, "users", { id, username: id, password_hash: "fixture", role });
	const cwd = join(root, "workspace");
	await mkdir(cwd);
	const dataDirectory = join(root, "data");
	await mkdir(dataDirectory);
	const settingsPath = join(dataDirectory, "settings.json");
	await writeFile(settingsPath, JSON.stringify({ agent: {} }));
	insert(db, "projects", {
		id: "p",
		name: "p",
		git_path: cwd,
		owner_user_id: "bob",
		visibility: "private",
	});
	insert(db, "chapters", {
		id: "chapter",
		project_id: "p",
		title: "c",
		branch: "branch",
		base_branch: "main",
		worktree_path: cwd,
	});
	insert(db, "acl_grants", {
		id: "member",
		scope_type: "project",
		scope_id: "p",
		principal_type: "user",
		principal_id: "alice",
		capability: "write",
	});
	narrator(db, "solo", {
		chapter_id: "chapter",
		context_project_id: null,
		default_device_id: "local",
		cwd,
	});
	message(db, "m", "solo");
	ref(db, "ref", "solo", "m", 0);
	const config = {
		backend: "sqlite" as const,
		databasePath,
		sourceInstanceId: "fixture",
		proofDirectory: join(dataDirectory, "proof"),
		settingsPath,
		dataDirectory,
		objectSource: {
			shadowRoot: join(dataDirectory, "trees"),
			uploadsRoot: join(dataDirectory, "uploads"),
			blobRoot: join(dataDirectory, "blobs"),
			journalRoot: join(dataDirectory, "journals"),
		},
	};
	const repo = join(
		config.objectSource.shadowRoot,
		createHash("sha256").update(`local\0${cwd}`).digest("hex").slice(0, 32),
	);
	await mkdir(repo, { recursive: true });
	await boundedBackupGit(["init", "--bare", repo], new AbortController().signal);
	async function object(kind: string, bytes: Buffer) {
		const oid = gitOid(kind, bytes);
		await mkdir(join(repo, "objects", oid.slice(0, 2)), { recursive: true });
		await writeFile(
			join(repo, "objects", oid.slice(0, 2), oid.slice(2)),
			deflateSync(Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`), bytes])),
		);
		return oid;
	}
	const secretBytes = Buffer.from("historical bytes now forbidden by a descendant deny");
	const secretBlob = await object("blob", secretBytes);
	const tree = await object(
		"tree",
		Buffer.concat([Buffer.from("100644 secret\0"), Buffer.from(secretBlob, "hex")]),
	);
	db.prepare("UPDATE narrator_messages SET tree_hash_after=? WHERE id='m'").run(tree);
	const request = (extra: Partial<BackupWorkerRequest> = {}): BackupWorkerRequest => ({
		action: "export",
		actor,
		config,
		narratorIds: ["solo"],
		profile: "conversation-tree-v1",
		artifactPath: join(root, "artifact.sqlite"),
		stagingPath: join(root, "artifact.staging"),
		cancellation: new SharedArrayBuffer(4),
		deadline: Date.now() + 10000,
		...extra,
	});
	const state = () =>
		collectBackupState(createSqliteNarratorBackupMainStore(db), ["solo"], actor, () => {});
	return { root, db, cwd, config, request, state, secretBlob, secretBytes };
}
function eraseConversation(db: Database) {
	db.run("PRAGMA foreign_keys=OFF");
	for (const table of Object.keys(BACKUP_TABLES)) db.run(`DELETE FROM ${table}`);
	db.run("PRAGMA foreign_keys=ON");
}

test("A1 narrator ownership never bypasses revoked actual chapter project membership; final fence escapes source snapshot", async () => {
	const f = await fixture();
	expect((await f.state()).rows.narrators?.[0].context_project_id).toBeNull();
	await runBackupWorker(f.request({ action: "plan" }));
	let fences = 0;
	await expect(
		runBackupWorker(f.request(), {
			beforeSourceFence: async () => {
				if (++fences === 2) f.db.run("DELETE FROM acl_grants WHERE id='member'");
			},
		}),
	).rejects.toThrow("authorization");
	expect(fences).toBe(2);
	expect(await Bun.file(f.request().artifactPath ?? "").exists()).toBe(false);
	expect(f.db.prepare("SELECT owner_user_id FROM narrators WHERE id='solo'").get()).toEqual({
		owner_user_id: "alice",
	});
	await expect(runBackupWorker(f.request())).rejects.toThrow("authorization");
});

test("A1 signed download refreshes project and global policy after export, including deleted source metadata", async () => {
	const f = await fixture();
	const exported = (await runBackupWorker(f.request())) as { digest: string };
	expect(readArtifactObject(f.request().artifactPath ?? "", `git:${f.secretBlob}`)).toEqual(
		f.secretBytes,
	);
	const download = () =>
		runBackupWorker(f.request({ action: "download", expectedDigest: exported.digest }));
	await download();
	await expect(
		runBackupWorker(f.request({ action: "download", expectedDigest: exported.digest }), {
			beforeSourceFence: async () => {
				f.db.run("DELETE FROM acl_grants WHERE id='member'");
			},
		}),
	).rejects.toThrow("authorization");
	insert(f.db, "acl_grants", {
		id: "member",
		scope_type: "project",
		scope_id: "p",
		principal_type: "user",
		principal_id: "alice",
		capability: "write",
	});
	await writeFile(
		f.config.settingsPath,
		JSON.stringify({
			agent: {
				blacklistDirs: [{ path: join(f.cwd, "secret"), enabled: true, denyLevel: "denyAll" }],
			},
		}),
	);
	await expect(download()).rejects.toThrow("authorization");
	await writeFile(f.config.settingsPath, JSON.stringify({ agent: {} }));
	eraseConversation(f.db);
	await download(); // Signed source facts still locate today's project/device gates.
	f.db.run("DELETE FROM acl_grants WHERE id='member'");
	await expect(download()).rejects.toThrow("authorization");
});

for (const layer of ["narrator", "project", "global"] as const)
	test(`A1 ${layer} subtree allow is not a full-root proof; descendant deny defeats a root allow`, async () => {
		const f = await fixture();
		const set = async (white: string[], black: string[]) => {
			const policy = {
				whitelistDirs: white.map((path) => ({ path, enabled: true, accessLevel: "readOnly" })),
				blacklistDirs: black.map((path) => ({ path, enabled: true, denyLevel: "denyAll" })),
			};
			if (layer === "global")
				await writeFile(f.config.settingsPath, JSON.stringify({ agent: policy }));
			else if (layer === "project")
				f.db
					.prepare("UPDATE projects SET chapter_settings=? WHERE id='p'")
					.run(JSON.stringify(policy));
			else {
				f.db.run("DELETE FROM narrator_whitelist_dirs; DELETE FROM narrator_blacklist_dirs");
				for (const [index, path] of white.entries())
					insert(f.db, "narrator_whitelist_dirs", {
						id: `w${index}`,
						narrator_id: "solo",
						path,
						access_level: "readOnly",
						enabled: 1,
					});
				for (const [index, path] of black.entries())
					insert(f.db, "narrator_blacklist_dirs", {
						id: `b${index}`,
						narrator_id: "solo",
						path,
						deny_level: "denyAll",
						enabled: 1,
					});
			}
		};
		await set([join(f.cwd, "allowed")], []);
		await expect(runBackupWorker(f.request({ action: "plan" }))).rejects.toThrow("authorization");
		await set([f.cwd], []);
		await runBackupWorker(f.request({ action: "plan" }));
		await set([f.cwd], [join(f.cwd, "denied")]);
		await expect(runBackupWorker(f.request({ action: "plan" }))).rejects.toThrow("authorization");
	});

test("A1 subagent inherits parent's current deny and foreign/invalid source runtime never falls back to local", async () => {
	const f = await fixture();
	narrator(f.db, "sub", {
		type: "subagent",
		variant: "subagent:general",
		parent_narrator_id: "solo",
		acl_root_narrator_id: "solo",
		cwd: f.cwd,
	});
	message(f.db, "submsg", "sub");
	ref(f.db, "subref", "sub", "submsg", 0);
	insert(f.db, "narrator_blacklist_dirs", {
		id: "deny",
		narrator_id: "solo",
		path: join(f.cwd, "secret"),
		deny_level: "denyAll",
		enabled: 1,
	});
	await expect(runBackupWorker(f.request({ narratorIds: ["sub"] }))).rejects.toThrow(
		"authorization",
	);
	f.db.run("DELETE FROM narrator_blacklist_dirs");
	tool(f.db, "call", "solo", "m", "m");
	f.db.run(
		"UPDATE narrator_tool_calls SET execution_device_id='unknown',execution_cwd='/private',runtime_generation=7",
	);
	await expect(runBackupWorker(f.request())).rejects.toThrow("authorization");
	f.db.run("UPDATE narrator_tool_calls SET execution_device_id='local'");
	await expect(runBackupWorker(f.request())).rejects.toThrow("fallback forbidden");
});

for (const adapter of ["sqlite", "postgres-adapter"] as const)
	test(`A2 real DDL device axes, revocation and canonical OAuth ownership through ${adapter}`, async () => {
		const f = await fixture();
		const sqlite = sqliteBackupConnection(f.db);
		const store =
			adapter === "sqlite"
				? sqlite
				: postgresBackupConnection({
						// Exercise real PG adapter SQL/row conversion against the production SQLite
						// fixture. Translate only its dialect-specific byte-length expression.
						unsafe: async (text: string, values: unknown[]) =>
							sqlite.query(
								text.replace(/octet_length\("([a-z_]+)"::text\)/g, 'length(CAST("$1" AS BLOB))'),
								values as string[],
							),
						begin: async () => {
							throw new Error("No real PostgreSQL server used in this adapter fixture");
						},
					} as unknown as Pick<SQL, "unsafe" | "begin">);
		const device = (
			id: string,
			scope: string,
			owner: string,
			registrar: string,
			project: string | null = null,
		) =>
			insert(f.db, "remote_devices", {
				id,
				name: id,
				slug: id,
				token_hash: `hash-${id}`,
				token_prefix: "p",
				scope,
				project_id: project,
				owner_scope: owner,
				created_by: registrar,
			});
		device("private", "global", "private", "alice");
		device("shared", "global", "shared", "bob");
		device("project", "project", "shared", "bob", "p");
		device("private-project", "project", "private", "alice", "p");
		for (const id of ["private", "shared", "project", "private-project"])
			await requireBackupDeviceAccess(store, id, "p", actor);
		await expect(requireBackupDeviceAccess(store, "project", null, actor)).rejects.toThrow(
			"authorization",
		);
		await expect(
			requireBackupDeviceAccess(store, "private-project", "other", actor),
		).rejects.toThrow("authorization");
		await expect(
			requireBackupDeviceAccess(store, "private", "p", { userId: "admin", isAdmin: true }),
		).rejects.toThrow("authorization");
		f.db.run("UPDATE remote_devices SET revoked_at='now' WHERE id='shared'");
		await expect(requireBackupDeviceAccess(store, "shared", "p", actor)).rejects.toThrow(
			"authorization",
		);
		device("oauth", "global", "private", "alice");
		insert(f.db, "oauth_clients", {
			id: "client",
			client_id: "client",
			name: "c",
			public_client: 1,
		});
		insert(f.db, "integration_authorities", {
			id: "authority",
			kind: "oauth_grant",
			integration_type: "oauth_client",
			integration_id: "client",
			owner_user_id: "alice",
		});
		insert(f.db, "integration_resource_bindings", {
			id: "binding",
			resource_type: "device",
			resource_id: "oauth",
			source_type: "oauth_client",
			source_id: "client",
			authority_type: "oauth_grant",
			authority_id: "authority",
		});
		await requireBackupDeviceAccess(store, "oauth", "p", actor);
		f.db.run("UPDATE integration_authorities SET owner_user_id='bob'");
		await expect(requireBackupDeviceAccess(store, "oauth", "p", actor)).rejects.toThrow(
			"authorization",
		);
		f.db.run("UPDATE integration_authorities SET owner_user_id='alice',state='revoked'");
		await expect(requireBackupDeviceAccess(store, "oauth", "p", actor)).rejects.toThrow(
			"authorization",
		);
	});

for (const markerSeq of [1, 9])
	test(`A3 ancestor fold marker at ${markerSeq} excludes hidden refs, but explicit selected full history retains them`, async () => {
		const f = await fixture();
		message(f.db, "visible", "solo");
		message(f.db, "marker", "solo", { role: "system" });
		message(f.db, "hidden", "solo");
		ref(f.db, "visible-ref", "solo", "visible", 2);
		ref(f.db, "marker-ref", "solo", "marker", markerSeq);
		ref(f.db, "hidden-ref", "solo", "hidden", 0, "marker");
		narrator(f.db, "middle", {
			parent_narrator_id: "solo",
			refs_inherited_from: "solo",
			refs_backfill_cursor: 4,
		});
		narrator(f.db, "child", {
			parent_narrator_id: "middle",
			refs_inherited_from: "middle",
			refs_backfill_cursor: 3,
		});
		message(f.db, "partial", "child");
		ref(f.db, "partial-ref", "child", "partial", 5);
		const before = JSON.stringify(
			f.db.prepare("SELECT * FROM narrator_message_refs ORDER BY id").all(),
		);
		const store = createSqliteNarratorBackupMainStore(f.db);
		const state = await collectBackupState(store, ["child"], actor, () => {});
		expect(state.rows.narrator_messages?.some((row) => row.id === "hidden")).toBe(false);
		const effective = (
			f.db
				.prepare(
					"SELECT message_id FROM narrator_message_refs WHERE narrator_id='solo' AND seq<3 AND segment_compact_id IS NULL ORDER BY message_id",
				)
				.all() as { message_id: string }[]
		).map((row) => row.message_id);
		expect(
			state.rows.narrator_message_refs
				?.filter((row) => row.narrator_id === "solo")
				.map((row) => String(row.message_id))
				.sort(),
		).toEqual(effective);
		const full = await collectBackupState(store, ["solo"], actor, () => {});
		expect(full.rows.narrator_messages?.some((row) => row.id === "hidden")).toBe(true);
		expect(
			full.rows.narrator_message_refs?.find((row) => row.message_id === "hidden")
				?.segment_compact_id,
		).toBe("marker");
		expect(
			JSON.stringify(f.db.prepare("SELECT * FROM narrator_message_refs ORDER BY id").all()),
		).toBe(before);
	});

test("A4 completed ancestor Task result closes sparsely with recursive results, not sibling or author full history", async () => {
	const f = await fixture();
	narrator(f.db, "task-sub", {
		type: "subagent",
		variant: "subagent:general",
		parent_narrator_id: "solo",
		acl_root_narrator_id: "solo",
		origin_tool_call_id: "task",
	});
	message(f.db, "result", "task-sub", { parent_tool_use_id: "task-use" });
	message(f.db, "unneeded", "task-sub");
	ref(f.db, "unneeded-ref", "task-sub", "unneeded", 0);
	tool(f.db, "task", "solo", "m", "result");
	narrator(f.db, "nested", {
		type: "subagent",
		variant: "subagent:general",
		parent_narrator_id: "task-sub",
		acl_root_narrator_id: "solo",
		origin_tool_call_id: "nested-task",
	});
	message(f.db, "nested-result", "nested", { parent_tool_use_id: "nested-task-use" });
	tool(f.db, "nested-task", "task-sub", "result", "nested-result");
	narrator(f.db, "sibling", {
		type: "subagent",
		variant: "subagent:general",
		parent_narrator_id: "solo",
		acl_root_narrator_id: "solo",
	});
	message(f.db, "sibling-body", "sibling");
	narrator(f.db, "fork", {
		parent_narrator_id: "solo",
		fork_message_id: "m",
		refs_inherited_from: "solo",
		refs_backfill_cursor: 1,
	});
	const before = JSON.stringify(
		f.db.prepare("SELECT * FROM narrator_message_refs ORDER BY id").all(),
	);
	const state = await collectBackupState(
		createSqliteNarratorBackupMainStore(f.db),
		["fork"],
		actor,
		() => {},
	);
	expect(state.rows.narrator_messages?.map((row) => row.id).sort()).toEqual([
		"m",
		"nested-result",
		"result",
	]);
	expect(state.rows.narrators?.map((row) => row.id).sort()).toEqual([
		"fork",
		"nested",
		"solo",
		"task-sub",
	]);
	expect(JSON.stringify(state)).not.toContain("unneeded");
	expect(JSON.stringify(state)).not.toContain("sibling-body");
	expect(
		JSON.stringify(f.db.prepare("SELECT * FROM narrator_message_refs ORDER BY id").all()),
	).toBe(before);
	narrator(f.db, "foreign", { owner_user_id: "bob" });
	message(f.db, "foreign-result", "foreign");
	f.db.run("UPDATE narrator_tool_calls SET result_message_id='foreign-result' WHERE id='task'");
	await expect(
		collectBackupState(createSqliteNarratorBackupMainStore(f.db), ["fork"], actor, () => {}),
	).rejects.toThrow("owner/admin");
	f.db.run("UPDATE narrators SET owner_user_id='alice' WHERE id='foreign'");
	await expect(
		collectBackupState(createSqliteNarratorBackupMainStore(f.db), ["fork"], actor, () => {}),
	).rejects.toThrow("source scope");
});

test("A5 null standalone context resolves chapter project inside write tx; transfer after preview rejects atomic apply", async () => {
	const f = await fixture();
	const result = (await runBackupWorker(f.request({ profile: "conversation-state-v1" }))) as {
		digest: string;
	};
	const { state } = readNarratorBackupArtifact(f.request().artifactPath ?? "", () => {});
	eraseConversation(f.db);
	const preview = (await runBackupWorker(
		f.request({ action: "preview", expectedDigest: result.digest }),
	)) as { sameInstanceStateRestoreAllowed: boolean };
	expect(preview.sameInstanceStateRestoreAllowed).toBe(true);
	// Rebind an existing chapter ID to Bob's inaccessible project after preview.
	insert(f.db, "projects", {
		id: "q",
		name: "q",
		git_path: join(f.root, "q"),
		visibility: "private",
		owner_user_id: "bob",
	});
	f.db.run("UPDATE chapters SET project_id='q' WHERE id='chapter'");
	await expect(
		createSqliteNarratorBackupMainStore(f.db).restore(state, actor, () => {}),
	).rejects.toThrow("authorization");
	expect(f.db.prepare("SELECT id FROM narrators").all()).toEqual([]);
	f.db.run("UPDATE chapters SET project_id='p' WHERE id='chapter'");
	await createSqliteNarratorBackupMainStore(f.db).restore(state, actor, () => {});
	expect(f.db.prepare("SELECT status,permission_mode FROM narrators").get()).toEqual({
		status: "archived",
		permission_mode: "readOnly",
	});
	expect(f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("A2 restored device association uses live production owner/scope inside validator, never an owner_user_id column", async () => {
	const f = await fixture();
	insert(f.db, "remote_devices", {
		id: "remote",
		name: "r",
		slug: "r",
		token_hash: "h",
		token_prefix: "p",
		owner_scope: "shared",
		scope: "project",
		project_id: "p",
		created_by: "bob",
	});
	const state = await f.state();
	eraseConversation(f.db);
	state.rows.narrators = state.rows.narrators?.map((row) => ({
		...row,
		default_device_id: "remote",
	}));
	await validateRestoreTarget(sqliteBackupConnection(f.db), state, actor, () => {});
	f.db.run("UPDATE remote_devices SET owner_scope='private'");
	await expect(
		validateRestoreTarget(sqliteBackupConnection(f.db), state, actor, () => {}),
	).rejects.toThrow("authorization");
	f.db.run("UPDATE remote_devices SET created_by='alice',scope='global'");
	await validateRestoreTarget(sqliteBackupConnection(f.db), state, actor, () => {});
	f.db.run("UPDATE remote_devices SET revoked_at='now'");
	await expect(
		validateRestoreTarget(sqliteBackupConnection(f.db), state, actor, () => {}),
	).rejects.toThrow("authorization");
});

test("A1 current source policy payloads have row/page budgets before JS materialization", async () => {
	const f = await fixture();
	const state = await f.state();
	f.db
		.prepare("UPDATE projects SET chapter_settings=? WHERE id='p'")
		.run("x".repeat(4 * 1024 * 1024 + 1));
	await expect(
		authorizeBackupSource(sqliteBackupConnection(f.db), state, actor, f.config, () => {}, true),
	).rejects.toThrow("byte budget");
	f.db.run("UPDATE projects SET chapter_settings=NULL");
	for (let index = 0; index < 600; index++)
		insert(f.db, "narrator_whitelist_dirs", {
			id: `large-${index}`,
			narrator_id: "solo",
			path: `${f.cwd}/${"x".repeat(16384)}${index}`,
			enabled: 1,
		});
	await expect(
		authorizeBackupSource(sqliteBackupConnection(f.db), state, actor, f.config, () => {}, true),
	).rejects.toThrow("byte budget");
});

test("restore manual activation preserves ordinary directory/command denials while grants and pending requests stay frozen", async () => {
	const f = await fixture();
	insert(f.db, "narrator_whitelist_dirs", {
		id: "allow",
		narrator_id: "solo",
		path: f.cwd,
		access_level: "full",
		enabled: 1,
	});
	insert(f.db, "narrator_blacklist_dirs", {
		id: "write-deny",
		narrator_id: "solo",
		path: f.cwd,
		deny_level: "denyWrite",
		enabled: 1,
	});
	insert(f.db, "narrator_blacklist_dirs", {
		id: "read-deny",
		narrator_id: "solo",
		path: join(f.root, "outside"),
		deny_level: "denyAll",
		enabled: 1,
	});
	insert(f.db, "narrator_blacklist_cmds", {
		id: "command-deny",
		narrator_id: "solo",
		pattern: "rm *",
		enabled: 1,
	});
	insert(f.db, "narrator_whitelist_cmds", {
		id: "command-allow",
		narrator_id: "solo",
		pattern: "echo *",
		enabled: 1,
	});
	tool(f.db, "pending", "solo", "m", "m");
	f.db.run("UPDATE narrator_tool_calls SET status='pending' WHERE id='pending'");
	const state = await f.state();
	eraseConversation(f.db);
	await createSqliteNarratorBackupMainStore(f.db).restore(state, actor, () => {});
	f.db.run("UPDATE narrators SET status='idle',permission_mode='default'"); // Explicit fixture-only manual activation.
	const rows = (table: string) =>
		f.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, string | number>[];
	const compiled = compileExecutionPolicy(
		normalizeExecutionPolicyRuleSet(
			{
				blacklistDirs: rows("narrator_blacklist_dirs").map((row) => ({
					path: String(row.path),
					denyLevel: row.deny_level as "denyAll" | "denyWrite",
					enabled: row.enabled === 1,
				})),
				whitelistDirs: rows("narrator_whitelist_dirs").map((row) => ({
					path: String(row.path),
					enabled: row.enabled === 1,
				})),
				commandBlacklist: rows("narrator_blacklist_cmds").map((row) => ({
					pattern: String(row.pattern),
					enabled: row.enabled === 1,
				})),
				commandWhitelist: rows("narrator_whitelist_cmds").map((row) => ({
					pattern: String(row.pattern),
					enabled: row.enabled === 1,
				})),
			},
			"narrator",
		),
	);
	expect(
		compiled.evaluatePath({ path: join(f.root, "outside", "secret"), operation: "read" }).decision,
	).toBe("deny");
	expect(compiled.evaluatePath({ path: join(f.cwd, "file"), operation: "write" }).decision).toBe(
		"deny",
	);
	expect(compiled.evaluateCommands([["rm", "-rf", "/"]]).decision).toBe("deny");
	expect(compiled.evaluateCommands([["echo", "hello"]]).decision).toBe("unmatched");
	expect(rows("narrator_tool_calls")[0].status).toBe("fail");
	expect(rows("narrator_tool_calls")[0].permission_decided_by).toBeNull();
});

test("A1 injected readonly source authorization uses current DB rows, not permissive canRead mocks", async () => {
	const f = await fixture();
	const state: BackupState = await f.state();
	await authorizeBackupSource(sqliteBackupConnection(f.db), state, actor, f.config, () => {}, true);
	f.db.run("DELETE FROM acl_grants");
	await expect(
		authorizeBackupSource(sqliteBackupConnection(f.db), state, actor, f.config, () => {}, true),
	).rejects.toThrow("authorization");
});
