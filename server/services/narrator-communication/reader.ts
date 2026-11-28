import {
	COMMUNICATION_LIMITS,
	type CommunicationNode,
	type CommunicationScope,
	type CommunicationTopology,
} from "@shared/narrator-communication";
import { foldHandle } from "@shared/narrator-handle";
import { activeDatabaseBackend, postgresRuntime } from "../../db";
import { getDbPath } from "../../db/connection";
import { AppError, NotFoundError } from "../../lib/errors";
import { executionPrincipalOf } from "../../lib/runtime-source";
import type { NarratorPrincipal } from "../narrator-acl";
import {
	createPostgresCommunicationCandidateExecutor,
	getCommunicationAccessEpoch,
} from "../search/communication-candidates";
import {
	createSqliteSearchQueryExecutor,
	type SearchQueryExecutor,
} from "../search/sqlite-worker-runner";
import { communicationCandidateSearchGuard, decodeCommunicationJson } from "./access";
import {
	boundPrincipalPredicate,
	communicationProjectReadableText,
	communicationReadPredicate,
	communicationWritePredicate,
} from "./predicates";

const workerReader = createSqliteSearchQueryExecutor(getDbPath, {
	timeoutMs: 5000,
	maxOutstanding: 16,
});
/** Worker creation, readiness, cancellation and failure never trigger inline execution. */
export const communicationRead: SearchQueryExecutor = async (text, params, options) => {
	if (activeDatabaseBackend === "sqlite") return workerReader(text, params, options);
	if (!postgresRuntime || postgresRuntime.closed)
		throw new AppError("Communication unavailable", 503, "COMMUNICATION_UNAVAILABLE");
	return createPostgresCommunicationCandidateExecutor(postgresRuntime.executor)(
		text,
		params,
		options,
	);
};
const denied = () => {
	throw new AppError(
		"Communication target is unavailable or disconnected",
		403,
		"COMMUNICATION_DENIED",
	);
};
const placeholders = (ids: readonly string[]) => ids.map(() => "?").join(",");
const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);

