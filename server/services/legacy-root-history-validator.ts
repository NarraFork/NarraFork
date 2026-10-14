import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, opendirSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import {
	LEGACY_ROOT_CHAPTER_POINTERS,
	LEGACY_ROOT_HISTORY_COLUMNS,
	LEGACY_ROOT_HISTORY_LIMITS,
	type LegacyRootHistoryGuard,
	type LegacyRootHistoryInput,
	type LegacyRootHistoryResult,
} from "./legacy-root-history-contract";

type Row = Record<string, string | number | null>;
class History extends Error {}

/** Only the worker calls this in production. No app singleton or write-capable service. */
export function inspectLegacyRootHistoryReadonly(
	input: LegacyRootHistoryInput,
	limits: {
		rows: number;
		bytes: number;
		filesystemEntries: number;
		milliseconds: number;
	} = LEGACY_ROOT_HISTORY_LIMITS,
): LegacyRootHistoryResult {
	const started = performance.now();
	let rows = 0;
	let bytes = 0;
	let entries = 0;
	let db: Database | undefined;
	const guards: LegacyRootHistoryGuard[] = [];
	const fingerprints = new Map<string, string>();
	const fingerprintKinds = new Map<string, "identity" | "full">();
	const evidence = createHash("sha256");
	const check = () => {
		if (
			rows > limits.rows ||
			bytes > limits.bytes ||
			entries > limits.filesystemEntries ||
			performance.now() - started > limits.milliseconds
		) {
			throw new Error("inspection budget exceeded");
		}
	};
	const record = (value: unknown) => {
		const text = JSON.stringify(value);
		bytes += Buffer.byteLength(text);
		check();
		evidence.update(text);
	};
	const stat = (path: string, kind?: "identity" | "full") => {
		check();
		const previousKind = fingerprintKinds.get(path);
		const effectiveKind = previousKind === "full" ? "full" : (kind ?? previousKind ?? "full");
		fingerprintKinds.set(path, effectiveKind);
		try {
			const value = lstatSync(path);
			if (value.isSymbolicLink()) throw new Error("symlink identity is unknown");
			const stamp = JSON.stringify(
				effectiveKind === "identity"
					? [value.dev, value.ino, value.mode & 0o170000]
					: [value.dev, value.ino, value.mode, value.size, value.mtimeMs, value.ctimeMs],
			);
			const previous = fingerprints.get(path);
			if (previous !== undefined && previous !== stamp)
				throw new Error("filesystem identity changed");
			fingerprints.set(path, stamp);
			return value;
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
				throw error;
			const previous = fingerprints.get(path);
			if (previous !== undefined && previous !== "missing")
				throw new Error("filesystem identity changed");
			fingerprints.set(path, "missing");
			return null;
		}
	};
	const pathIdentity = (path: string, leafKind: "identity" | "full" = "full") => {
		if (!isAbsolute(path) || resolve(path) !== path)
			throw new Error("noncanonical filesystem path");
		let current = parse(path).root;
		stat(current, "identity");
		for (const part of path.slice(current.length).split(/[\\/]/).filter(Boolean)) {
			current = join(current, part);
			stat(current, current === path ? leafKind : "identity");
		}
		return stat(path, leafKind);
	};
	const query = (sql: string, params: SQLQueryBindings[] = []): Row[] => {
		check();
		if (!db) throw new Error("database unavailable");
		const result = db.query<Row, SQLQueryBindings[]>(sql).all(...params);
		rows += result.length;
		for (const row of result) {
			if (Object.values(row).some((value) => typeof value === "string" && value.length >= 1025))
				throw new Error("oversized scalar");
		}
		record(result);
		return result;
	};
	const scan = (
		table: string,
		columns: string[],
		visit: (row: Row) => void,
		filter = "",
		params: SQLQueryBindings[] = [],
	) => {
		let cursor: string | null = null;
		for (;;) {
			// Primary-key keyset paging, including the unfiltered rows in the TOTAL budget.
			// The first page also sees malformed empty/null IDs instead of silently skipping them.
			const page = query(
				`SELECT ${columns.map((c) => `substr("${c}",1,1025) AS "${c}"`).join(",")} FROM "${table}" WHERE ${cursor === null ? "1=1" : "id > ?"} ${filter} ORDER BY id LIMIT ${LEGACY_ROOT_HISTORY_LIMITS.page}`,
				cursor === null ? params : [cursor, ...params],
			);
			for (const row of page) {
				if (typeof row.id !== "string" || !row.id) throw new Error("invalid history row identity");
				visit(row);
			}
			if (page.length < LEGACY_ROOT_HISTORY_LIMITS.page) break;
			const next = page.at(-1)?.id;
			if (typeof next !== "string" || (cursor !== null && next <= cursor))
				throw new Error("invalid keyset cursor");
			cursor = next;
		}
	};
	const exists = (table: string, column: string, id: string) => {
		if (
			query(`SELECT substr(id,1,1025) AS id FROM "${table}" WHERE "${column}" = ? LIMIT 1`, [id])
				.length
		)
			throw new History(`${table} dependency`);
	};
	const inspectMessage = (row: Row) => {
		if (!row.id) throw new Error("dangling shared message ref");
		if (row.commit_sha !== null || row.tree_hash_after !== null || row.snapshot_commit_sha !== null)
			throw new History("message history pointer");
		exists("narrator_tool_calls", "message_id", String(row.id));
		exists("narrator_patches", "message_id", String(row.id));
	};
	const directory = (path: string, visit: (name: string) => void) => {
		const before = stat(path);
		if (!before) return;
		if (!before.isDirectory()) throw new Error("expected history directory");
		const dir = opendirSync(path);
		try {
			for (;;) {
				check();
				const item = dir.readSync();
				if (!item) break;
				entries++;
				check();
				record([path, item.name]);
				stat(join(path, item.name));
				visit(item.name);
			}
		} finally {
			dir.closeSync();
		}
		stat(path);
	};
	const textFile = (path: string, max: number) => {
		const before = stat(path);
		if (!before) return null;
		if (!before.isFile() || before.size > max)
			throw new Error("unsupported or oversized history file");
		const fd = openSync(path, "r");
		try {
			const opened = fstatSync(fd);
			if (opened.dev !== before.dev || opened.ino !== before.ino)
				throw new Error("history file replaced");
			const buffer = Buffer.alloc(max + 1);
			const size = readSync(fd, buffer, 0, max + 1, 0);
			if (size !== before.size) throw new Error("history file truncated or changed");
			stat(path);
			const text = buffer.subarray(0, size).toString("utf8");
			record([path, text]);
			return text;
		} finally {
			closeSync(fd);
		}
	};
	const shadow = (path: string) => {
		if (!pathIdentity(path)) return;
		const refs = (dir: string, depth: number) => {
			if (depth > 8) throw new Error("ref depth budget exceeded");
			directory(dir, (name) => {
				const child = join(dir, name);
				if (stat(child)?.isDirectory()) refs(child, depth + 1);
				else {
					const text = textFile(child, 256);
					if (text && /^(?:[a-f0-9]{40}|[a-f0-9]{64}|ref: refs\/[^\s]+)\s*$/.test(text))
						throw new History("physical shadow ref");
					throw new Error("unrecognized shadow ref");
				}
			});
		};
		directory(path, (name) => {
			if (!["objects", "refs", "packed-refs", "HEAD", "config", "description"].includes(name))
				throw new Error("unsupported shadow entry");
		});
		const head = textFile(join(path, "HEAD"), 256);
		if (head && /^[a-f0-9]{40,64}\s*$/.test(head)) throw new History("detached shadow HEAD");
		if (head !== null && !/^ref: refs\/[^\s]+\s*$/.test(head))
			throw new Error("invalid shadow HEAD");
		const packed = textFile(join(path, "packed-refs"), 4096);
		if (packed?.split("\n").some((line) => /^[a-f0-9]{40,64} refs\//.test(line)))
			throw new History("packed shadow ref");
		if (packed?.split("\n").some((line) => line.trim() && !line.startsWith("#")))
			throw new Error("unknown packed refs content");
		refs(join(path, "refs"), 0);
		directory(join(path, "objects"), (name) => {
			const child = join(path, "objects", name);
			if (name === "pack" || /^[a-f0-9]{2}$/.test(name)) {
				directory(child, (object) => {
					const value = stat(join(child, object));
					if (
						value?.isFile() &&
						value.size > 0 &&
						(name === "pack"
							? /^pack-[a-f0-9]+\.(?:pack|idx|rev)$/.test(object)
							: /^(?:[a-f0-9]{38}|[a-f0-9]{62})$/.test(object))
					)
						throw new History("physical shadow object");
					throw new Error("unrecognized shadow object");
				});
			} else if (name === "info") {
				// Alternates, commit graphs and any other unsupported object store are not empty proof.
				directory(child, () => {
					throw new Error("unsupported objects info");
				});
			} else throw new Error("unsupported objects entry");
		});
	};
	let status: LegacyRootHistoryResult["status"] = "empty";
	let reason: string | undefined;
	try {
		record(input);
		if (
			!input.projectId ||
			!input.databasePath ||
			!input.chapterIds.length ||
			!input.workspacePaths.length ||
			!input.shadowDirectories.length
		)
			throw new Error("incomplete trusted history footprint");
		for (const list of [
			input.chapterIds,
			input.narratorIds,
			input.workspacePaths,
			input.snapshotShadowKeys,
			input.shadowDirectories,
		]) {
			if (
				!Array.isArray(list) ||
				list.length > LEGACY_ROOT_HISTORY_LIMITS.inputs ||
				list.some((value) => typeof value !== "string" || !value || value.length > 1024)
			)
				throw new Error("invalid or oversized input");
		}
		// DB content is versioned by the scoped readonly snapshot and narrator guards,
		// not whole-file mtime/size: disabling sync and unrelated writes legitimately
		// change SQLite/WAL metadata between two inspections. Bind only the main file's
		// identity, and don't include transient sidecars in the cross-call digest.
		if (!pathIdentity(input.databasePath, "identity")?.isFile())
			throw new Error("database is missing");
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			try {
				const sidecar = lstatSync(input.databasePath + suffix);
				if (!sidecar.isFile() || sidecar.isSymbolicLink())
					throw new Error("unsupported SQLite sidecar identity");
			} catch (error) {
				if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
					throw error;
			}
		}
		db = new Database(input.databasePath, { readonly: true, strict: true });
		db.exec("PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN");
		for (const [table, columns] of Object.entries(LEGACY_ROOT_HISTORY_COLUMNS))
			query(`SELECT ${columns.map((c) => `"${table}"."${c}"`).join(",")} FROM "${table}" LIMIT 0`);
		const chapterIds = new Set(input.chapterIds);
		const narratorIds = new Set(input.narratorIds);
		const workspacePaths = new Set(input.workspacePaths);
		for (const key of input.snapshotShadowKeys) {
			const separator = key.indexOf("\0");
			if (separator < 1 || !key.slice(separator + 1))
				throw new Error("invalid snapshot shadow key");
			workspacePaths.add(key.slice(separator + 1));
		}
		for (const id of chapterIds) {
			exists("chapter_commits", "chapter_id", id);
			const found = query(
				`SELECT substr(project_id,1,1025) AS project_id, CASE WHEN typeof(commit_count) = 'integer' THEN commit_count ELSE NULL END AS commit_count, CASE WHEN length(CAST(snapshot_shadow_key AS BLOB)) <= 8192 THEN snapshot_shadow_key ELSE NULL END AS snapshot_shadow_key, CASE WHEN snapshot_shadow_key IS NOT NULL AND length(CAST(snapshot_shadow_key AS BLOB)) > 8192 THEN 1 ELSE 0 END AS oversized_shadow_key, ${LEGACY_ROOT_CHAPTER_POINTERS.map((c) => `substr(${c},1,1025) AS ${c}`).join(",")} FROM chapters WHERE id = ?`,
				[id],
			);
			if (found.length !== 1 || found[0].project_id !== input.projectId)
				throw new Error("chapter scope changed");
			// SQLite text substr()/length() stop at NUL. Shadow keys deliberately use
			// device + NUL + path, so bound bytes as BLOB and return the entire key.
			if (found[0].oversized_shadow_key !== 0) throw new Error("oversized chapter shadow key");
			if (
				found[0].snapshot_shadow_key !== null &&
				!input.snapshotShadowKeys.includes(String(found[0].snapshot_shadow_key))
			)
				throw new Error("uninspected chapter shadow key");
			if (
				found[0].commit_count !== 0 ||
				LEGACY_ROOT_CHAPTER_POINTERS.some((c) => found[0][c] !== null)
			)
				throw new History("chapter history boundary");
			const owners = query(
				"SELECT substr(id,1,1025) AS id FROM narrators WHERE chapter_id = ? LIMIT 129",
				[id],
			);
			if (owners.some((owner) => !narratorIds.has(String(owner.id))))
				throw new Error("incomplete chapter narrator scope");
		}
		const inspected = new Set<string>();
		const inspectNarrator = (id: string, ancestors: Set<string>) => {
			if (!id || id.length > 128) throw new Error("oversized narrator guard identity");
			if (ancestors.has(id)) throw new Error("cyclic inherited refs");
			if (inspected.has(id)) return;
			if (inspected.size >= LEGACY_ROOT_HISTORY_LIMITS.inputs)
				throw new Error("inherited narrator budget exceeded");
			const found = query(
				"SELECT substr(id,1,1025) AS id, substr(refs_inherited_from,1,1025) AS refs_inherited_from, CASE WHEN typeof(message_version) = 'integer' THEN message_version ELSE NULL END AS message_version, CASE WHEN typeof(message_structure_version) = 'integer' THEN message_structure_version ELSE NULL END AS message_structure_version, CASE WHEN typeof(next_seq) = 'integer' THEN next_seq ELSE NULL END AS next_seq FROM narrators WHERE id = ?",
				[id],
			);
			if (found.length !== 1) throw new Error("missing inherited narrator");
			const row = found[0];
			const counters = [row.message_version, row.message_structure_version, row.next_seq];
			if (!counters.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0))
				throw new Error("invalid narrator guard counters");
			guards.push({
				id,
				messageVersion: Number(row.message_version),
				messageStructureVersion: Number(row.message_structure_version),
				nextSeq: Number(row.next_seq),
			});
			inspected.add(id);
			if (row.refs_inherited_from !== null)
				inspectNarrator(String(row.refs_inherited_from), new Set([...ancestors, id]));
			for (const table of [
				"narrator_tool_calls",
				"narrator_file_snapshots",
				"narrator_patches",
				"file_change_execution_segments",
			])
				exists(table, "narrator_id", id);
			scan(
				"narrator_messages",
				["id", "commit_sha", "tree_hash_after", "snapshot_commit_sha"],
				inspectMessage,
				"AND narrator_id = ?",
				[id],
			);
			scan(
				"narrator_message_refs",
				["id", "message_id"],
				(ref) => {
					const messages = query(
						"SELECT substr(id,1,1025) AS id, substr(commit_sha,1,1025) AS commit_sha, substr(tree_hash_after,1,1025) AS tree_hash_after, substr(snapshot_commit_sha,1,1025) AS snapshot_commit_sha FROM narrator_messages WHERE id = ?",
						[ref.message_id],
					);
					if (messages.length !== 1) throw new Error("dangling shared message ref");
					inspectMessage(messages[0]);
				},
				"AND narrator_id = ?",
				[id],
			);
		};
		for (const id of narratorIds) inspectNarrator(id, new Set());
		// Conservative global keyset scans account for every visited row, not just matches.
		scan("narrator_file_snapshots", ["id", "file_path"], (row) => {
			const file = String(row.file_path);
			if (
				[...workspacePaths].some(
					(root) => file === root || file.startsWith(`${root.replace(/\/$/, "")}/`),
				)
			)
				throw new History("workspace per-file original");
		});
		scan("file_attributions", ["id", "workspace_path", "narrator_id"], (row) => {
			if (workspacePaths.has(String(row.workspace_path)) || inspected.has(String(row.narrator_id)))
				throw new History("file attribution/effect dependency");
		});
		scan("worktree_tree_snapshots", ["id", "worktree_path"], (row) => {
			if (workspacePaths.has(String(row.worktree_path)))
				throw new History("workspace snapshot index");
		});
		scan("file_change_scopes", ["id", "canonical_root"], (row) => {
			if (workspacePaths.has(String(row.canonical_root)))
				throw new History("workspace file history scope");
		});
		scan("file_change_operations", ["id", "project_id", "narrator_id"], (row) => {
			if (row.project_id === input.projectId || inspected.has(String(row.narrator_id)))
				throw new History("file change operation");
		});
		for (const table of ["file_change_effects", "snapshot_captures"]) {
			scan(table, ["id", "scope_id", "operation_id"], (row) => {
				if (
					query("SELECT substr(id,1,1025) AS id FROM file_change_scopes WHERE id = ?", [
						row.scope_id,
					]).length !== 1
				)
					throw new Error("orphan file history scope");
				if (
					row.operation_id !== null &&
					query("SELECT substr(id,1,1025) AS id FROM file_change_operations WHERE id = ?", [
						row.operation_id,
					]).length !== 1
				)
					throw new Error("orphan file history operation");
			});
		}
		scan("merge_sessions", ["id", "target_chapter_id", "source_chapter_ids"], (row) => {
			if (chapterIds.has(String(row.target_chapter_id))) throw new History("chapter merge session");
			const sources: unknown = JSON.parse(String(row.source_chapter_ids));
			if (!Array.isArray(sources)) throw new Error("invalid merge source list");
			if (sources.some((id) => chapterIds.has(id))) throw new History("chapter merge source");
		});
		for (const path of input.shadowDirectories) shadow(path);
		check();
	} catch (error) {
		status = error instanceof History ? "history" : "unknown";
		reason = error instanceof Error ? error.message.slice(0, 160) : "history inspection failed";
	} finally {
		try {
			if (db) {
				try {
					db.exec("ROLLBACK");
				} finally {
					db.close();
				}
			}
		} catch {
			status = "unknown";
			reason = "readonly snapshot close failed";
		}
	}
	try {
		for (const path of fingerprints.keys()) stat(path);
		record([...fingerprints].sort(([a], [b]) => a.localeCompare(b)));
		check();
	} catch {
		status = "unknown";
		reason = "filesystem changed or final fingerprint budget exceeded";
	}
	guards.sort((a, b) => a.id.localeCompare(b.id));
	evidence.update(JSON.stringify({ status, reason, guards }));
	return { status, digest: evidence.digest("hex"), reason, guards };
}
