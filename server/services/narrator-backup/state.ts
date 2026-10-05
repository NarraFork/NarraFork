import { NARRATOR_BACKUP_LIMITS as LIMITS } from "@shared/narrator-backup";
import type { ArchiveRow, ArchiveValue } from "../project-archive/main-store";
import {
	BACKUP_REQUIRED_COLUMNS,
	BACKUP_TABLES,
	type BackupActor,
	type BackupState,
	type BackupTable,
	type NarratorBackupMainStore,
} from "./contract";

export function checkBackupControl(signal: AbortSignal, deadline: number): void {
	signal.throwIfAborted();
	if (Date.now() >= deadline) throw new Error("Backup deadline exceeded");
}
export function assertFullExport(row: ArchiveRow, actor: BackupActor, root?: ArchiveRow): void {
	const authority = row.type === "subagent" ? root : row;
	if (!actor.isAdmin && authority?.owner_user_id !== actor.userId)
		throw new Error("Backup requires owner/admin authority for every dependency");
}

/** Bounded closure reads. Provenance and effective lazy windows are preserved WITHOUT source writes. */
export async function collectBackupState(
	store: NarratorBackupMainStore,
	requestedIds: string[],
	actor: BackupActor,
	check: () => void,
): Promise<BackupState> {
	const state: BackupState = { rows: {} };
	let bytes = 0;
	let count = 0;
	const ids = new Map<BackupTable, Set<string>>();
	const dependencyQueue: [BackupTable, ArchiveRow][] = [];
	const put = (table: BackupTable, row: ArchiveRow) => {
		check();
		if (typeof row.id !== "string") throw new Error("Backup row requires an ID");
		const known = ids.get(table) ?? new Set<string>();
		ids.set(table, known);
		if (known.has(row.id)) return;
		const size = Buffer.byteLength(JSON.stringify(row));
		bytes += size;
		if (size > LIMITS.rowBytes || bytes > LIMITS.stateBytes || ++count > LIMITS.stateRows)
			throw new Error("Backup state budget exceeded");
		known.add(row.id);
		state.rows[table] ??= [];
		state.rows[table].push(row);
		dependencyQueue.push([table, row]);
	};
	async function read(
		table: BackupTable,
		column: string,
		values: string[],
		consume: (row: ArchiveRow) => void,
		beforeSeq?: number,
		subagentsOnly?: boolean,
	) {
		for (let offset = 0; offset < values.length; offset += 200) {
			let after: string | undefined;
			for (;;) {
				check();
				const page = await store.read({
					table,
					column,
					values: values.slice(offset, offset + 200),
					after,
					limit: LIMITS.pageRows,
					beforeSeq,
					subagentsOnly,
				});
				if (!page.length) break;
				for (const row of page) consume(row);
				const cursor = page.at(-1)?.id;
				if (typeof cursor !== "string" || (after !== undefined && cursor <= after))
					throw new Error("Invalid backup cursor");
				after = cursor;
			}
		}
	}
	for (const table of Object.keys(BACKUP_TABLES) as BackupTable[]) {
		const columns = await store.columns(table);
		for (const required of BACKUP_REQUIRED_COLUMNS[table] ?? ["id"])
			if (!columns.includes(required))
				throw new Error(`Required backup column missing: ${table}.${required}`);
	}
	const narrators = new Map<string, ArchiveRow>();
	async function dependencies(input: string[]) {
		const pending = [...new Set(input)];
		for (let offset = 0; offset < pending.length; offset++) {
			check();
			const id = pending[offset];
			if (narrators.has(id)) continue;
			if (narrators.size >= LIMITS.stateRows) throw new Error("Narrator closure budget exceeded");
			const row = (
				await store.read({ table: "narrators", column: "id", values: [id], limit: 1 })
			)[0];
			if (!row) throw new Error("Missing narrator dependency");
			const root =
				typeof row.acl_root_narrator_id === "string"
					? (
							await store.read({
								table: "narrators",
								column: "id",
								values: [row.acl_root_narrator_id],
								limit: 1,
							})
						)[0]
					: undefined;
			assertFullExport(row, actor, root);
			narrators.set(id, row);
			for (const field of ["parent_narrator_id", "refs_inherited_from", "acl_root_narrator_id"])
				if (typeof row[field] === "string") pending.push(row[field]);
		}
	}
	const full = new Set(requestedIds);
	const selected = [...full];
	// Only requested conversations and their actual subagent descendants own full history.
	// Parent/ACL/lazy ancestors are metadata dependencies, never reverse-enumeration roots.
	for (let offset = 0; offset < selected.length; offset++) {
		await dependencies([selected[offset]]);
		await read(
			"narrators",
			"parent_narrator_id",
			[selected[offset]],
			(child) => {
				if (child.type === "subagent" && typeof child.id === "string" && !full.has(child.id)) {
					full.add(child.id);
					selected.push(child.id);
				}
			},
			undefined,
			true,
		);
	}
	const prefixes = new Map<string, number>();
	function prefix(start: string, bound: number) {
		const seen = new Set<string>();
		let current: string | undefined = start;
		while (current) {
			if (seen.has(current) || seen.size >= 32) throw new Error("Invalid lazy inheritance cycle");
			seen.add(current);
			prefixes.set(current, Math.max(prefixes.get(current) ?? 0, bound));
			const row = narrators.get(current);
			if (typeof row?.refs_inherited_from !== "string") break;
			if (
				typeof row.refs_backfill_cursor !== "number" ||
				!Number.isSafeInteger(row.refs_backfill_cursor) ||
				row.refs_backfill_cursor < 0
			)
				throw new Error("Invalid lazy inheritance window");
			bound = Math.min(bound, row.refs_backfill_cursor);
			current = row.refs_inherited_from;
		}
	}
	for (const id of selected) {
		const row = narrators.get(id);
		if (!row) throw new Error("Missing selected narrator");
		if (typeof row.refs_inherited_from === "string") {
			if (
				typeof row.refs_backfill_cursor !== "number" ||
				!Number.isSafeInteger(row.refs_backfill_cursor) ||
				row.refs_backfill_cursor < 0
			)
				throw new Error("Invalid lazy inheritance window");
			prefix(row.refs_inherited_from, row.refs_backfill_cursor);
		}
		if (typeof row.fork_message_id === "string" && typeof row.parent_narrator_id === "string") {
			const refs: ArchiveRow[] = [];
			await read("narrator_message_refs", "message_id", [row.fork_message_id], (ref) => {
				if (refs.length >= LIMITS.stateRows) throw new Error("Fork ref budget exceeded");
				refs.push(ref);
			});
			let parent: string | undefined = row.parent_narrator_id;
			let limit = Number.MAX_SAFE_INTEGER;
			for (let depth = 0; parent && depth < 32; depth++) {
				const ref = refs.find(
					(candidate) =>
						candidate.narrator_id === parent &&
						typeof candidate.seq === "number" &&
						candidate.seq < limit,
				);
				if (ref) {
					prefix(parent, Number(ref.seq) + 1);
					break;
				}
				const ancestor = narrators.get(parent);
				limit = Math.min(limit, Number(ancestor?.refs_backfill_cursor ?? 0));
				parent =
					typeof ancestor?.refs_inherited_from === "string"
						? ancestor.refs_inherited_from
						: undefined;
			}
		}
	}
	for (const table of Object.keys(BACKUP_TABLES) as BackupTable[]) {
		if (table === "narrators" || (table.startsWith("spec_") && table !== "spec_namespaces"))
			continue;
		const column = table === "narrator_worktree_resources" ? "owner_narrator_id" : "narrator_id";
		await read(table, column, selected, (row) => put(table, row));
	}
	for (const [id, bound] of prefixes)
		if (!full.has(id) && bound > 0)
			await read(
				"narrator_message_refs",
				"narrator_id",
				[id],
				(row) => put("narrator_message_refs", row),
				bound,
			);
	const referenced = [
		...(state.rows.narrator_message_refs ?? []).map((r) => String(r.message_id)),
		...selected
			.map((id) => narrators.get(id)?.fork_message_id)
			.filter((value): value is string => typeof value === "string"),
	];
	await read("narrator_messages", "id", referenced, (row) => put("narrator_messages", row));
	await dependencies((state.rows.narrator_messages ?? []).map((row) => String(row.narrator_id)));
	const messageIds = (state.rows.narrator_messages ?? []).map((r) => String(r.id));
	await read("narrator_tool_calls", "message_id", messageIds, (row) =>
		put("narrator_tool_calls", row),
	);
	await dependencies((state.rows.narrator_tool_calls ?? []).map((row) => String(row.narrator_id)));
	// Task results may be messages authored by a parent's subagent, not a ref of the
	// selected fork. Follow ONLY explicit result edges; never enumerate siblings.
	for (let offset = 0; offset < (state.rows.narrator_tool_calls ?? []).length; offset++) {
		check();
		const tool = state.rows.narrator_tool_calls?.[offset];
		const resultId = tool?.result_message_id;
		if (typeof resultId !== "string" || ids.get("narrator_messages")?.has(resultId)) continue;
		const result = (
			await store.read({ table: "narrator_messages", column: "id", values: [resultId], limit: 1 })
		)[0];
		if (!result) throw new Error("Missing tool result dependency");
		// Author authority is checked before collecting either content or its tool edges.
		await dependencies([String(result.narrator_id)]);
		const author = narrators.get(String(result.narrator_id));
		if (
			result.narrator_id !== tool?.narrator_id &&
			(author?.type !== "subagent" ||
				author.parent_narrator_id !== tool?.narrator_id ||
				(author.origin_tool_call_id !== tool?.id &&
					result.parent_tool_use_id !== tool?.tool_use_id))
		)
			throw new Error("Tool result is outside its source scope");
		put("narrator_messages", result);
		await read("narrator_tool_calls", "message_id", [resultId], (row) =>
			put("narrator_tool_calls", row),
		);
		await dependencies(
			(state.rows.narrator_tool_calls ?? []).map((row) => String(row.narrator_id)),
		);
	}
	const namespaces = (state.rows.spec_namespaces ?? []).map((r) => String(r.id));
	for (const table of [
		"spec_file_revisions",
		"spec_namespace_files",
		"spec_protected_tasks",
	] as const)
		await read(table, "namespace_id", namespaces, (row) => put(table, row));
	const specDependencies: Partial<Record<BackupTable, Record<string, BackupTable>>> = {
		spec_namespaces: { forked_from_namespace_id: "spec_namespaces" },
		spec_file_revisions: {
			namespace_id: "spec_namespaces",
			parent_revision_id: "spec_file_revisions",
			source_message_id: "narrator_messages",
		},
		spec_namespace_files: { namespace_id: "spec_namespaces", revision_id: "spec_file_revisions" },
		spec_protected_tasks: {
			namespace_id: "spec_namespaces",
			first_revision_id: "spec_file_revisions",
			last_revision_id: "spec_file_revisions",
		},
	};
	// Immutable COW spec dependencies are sparse: no ancestor's current files/tasks/history.
	for (let offset = 0; offset < dependencyQueue.length; offset++) {
		check();
		const [table, row] = dependencyQueue[offset];
		for (const [field, target] of Object.entries(specDependencies[table] ?? {})) {
			const value = row[field];
			if (value == null) continue;
			if (typeof value !== "string") throw new Error("Invalid spec dependency");
			if (!ids.get(target)?.has(value))
				await read(target, "id", [value], (dependency) => put(target, dependency));
			if (!ids.get(target)?.has(value)) throw new Error("Missing spec dependency");
		}
	}
	await dependencies(
		[...(state.rows.narrator_messages ?? []), ...(state.rows.spec_namespaces ?? [])].map((row) =>
			String(row.narrator_id),
		),
	);
	for (const [id, row] of narrators)
		put(
			"narrators",
			full.has(id)
				? row
				: {
						...row,
						fork_message_id: null,
						context_summary: null,
						system_prompt: null,
						api_conversation_id: null,
						background_result: null,
						message_count: 0,
						last_message_at: null,
					},
		);
	const messages = new Set((state.rows.narrator_messages ?? []).map((row) => String(row.id)));
	for (const ref of state.rows.narrator_message_refs ?? [])
		if (!messages.has(String(ref.message_id))) throw new Error("Missing shared history dependency");
	validateBackupStateClosure(state);
	return state;
}