/** Factories are explicit reader injection for fixtures, never a production fallback. */
export function createCommunicationReader(execute: SearchQueryExecutor) {
	async function currentPrincipal(
		principal: NarratorPrincipal,
		signal?: AbortSignal,
	): Promise<NarratorPrincipal> {
		const [user] = await execute(
			"SELECT id, role FROM users WHERE id = ? LIMIT 1",
			[principal.userId],
			{ signal },
		);
		if (!user) return denied();
		return { userId: String(user.id), isAdmin: user.role === "admin" };
	}
	return async (
		scope: CommunicationScope,
		principal: NarratorPrincipal,
		options: { signal?: AbortSignal; maxNodes?: number; maxPeers?: number } = {},
	): Promise<CommunicationTopology> => {
		const signal = options.signal;
		const accessEpoch = getCommunicationAccessEpoch();
		signal?.throwIfAborted();
		const actor = await currentPrincipal(principal, signal);
		const readable = communicationReadPredicate("n", actor);
		const writable = communicationWritePredicate("n", actor);
		const maxNodes = Math.max(
			1,
			Math.min(
				options.maxNodes ?? COMMUNICATION_LIMITS.maxVisibleNodes,
				COMMUNICATION_LIMITS.maxVisibleNodes,
			),
		);
		const maxPeers = Math.max(
			0,
			Math.min(
				options.maxPeers ?? COMMUNICATION_LIMITS.maxVisiblePeers,
				COMMUNICATION_LIMITS.maxVisiblePeers,
			),
		);
		const anchorId = scope.kind === "narrator" ? scope.narratorId : scope.teamId;
		if (!validId(anchorId)) return denied();
		const [anchor] = await execute(
			`SELECT n.id FROM narrators n WHERE n.id = ? AND NOT n.hidden_from_lists AND ${readable.sql} LIMIT 1`,
			[anchorId, ...readable.params],
			{ signal },
		);
		if (!anchor) throw new NotFoundError("Communication scope", anchorId);
		let seed: string;
		let seedParams: Array<string | number | null>;
		if (scope.kind === "narrator") {
			const [root] = await execute(
				`WITH RECURSIVE ancestors(id, parent, depth) AS (
    SELECT narrator_id, parent_narrator_id, 1 FROM narrator_communication_nodes WHERE narrator_id = ?
    UNION ALL SELECT c.narrator_id, c.parent_narrator_id, a.depth + 1 FROM narrator_communication_nodes c JOIN ancestors a ON c.narrator_id = a.parent WHERE a.depth < 16
   ) SELECT id FROM ancestors WHERE parent IS NULL LIMIT 1`,
				[anchorId],
				{ signal },
			);
			if (!root) return denied();
			seed = `WITH RECURSIVE members(id, depth) AS (SELECT ?, 1 UNION ALL SELECT c.narrator_id, m.depth + 1 FROM narrator_communication_nodes c JOIN members m ON c.parent_narrator_id = m.id WHERE m.depth < 16), core AS (SELECT id FROM members)`;
			seedParams = [String(root.id)];
		} else {
			const teamProject = actor.isAdmin
				? { sql: "1=1", params: [] as string[] }
				: boundPrincipalPredicate(communicationProjectReadableText("project"), actor);
			const [team] = await execute(
				`SELECT t.narrator_id FROM project_teams t JOIN projects project ON project.id=t.project_id WHERE t.narrator_id = ? AND t.project_id = ? AND ${teamProject.sql} LIMIT 1`,
				[scope.teamId, scope.projectId, ...teamProject.params],
				{ signal },
			);
			if (!team) throw new NotFoundError("Communication scope", anchorId);
			// Team identity remains the ACL/delegation tree, not the communication root.
			seed = `WITH RECURSIVE core AS (SELECT n.id FROM narrators n WHERE n.id = ? OR n.acl_root_narrator_id = ? OR EXISTS (SELECT 1 FROM team_work_items w WHERE w.team_id = ? AND w.worker_narrator_id = n.id))`;
			seedParams = [anchorId, anchorId, anchorId];
		}
		const rows = await execute(
			`${seed}, candidates(id) AS (
   SELECT id FROM core UNION SELECT p.endpoint_hi FROM narrator_communication_peers p JOIN core c ON c.id = p.endpoint_lo UNION SELECT p.endpoint_lo FROM narrator_communication_peers p JOIN core c ON c.id = p.endpoint_hi
   UNION SELECT c.original_parent_narrator_id FROM narrator_communication_nodes c JOIN core k ON k.id=c.narrator_id WHERE c.parent_narrator_id IS NULL AND c.original_parent_narrator_id IS NOT NULL
   UNION SELECT c.narrator_id FROM narrator_communication_nodes c JOIN core k ON k.id=c.original_parent_narrator_id WHERE c.parent_narrator_id IS NULL
  ), selected AS (
   SELECT n.id, substr(n.title,1,512) AS title, substr(n.handle,1,128) AS handle, n.status, substr(n.substatus,1,4096) AS substatus, n.type, c.parent_narrator_id, c.original_parent_narrator_id, c.version,
    CASE WHEN ${writable.sql} THEN 1 ELSE 0 END AS can_manage
   FROM candidates k JOIN narrators n ON n.id = k.id JOIN narrator_communication_nodes c ON c.narrator_id = n.id
   WHERE NOT n.hidden_from_lists AND ${readable.sql}
   ORDER BY CASE WHEN n.id = ? THEN 0 ELSE 1 END, n.id LIMIT ?
  ), ancestry(origin, id, parent, depth) AS (
   SELECT id, id, parent_narrator_id, 1 FROM selected UNION ALL SELECT a.origin, c.narrator_id, c.parent_narrator_id, a.depth + 1 FROM narrator_communication_nodes c JOIN ancestry a ON c.narrator_id = a.parent WHERE a.depth < 16
  ) SELECT s.*, a.id AS root_id FROM selected s JOIN ancestry a ON a.origin = s.id AND a.parent IS NULL`,
			[...seedParams, ...writable.params, ...readable.params, anchorId, maxNodes + 1],
			{ signal, operation: "communication-topology" },
		);
		let truncated = rows.length > maxNodes;
		const visible = rows.slice(0, maxNodes);
		const ids = new Set(visible.map((row) => String(row.id)));
		const representatives = new Map<string, string>();
		for (const row of visible) {
			const root = String(row.root_id);
			const id = String(row.id);
			if (!representatives.has(root) || id < (representatives.get(root) ?? id))
				representatives.set(root, id);
		}
		const nodes: CommunicationNode[] = visible.map((row) => ({
			id: String(row.id),
			title: row.title == null ? null : String(row.title),
			handle: row.handle == null ? null : String(row.handle),
			status: String(row.status),
			parentNarratorId:
				row.parent_narrator_id && ids.has(String(row.parent_narrator_id))
					? String(row.parent_narrator_id)
					: null,
			groupId: ids.has(String(row.root_id))
				? String(row.root_id)
				: (representatives.get(String(row.root_id)) ?? String(row.id)),
			version: Number(row.version),
			canManage: Number(row.can_manage) === 1,
			canConnect: Number(row.can_manage) === 1 && row.status !== "archived",
			restoreParentId:
				row.original_parent_narrator_id &&
				ids.has(String(row.original_parent_narrator_id)) &&
				visible.some(
					(parent) =>
						parent.id === row.original_parent_narrator_id && Number(parent.can_manage) === 1,
				) &&
				Number(row.can_manage) === 1
					? String(row.original_parent_narrator_id)
					: null,
			delegated: row.type === "subagent",
			substatus: (() => {
				try {
					const value = JSON.parse(String(row.substatus ?? "[]"));
					return Array.isArray(value)
						? value.filter((item): item is string => typeof item === "string").slice(0, 16)
						: [];
				} catch {
					return [];
				}
			})(),
		}));
		if (ids.size) {
			const coordinatorRead = communicationReadPredicate("coordinator", actor);
			const projectRead = actor.isAdmin
				? { sql: "1=1", params: [] as string[] }
				: boundPrincipalPredicate(communicationProjectReadableText("project"), actor);
			const annotations = await execute(
				`SELECT n.id AS node_id, t.narrator_id AS team_id, substr(coordinator.title,1,256) AS team_name,
    (SELECT substr(item.title,1,256) FROM team_work_items item WHERE item.team_id=t.narrator_id AND item.worker_narrator_id=n.id ORDER BY item.updated_at DESC,item.id DESC LIMIT 1) AS work_title
    FROM narrators n
    JOIN project_teams t ON (t.narrator_id=n.id OR t.narrator_id=n.acl_root_narrator_id OR EXISTS (SELECT 1 FROM team_work_items membership WHERE membership.team_id=t.narrator_id AND membership.worker_narrator_id=n.id))
    JOIN narrators coordinator ON coordinator.id=t.narrator_id JOIN projects project ON project.id=t.project_id
    WHERE n.id IN (${placeholders([...ids])}) AND ${coordinatorRead.sql} AND ${projectRead.sql}
    ORDER BY n.id,t.narrator_id LIMIT ?`,
				[...ids, ...coordinatorRead.params, ...projectRead.params, maxNodes],
				{ signal },
			);
			for (const annotation of annotations) {
				const node = nodes.find((candidate) => candidate.id === annotation.node_id);
				if (!node || node.team) continue;
				node.team = {
					id: String(annotation.team_id),
					name: String(annotation.team_name ?? ""),
					...(annotation.work_title == null
						? {}
						: { workItem: { title: String(annotation.work_title) } }),
				};
			}
		}
		const peers = ids.size
			? await execute(
					`SELECT p.id, p.endpoint_lo, p.endpoint_hi, p.created_at FROM narrator_communication_peers p WHERE p.endpoint_lo IN (${placeholders([...ids])}) AND p.endpoint_hi IN (${placeholders([...ids])}) ORDER BY p.id LIMIT ?`,
					[...ids, ...ids, maxPeers + 1],
					{ signal },
				)
			: [];
		truncated ||= peers.length > maxPeers;
		const topology: CommunicationTopology = {
			scope,
			nodes,
			peers: peers.slice(0, maxPeers).map((peer) => ({
				id: String(peer.id),
				endpointLo: String(peer.endpoint_lo),
				endpointHi: String(peer.endpoint_hi),
				createdAt: String(peer.created_at),
				canDisconnect: nodes.some(
					(node) =>
						(node.id === peer.endpoint_lo || node.id === peer.endpoint_hi) && node.canManage,
				),
			})),
			truncated,
		};
		// No unreadable root, parent, original delegator, team or hidden count escapes this projection.
		while (
			Buffer.byteLength(JSON.stringify(topology)) > COMMUNICATION_LIMITS.maxSnapshotBytes &&
			topology.nodes.length
		) {
			topology.truncated = true;
			topology.nodes.pop();
			const kept = new Set(topology.nodes.map((node) => node.id));
			topology.peers = topology.peers.filter(
				(peer) => kept.has(peer.endpointLo) && kept.has(peer.endpointHi),
			);
			for (const node of topology.nodes) {
				if (node.parentNarratorId && !kept.has(node.parentNarratorId)) node.parentNarratorId = null;
				if (node.restoreParentId && !kept.has(node.restoreParentId)) node.restoreParentId = null;
			}
		}
		signal?.throwIfAborted();
		const current = await currentPrincipal(actor, signal);
		if (getCommunicationAccessEpoch() !== accessEpoch || current.isAdmin !== actor.isAdmin)
			throw new AppError("Communication access changed", 403, "COMMUNICATION_ACCESS_CHANGED");
		return topology;
	};
}
export const getCommunicationTopology = createCommunicationReader(communicationRead);

export interface CommunicationTarget {
	id: string;
	title: string | null;
	handle: string | null;
	status: string;
	aliases?: string[];
	selectorRank?: number;
	matchesBareHandle?: boolean;
}
interface CommunicationTargetReadOptions {
	limit?: number;
	signal?: AbortSignal;
	/** Lookup matches before applying the row limit; the prompt listing omits this. */
	selector?: { name: string; activeAliasIds: readonly string[] };
}
export function createCommunicationTargetReader(
	execute: SearchQueryExecutor,
	authorize = communicationCandidateSearchGuard,
) {
	return async (
		source: string,
		options: CommunicationTargetReadOptions = {},
	): Promise<CommunicationTarget[]> => {
		const accessEpoch = getCommunicationAccessEpoch();
		const [row] = await execute(
			"SELECT owner_user_id, runtime_registration_json FROM narrators WHERE id = ? AND status <> 'archived' AND NOT hidden_from_lists LIMIT 1",
			[source],
			options,
		);
		if (!row) return denied();
		const execution = executionPrincipalOf({
			ownerUserId: row.owner_user_id as string | null,
			runtimeRegistrationJson: decodeCommunicationJson(row.runtime_registration_json),
		});
		if (!execution?.userId) return denied();
		const guard = await authorize(
			source,
			{ userId: execution.userId, isAdmin: false },
			{ ...options, deadlineAt: Date.now() + 5000 },
		);
		const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
		const aliasTraits =
			guard.backend === "sqlite"
				? "json_each(n.traits)"
				: "jsonb_array_elements_text(n.traits::jsonb) AS value";
		const alias = `(SELECT substr(value,16,128) FROM ${aliasTraits} WHERE value LIKE 'subagent-alias:%' LIMIT 1)`;
		const { selector } = options;
		const activeAliasIds = selector?.activeAliasIds ?? [];
		const explicitHandle = selector?.name.startsWith("@");
		const bareHandle = selector && !explicitHandle;
		const handle = selector ? foldHandle(selector.name.replace(/^@/, "")) : "";
		const rank = selector
			? `CASE ${explicitHandle ? "WHEN n.handle_fold = ? THEN -1" : ""}
      ${activeAliasIds.length ? `WHEN n.id IN (${placeholders(activeAliasIds)}) THEN 0` : ""}
      WHEN n.alias_selector = ? OR EXISTS (SELECT 1 FROM ${aliasTraits} WHERE value = ?) THEN 1
      WHEN n.title_slug = ? OR n.title = ? OR substr(n.id,1,length(?)) = ?
      ${bareHandle ? "OR n.handle_fold = ?" : ""} THEN 2 ELSE NULL END`
			: "0";
		// Preserve the unique bare-handle row ahead of LIMIT even when stronger
		// alias matches exist. Keep its rank so titles alone cannot outrank an alias.
		const bareHandleMatch = bareHandle ? "CASE WHEN n.handle_fold = ? THEN 1 ELSE 0 END" : "0";
		const order = bareHandle ? "bare_handle DESC,selector_rank,id" : "selector_rank,id";
		const selectorParams = selector
			? [
					...(explicitHandle ? [handle] : []),
					...activeAliasIds,
					selector.name,
					`subagent-alias:${selector.name}`,
					selector.name,
					selector.name,
					selector.name,
					selector.name,
					...(bareHandle ? [handle, handle] : []),
				]
			: [];
		const rows = await execute(
			`WITH RECURSIVE ancestors(id,parent,depth) AS (
 SELECT narrator_id,parent_narrator_id,1 FROM narrator_communication_nodes WHERE narrator_id = ? UNION ALL SELECT c.narrator_id,c.parent_narrator_id,a.depth+1 FROM narrator_communication_nodes c JOIN ancestors a ON c.narrator_id=a.parent WHERE a.depth<16
 ), members(id,depth) AS (
 SELECT id,1 FROM ancestors WHERE parent IS NULL UNION ALL SELECT c.narrator_id,m.depth+1 FROM narrator_communication_nodes c JOIN members m ON c.parent_narrator_id=m.id WHERE m.depth<16
 ), targets(id) AS (
 SELECT id FROM members UNION SELECT endpoint_hi FROM narrator_communication_peers WHERE endpoint_lo=? UNION SELECT endpoint_lo FROM narrator_communication_peers WHERE endpoint_hi=?
 ), candidates AS (
 SELECT n.id,substr(n.title,1,512) AS title,substr(n.handle,1,128) AS handle,n.status,${alias} AS alias,
 ${rank} AS selector_rank,${bareHandleMatch} AS bare_handle
 FROM narrators n JOIN targets t ON t.id=n.id JOIN narrator_communication_nodes c ON c.narrator_id=n.id
 WHERE n.id<>? AND n.status<>'archived' AND NOT n.hidden_from_lists AND (${guard.sql})
 ) SELECT * FROM candidates WHERE selector_rank IS NOT NULL ORDER BY ${order} LIMIT ?`,
			[source, source, source, ...selectorParams, source, ...guard.params, limit],
			options,
		);
		const currentGuard = await authorize(
			source,
			{ userId: execution.userId, isAdmin: false },
			{ ...options, deadlineAt: Date.now() + 5000 },
		);
		if (
			accessEpoch !== getCommunicationAccessEpoch() ||
			JSON.stringify(currentGuard) !== JSON.stringify(guard)
		)
			throw new AppError("Communication access changed", 403, "COMMUNICATION_ACCESS_CHANGED");
		return rows.map((row) => ({
			id: String(row.id),
			title: row.title == null ? null : String(row.title),
			handle: row.handle == null ? null : String(row.handle),
			status: String(row.status),
			...(row.alias ? { aliases: [String(row.alias)] } : {}),
			...(selector ? { selectorRank: Number(row.selector_rank) } : {}),
			...(Number(row.bare_handle) === 1 ? { matchesBareHandle: true } : {}),
		}));
	};
}
export const listCommunicationTargets = createCommunicationTargetReader(communicationRead);