/** Foreign/source IDs describe history, not target authority. Every internal edge must close. */
export function validateBackupStateClosure(state: BackupState): void {
	const ids = new Map<BackupTable, Set<string>>();
	for (const [table, rows] of Object.entries(state.rows) as [BackupTable, ArchiveRow[]][]) {
		const unique = new Set<string>();
		for (const row of rows) {
			if (typeof row.id !== "string" || !row.id || unique.has(row.id))
				throw new Error("Invalid or duplicate backup row ID");
			unique.add(row.id);
		}
		ids.set(table, unique);
	}
	const require = (table: BackupTable, value: ArchiveValue | undefined) => {
		if (value != null && (typeof value !== "string" || !ids.get(table)?.has(value)))
			throw new Error("Missing internal conversation dependency");
	};
	for (const [table, rows] of Object.entries(state.rows) as [BackupTable, ArchiveRow[]][]) {
		for (const row of rows) {
			if (table !== "narrators" && Object.hasOwn(row, "narrator_id"))
				require("narrators", row.narrator_id);
			if (table === "narrators") {
				for (const field of ["parent_narrator_id", "refs_inherited_from", "acl_root_narrator_id"])
					require("narrators", row[field]);
				require("narrator_messages", row.fork_message_id);
			}
			if (table === "narrator_message_refs" || table === "narrator_tool_calls")
				require("narrator_messages", row.message_id);
			if (table === "narrator_message_refs") require("narrator_messages", row.segment_compact_id);
			if (table === "narrator_tool_calls") require("narrator_messages", row.result_message_id);
			if (table === "permission_rule_requests") require("narrator_tool_calls", row.tool_call_id);
			if (table === "narrator_worktree_resources") require("narrators", row.owner_narrator_id);
			if (table === "spec_namespaces") require("spec_namespaces", row.forked_from_namespace_id);
			if (table.startsWith("spec_") && table !== "spec_namespaces")
				require("spec_namespaces", row.namespace_id);
			if (table === "spec_file_revisions") {
				require("spec_file_revisions", row.parent_revision_id);
				require("narrator_messages", row.source_message_id);
			}
			if (table === "spec_namespace_files") require("spec_file_revisions", row.revision_id);
			if (table === "spec_protected_tasks") {
				require("spec_file_revisions", row.first_revision_id);
				require("spec_file_revisions", row.last_revision_id);
			}
		}
	}
	const narrators = new Map((state.rows.narrators ?? []).map((row) => [String(row.id), row]));
	for (const row of narrators.values()) {
		const seen = new Set<string>();
		let current: ArchiveRow | undefined = row;
		while (current?.refs_inherited_from != null) {
			if (
				seen.has(String(current.id)) ||
				seen.size >= 32 ||
				typeof current.refs_backfill_cursor !== "number" ||
				current.refs_backfill_cursor < 0
			)
				throw new Error("Invalid lazy inheritance window or cycle");
			seen.add(String(current.id));
			current = narrators.get(String(current.refs_inherited_from));
		}
	}
}

/** Historical IDs/content remain intact. No live queue, claim, lease, permission or spec task. */
export function archivedBackupState(original: BackupState): BackupState {
	const rows: BackupState["rows"] = {};
	for (const [table, source] of Object.entries(original.rows) as [BackupTable, ArchiveRow[]][]) {
		rows[table] = source.map((value) => {
			const row: Record<string, ArchiveValue> = { ...value };
			if (table === "narrators") {
				Object.assign(row, {
					status: "archived",
					substatus: "[]",
					is_background: 0,
					background_status: "cancelled",
					turn_started_at: null,
					api_conversation_id: null,
					permission_mode: "readOnly",
					previous_permission_mode: null,
					plan_mode: 0,
				});
			} else if (table === "narrator_tool_calls") {
				Object.assign(row, {
					execution_origin_tool_call_id: row.execution_origin_tool_call_id ?? row.id,
					execution_identity_version: 0,
					execution_attempt: 0,
					execution_segment_id: null,
					file_change_operation_id: null,
					is_background: 0,
				});
				if (["initializing", "pending", "running"].includes(String(row.status))) {
					row.status = "fail";
					row.error_message = "Archived backup: execution cancelled; manual activation required";
					row.permission_decided_by = null;
					row.permission_decided_at = null;
				}
			} else if (table === "permission_rule_requests") {
				row.status = "cancelled";
				row.rule_id = null;
			} else if (table.includes("whitelist")) {
				// Freeze grants, never denials: manual activation must retain forbidden
				// paths/commands. Same-instance IDs/paths remain unchanged.
				row.enabled = 0;
			} else if (table === "narrator_worktree_resources") row.state = "unknown";
			else if (table === "spec_namespace_files" && row.path === "tasks.json") {
				row.revision_id = null;
				row.deleted = 1;
			} else if (table === "spec_protected_tasks") {
				row.status = "deleted";
				row.deleted_at = new Date().toISOString();
			}
			return row;
		});
	}
	return { rows };
}
