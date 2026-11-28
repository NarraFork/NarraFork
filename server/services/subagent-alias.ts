import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { type ReadQueryOptions, readQuery, readQueryFirst } from "../db/worker-read";
import { AsyncMutex, narratorTraitsLock } from "../lib/async-mutex";
import {
	ADDRESSABLE_NARRATOR_STATUSES,
	addressableTeamMembersWhere,
	isTeamMember,
	teamMembersWhere,
} from "../lib/runtime-source";
import { escapeLikeNeedle } from "../lib/sql-like";
import { RuntimeReadConflictError } from "./agent-runtime/read-conflict";

type AliasReadOptions = Pick<ReadQueryOptions, "signal" | "deadlineAt" | "timeoutMs">;

/** Background-task statuses that are still in progress, independent of the narrator row. */
const LIVE_TASK_STATUSES = ["running", "paused"] as const;
/** How many candidate suffixes to probe in one indexed query. */
const ALIAS_CANDIDATE_BATCH = 32;

// === Background task alias registry ===
// Provides human-readable aliases for background tasks (both Agent and Bash).
// Scoped per parent narrator — aliases are unique within a narrator's session.
// Maps: narratorId → Map<alias, realId> and realId → alias (bidirectional).

interface AliasRegistry {
	aliasToId: Map<string, string>;
	idToAlias: Map<string, string>;
}

let _aliasRegistries: Map<string, AliasRegistry> | undefined;
function getAliasRegistryMap() {
	if (!_aliasRegistries) _aliasRegistries = new Map();
	return _aliasRegistries;
}

const subagentAliasRegistrationLock = new AsyncMutex();

async function loadAliasDb() {
	const [{ db }, schema] = await Promise.all([import("../db"), import("../db/schema")]);
	return { db, backgroundTasks: schema.backgroundTasks, narrators: schema.narrators };
}

function getOrCreateRegistry(narratorId: string): AliasRegistry {
	const map = getAliasRegistryMap();
	let reg = map.get(narratorId);
	if (!reg) {
		reg = { aliasToId: new Map(), idToAlias: new Map() };
		map.set(narratorId, reg);
	}
	return reg;
}

function setRegistryAlias(reg: AliasRegistry, realId: string, alias: string): void {
	const existing = reg.idToAlias.get(realId);
	if (existing && existing !== alias) reg.aliasToId.delete(existing);
	reg.aliasToId.set(alias, realId);
	reg.idToAlias.set(realId, alias);
}

/**
 * Highest `-N` suffix tried before giving up on a readable alias.
 *
 * Reaching this means hundreds of same-named agents under one parent, which no
 * real workflow produces. The bound exists so a pathological `isTaken` (one that
 * answers true for everything) cannot spin the main thread forever; callers get a
 * still-unique, still-resolvable id-based alias instead of a hang.
 */
const MAX_ALIAS_SUFFIX = 1000;

function uniqueAliasFrom(base: string, isTaken: (alias: string) => boolean, fallbackSeed: string) {
	let alias = base;
	let suffix = 2;
	while (isTaken(alias)) {
		if (suffix > MAX_ALIAS_SUFFIX) {
			// Fall back to something unique by construction rather than keep counting.
			// The seed is the real narrator id, so the result stays a valid selector.
			return { alias: `${base}-${shortAgentId(fallbackSeed)}`, conflicted: true };
		}
		alias = `${base}-${suffix}`;
		suffix++;
	}
	return { alias, conflicted: alias !== base };
}

/** Slugify a string for use as an alias. */
export const SUBAGENT_ALIAS_TRAIT_PREFIX = "subagent-alias:";

/**
 * How much of a narrator id to keep when no readable name is available.
 *
 * Defined here rather than in `subagent-label` because the alias fallback below
 * needs it and this is the lower-level module (`subagent-label` imports from
 * here, so the dependency cannot go the other way).
 */
const SHORT_ID_CHARS = 8;

/**
 * A short, still-resolvable stand-in for a narrator id.
 *
 * A prefix is deliberate: `subagentMatchesSelector` accepts `id.startsWith(...)`,
 * so this remains a valid Await/Send selector. The previous fallback slugified the
 * WHOLE id, which both leaked 21 opaque characters into the prompt and — being
 * lowercased — no longer matched the id it came from.
 */
export function shortAgentId(subagentId: string): string {
	return subagentId.slice(0, SHORT_ID_CHARS);
}

/**
 * Base name for an alias: the caller's desired name when it is a real name, else
 * a short id. `desiredAlias` is often defaulted to the narrator id by callers
 * (recovery does `title || subagentId`), so an id passed here is treated as "no
 * name given" rather than slugified into prompt-visible gibberish.
 */
function aliasBaseFor(subagentId: string, desiredAlias?: string): string {
	if (desiredAlias && desiredAlias !== subagentId) {
		const slug = slugifyTaskAlias(desiredAlias);
		if (slug) return slug;
	}
	return shortAgentId(subagentId) || "task";
}

export function slugifyTaskAlias(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
}

/** Column value for `narrators.title_slug`. Empty slug is stored as null. */
export function storedTitleSlug(title: string | null | undefined): string | null {
	if (!title) return null;
	return slugifyTaskAlias(title) || null;
}

function getPersistedAliasTraits(traits: unknown): string[] {
	return Array.isArray(traits)
		? traits.filter(
				(trait): trait is string =>
					typeof trait === "string" && trait.startsWith(SUBAGENT_ALIAS_TRAIT_PREFIX),
			)
		: [];
}

export function getPersistedSubagentAliases(traits: unknown): string[] {
	return getPersistedAliasTraits(traits)
		.map((trait) => trait.slice(SUBAGENT_ALIAS_TRAIT_PREFIX.length))
		.filter(Boolean);
}

export interface SubagentSelectorCandidate {
	id: string;
	title?: string | null;
	traits?: unknown;
}

/**
 * Match user-facing subagent selectors consistently across execution and
 * permission preflight paths. Supports real IDs, ID prefixes, exact titles,
 * slugified titles, and aliases persisted in narrator traits.
 */
export function subagentMatchesSelector(
	candidate: SubagentSelectorCandidate,
	selector: string,
): boolean {
	const normalized = selector.trim();
	if (!normalized) return false;
	const titleAlias = candidate.title ? slugifyTaskAlias(candidate.title) : "";
	return (
		candidate.id === normalized ||
		candidate.id.startsWith(normalized) ||
		candidate.title === normalized ||
		titleAlias === normalized ||
		getPersistedSubagentAliases(candidate.traits).includes(normalized)
	);
}

export async function persistSubagentAlias(
	parentNarratorId: string,
	subagentId: string,
	alias: string,
	options: AliasReadOptions = {},
	expected?: { alias: string | undefined },
): Promise<void> {
	const { db, narrators, backgroundTasks } = await loadAliasDb();
	await narratorTraitsLock.acquire(subagentId, async () => {
		const query = () =>
			db.query.narrators.findMany({
				limit: 1,
				where: eq(narrators.id, subagentId),
				columns: { parentNarratorId: true, traits: true },
			});
		const row = await readQueryFirst(query(), {
			...options,
			executionPolicy: "worker-required",
			maxRows: 1,
		});
		if (!row || row.parentNarratorId !== parentNarratorId) return;

		const currentTraits = Array.isArray(row.traits)
			? row.traits.filter((trait): trait is string => typeof trait === "string")
			: [];
		const nextTraits = [
			...currentTraits.filter((trait) => !trait.startsWith(SUBAGENT_ALIAS_TRAIT_PREFIX)),
			`${SUBAGENT_ALIAS_TRAIT_PREFIX}${alias}`,
		];
		db.transaction((tx) => {
			const current = tx
				.select({
					parentNarratorId: narrators.parentNarratorId,
					traits: narrators.traits,
					title: narrators.title,
				})
				.from(narrators)
				.where(eq(narrators.id, subagentId))
				.get();
			if (
				!current ||
				current.parentNarratorId !== row.parentNarratorId ||
				JSON.stringify(current.traits) !== JSON.stringify(row.traits)
			)
				throw new RuntimeReadConflictError();
			if (
				aliasTakenInTransaction(tx, narrators, backgroundTasks, parentNarratorId, subagentId, alias)
			)
				throw new RuntimeReadConflictError();
			if (expected) {
				let currentAlias: string | undefined = getPersistedSubagentAliases(current.traits)[0];
				if (!currentAlias) {
					const task = tx
						.select({
							type: backgroundTasks.type,
							parentNarratorId: backgroundTasks.parentNarratorId,
							subagentNarratorId: backgroundTasks.subagentNarratorId,
							alias: backgroundTasks.alias,
						})
						.from(backgroundTasks)
						.where(eq(backgroundTasks.id, subagentId))
						.limit(1)
						.get();
					if (
						task?.type === "agent" &&
						task.parentNarratorId === parentNarratorId &&
						(task.subagentNarratorId ?? subagentId) === subagentId
					)
						currentAlias = task.alias || undefined;
				}
				if (currentAlias !== expected.alias) throw new RuntimeReadConflictError();
			}
			const updatedAt = new Date().toISOString();
			tx.update(narrators)
				.set({
					traits: nextTraits,
					aliasSelector: alias,
					titleSlug: storedTitleSlug(current.title),
					updatedAt,
				})
				.where(eq(narrators.id, subagentId))
				.run();
			// The name printed at restore is the narrator alias. TeamStatus get_task
			// looks up the owned agent task by that same string, so the task row
			// changes in this write.
			tx.update(backgroundTasks)
				.set({ alias, updatedAt })
				.where(
					and(
						eq(backgroundTasks.parentNarratorId, parentNarratorId),
						eq(backgroundTasks.type, "agent"),
						or(
							eq(backgroundTasks.subagentNarratorId, subagentId),
							eq(backgroundTasks.id, subagentId),
						),
					),
				)
				.run();
		});
	});
}

/** Recover the original selector after turn cleanup or a server restart. */
async function getExistingSubagentAlias(
	parentNarratorId: string,
	subagentId: string,
	options: AliasReadOptions = {},
): Promise<string | undefined> {
	const { db, backgroundTasks, narrators } = await loadAliasDb();
	const row = await readQueryFirst(
		db.query.narrators.findMany({
			limit: 1,
			where: eq(narrators.id, subagentId),
			columns: { parentNarratorId: true, traits: true },
		}),
		{ ...options, executionPolicy: "worker-required", maxRows: 1 },
	);
	if (!row || row.parentNarratorId !== parentNarratorId) return;
	const persisted = getPersistedSubagentAliases(row.traits)[0];
	if (persisted) return persisted;

	// Agent task rows share their subagent's id. Keep this a bounded PK lookup,
	// and do not adopt an alias from a different task type or team.
	const task = await readQueryFirst(
		db.query.backgroundTasks.findMany({
			limit: 1,
			where: eq(backgroundTasks.id, subagentId),
			columns: { type: true, parentNarratorId: true, subagentNarratorId: true, alias: true },
		}),
		{ ...options, executionPolicy: "worker-required", maxRows: 1 },
	);
	if (
		task?.type === "agent" &&
		task.parentNarratorId === parentNarratorId &&
		(task.subagentNarratorId ?? subagentId) === subagentId
	) {
		return task.alias || undefined;
	}
}

interface AliasTaskRow {
	id: string;
	alias: string | null;
	status: string;
	type: string;
	subagentNarratorId: string | null;
}

interface AddressableNarratorRow {
	id: string;
	parentNarratorId: string | null;
	status: string;
	runtimeRegistrationJson: unknown;
}

function candidateBatch(
	base: string,
	from: number,
	count: number,
): { aliases: string[]; next: number } {
	const aliases: string[] = [];
	let suffix = from;
	while (aliases.length < count && suffix <= MAX_ALIAS_SUFFIX) {
		aliases.push(suffix === 1 ? base : `${base}-${suffix}`);
		suffix = suffix === 1 ? 2 : suffix + 1;
	}
	return { aliases, next: suffix };
}

function taskOwnerId(
	task: Pick<AliasTaskRow, "id" | "type" | "subagentNarratorId">,
): string | null {
	if (task.subagentNarratorId) return task.subagentNarratorId;
	if (task.type === "agent") return task.id;
	return null;
}

function narratorRowIsAddressable(row: AddressableNarratorRow, parentNarratorId: string): boolean {
	return (
		row.parentNarratorId === parentNarratorId &&
		(ADDRESSABLE_NARRATOR_STATUSES as readonly string[]).includes(row.status) &&
		isTeamMember(row, parentNarratorId)
	);
}

/**
 * A task alias is still selectable when the task itself is in progress, or when
 * the agent it names is still an addressable member of this parent. A finished
 * task of an archived narrator is not.
 */
function taskRowIsAddressable(
	task: AliasTaskRow,
	owner: AddressableNarratorRow | undefined,
	parentNarratorId: string,
): boolean {
	if ((LIVE_TASK_STATUSES as readonly string[]).includes(task.status)) return true;
	return owner ? narratorRowIsAddressable(owner, parentNarratorId) : false;
}

function excludeTask(task: AliasTaskRow, excludeSubagentId: string): boolean {
	return task.id === excludeSubagentId || task.subagentNarratorId === excludeSubagentId;
}

type AliasTables = Awaited<ReturnType<typeof loadAliasDb>>;

function aliasTakenInTransaction(
	tx: Parameters<Parameters<AliasTables["db"]["transaction"]>[0]>[0],
	narrators: AliasTables["narrators"],
	backgroundTasks: AliasTables["backgroundTasks"],
	parentNarratorId: string,
	excludeSubagentId: string,
	alias: string,
): boolean {
	const scope = and(
		addressableTeamMembersWhere(parentNarratorId),
		ne(narrators.id, excludeSubagentId),
	);
	const narratorHit = (
		column: typeof narrators.id | typeof narrators.titleSlug | typeof narrators.aliasSelector,
	) =>
		tx
			.select({ id: narrators.id })
			.from(narrators)
			.where(and(scope, eq(column, alias)))
			.limit(1)
			.get();
	if (
		narratorHit(narrators.id) ||
		narratorHit(narrators.titleSlug) ||
		narratorHit(narrators.aliasSelector)
	)
		return true;
	const taskColumns = {
		id: backgroundTasks.id,
		alias: backgroundTasks.alias,
		status: backgroundTasks.status,
		type: backgroundTasks.type,
		subagentNarratorId: backgroundTasks.subagentNarratorId,
	};
	const liveTask = tx
		.select(taskColumns)
		.from(backgroundTasks)
		.where(
			and(
				eq(backgroundTasks.parentNarratorId, parentNarratorId),
				eq(backgroundTasks.alias, alias),
				inArray(backgroundTasks.status, [...LIVE_TASK_STATUSES]),
			),
		)
		.limit(1)
		.get();
	const latestTask = tx
		.select(taskColumns)
		.from(backgroundTasks)
		.where(
			and(eq(backgroundTasks.parentNarratorId, parentNarratorId), eq(backgroundTasks.alias, alias)),
		)
		.orderBy(desc(backgroundTasks.createdAt))
		.limit(1)
		.get();
	const taskById = tx
		.select(taskColumns)
		.from(backgroundTasks)
		.where(
			and(eq(backgroundTasks.parentNarratorId, parentNarratorId), eq(backgroundTasks.id, alias)),
		)
		.limit(1)
		.get();
	const tasks = [liveTask, latestTask, taskById].filter((task) => task != null);
	const ownersNeeded = tasks
		.filter((task) => !excludeTask(task, excludeSubagentId))
		.map((task) => taskOwnerId(task))
		.filter((id): id is string => !!id);
	const owners = new Map<string, AddressableNarratorRow>();
	if (ownersNeeded.length > 0) {
		for (const row of tx
			.select({
				id: narrators.id,
				parentNarratorId: narrators.parentNarratorId,
				status: narrators.status,
				runtimeRegistrationJson: narrators.runtimeRegistrationJson,
			})
			.from(narrators)
			.where(inArray(narrators.id, ownersNeeded))
			.all())
			owners.set(row.id, row);
	}
	return tasks.some((task) => {
		if (excludeTask(task, excludeSubagentId)) return false;
		const ownerId = taskOwnerId(task);
		return taskRowIsAddressable(task, ownerId ? owners.get(ownerId) : undefined, parentNarratorId);
	});
}

async function takenAmongCandidates(
	parentNarratorId: string,
	excludeSubagentId: string,
	candidates: readonly string[],
	options: AliasReadOptions,
): Promise<Set<string>> {
	const taken = new Set<string>();
	if (candidates.length === 0) return taken;
	const wanted = new Set(candidates);
	const { db, backgroundTasks, narrators } = await loadAliasDb();
	const scope = and(
		addressableTeamMembersWhere(parentNarratorId),
		ne(narrators.id, excludeSubagentId),
	);
	const readOptions = {
		...options,
		executionPolicy: "worker-required" as const,
		maxRows: Math.max(candidates.length, 1),
	};
	// Distinct values, not rows. Many addressable members can share one title slug;
	// a row limit of `candidates.length` would hide another candidate those duplicates
	// pushed past the limit.
	const selectorValues = (
		column: typeof narrators.id | typeof narrators.titleSlug | typeof narrators.aliasSelector,
	) =>
		readQuery(
			db
				.selectDistinct({ value: column })
				.from(narrators)
				.where(and(scope, inArray(column, [...candidates])))
				.limit(candidates.length),
			readOptions,
		);
	const notThisOwner = and(
		ne(backgroundTasks.id, excludeSubagentId),
		or(
			isNull(backgroundTasks.subagentNarratorId),
			ne(backgroundTasks.subagentNarratorId, excludeSubagentId),
		),
	);
	const taskColumns = {
		id: backgroundTasks.id,
		alias: backgroundTasks.alias,
		status: backgroundTasks.status,
		type: backgroundTasks.type,
		subagentNarratorId: backgroundTasks.subagentNarratorId,
	};
	const [ids, slugs, aliases, liveTasks, tasksById, latestTasks] = await Promise.all([
		selectorValues(narrators.id),
		selectorValues(narrators.titleSlug),
		selectorValues(narrators.aliasSelector),
		readQuery(
			db
				.selectDistinct({ alias: backgroundTasks.alias })
				.from(backgroundTasks)
				.where(
					and(
						eq(backgroundTasks.parentNarratorId, parentNarratorId),
						inArray(backgroundTasks.alias, [...candidates]),
						inArray(backgroundTasks.status, [...LIVE_TASK_STATUSES]),
						notThisOwner,
					),
				)
				.limit(candidates.length),
			readOptions,
		),
		readQuery(
			db
				.select(taskColumns)
				.from(backgroundTasks)
				.where(
					and(
						eq(backgroundTasks.parentNarratorId, parentNarratorId),
						inArray(backgroundTasks.id, [...candidates]),
						notThisOwner,
					),
				)
				.limit(candidates.length),
			readOptions,
		),
		Promise.all(
			candidates.map((candidate) =>
				readQueryFirst(
					db
						.select(taskColumns)
						.from(backgroundTasks)
						.where(
							and(
								eq(backgroundTasks.parentNarratorId, parentNarratorId),
								eq(backgroundTasks.alias, candidate),
								notThisOwner,
							),
						)
						.orderBy(desc(backgroundTasks.createdAt))
						.limit(1),
					{ ...readOptions, maxRows: 1 },
				),
			),
		),
	]);
	for (const row of [...ids, ...slugs, ...aliases]) {
		if (row.value && wanted.has(row.value)) taken.add(row.value);
	}
	for (const row of liveTasks) {
		if (row.alias && wanted.has(row.alias)) taken.add(row.alias);
	}
	const tasks = new Map<string, AliasTaskRow>();
	for (const task of [...tasksById, ...latestTasks]) {
		if (task) tasks.set(task.id, task);
	}
	const ownerIds = [
		...new Set(
			[...tasks.values()]
				.filter(
					(task) =>
						!excludeTask(task, excludeSubagentId) &&
						!(LIVE_TASK_STATUSES as readonly string[]).includes(task.status),
				)
				.map((task) => taskOwnerId(task))
				.filter((id): id is string => !!id),
		),
	];
	const owners = new Map<string, AddressableNarratorRow>();
	if (ownerIds.length > 0) {
		const rows = await readQuery(
			db
				.select({
					id: narrators.id,
					parentNarratorId: narrators.parentNarratorId,
					status: narrators.status,
					runtimeRegistrationJson: narrators.runtimeRegistrationJson,
				})
				.from(narrators)
				.where(inArray(narrators.id, ownerIds))
				.limit(ownerIds.length),
			{ ...readOptions, maxRows: ownerIds.length },
		);
		for (const row of rows) owners.set(row.id, row);
	}
	for (const task of tasks.values()) {
		if (excludeTask(task, excludeSubagentId)) continue;
		const ownerId = taskOwnerId(task);
		if (!taskRowIsAddressable(task, ownerId ? owners.get(ownerId) : undefined, parentNarratorId))
			continue;
		if (task.alias && wanted.has(task.alias)) taken.add(task.alias);
		if (wanted.has(task.id)) taken.add(task.id);
	}
	return taken;
}

/**
 * Which of `base`, `base-2`, `base-3`, … are already taken by an addressable
 * member of this parent. Stops at the first free candidate so a long archived
 * history is never loaded. The returned set contains only the taken prefix.
 */
async function getPersistedTakenAliases(
	parentNarratorId: string,
	excludeSubagentId: string,
	options: AliasReadOptions = {},
	base?: string,
	alsoTaken?: (alias: string) => boolean,
): Promise<Set<string>> {
	if (!base) return new Set();
	const taken = new Set<string>();
	let suffix = 1;
	while (suffix <= MAX_ALIAS_SUFFIX) {
		const batch = candidateBatch(base, suffix, suffix === 1 ? 1 : ALIAS_CANDIDATE_BATCH);
		if (batch.aliases.length === 0) break;
		suffix = batch.next;
		const hit = await takenAmongCandidates(
			parentNarratorId,
			excludeSubagentId,
			batch.aliases,
			options,
		);
		let foundFree = false;
		for (const alias of batch.aliases) {
			const occupied = hit.has(alias) || (alsoTaken?.(alias) ?? false);
			if (occupied) taken.add(alias);
			else {
				foundFree = true;
				break;
			}
		}
		if (foundFree) return taken;
	}
	return taken;
}

/**
 * Narrators under this parent whose stored id, alias or title slug equals
 * `selector`. Each lookup is an equality (or an id prefix) so it does not scan
 * the parent's history.
 *
 * `membership` is applied before the row limit. Filtering after the limit lets
 * live title matches fill the window and hide an archived sibling.
 */
export async function findSubagentIdsBySelector(
	parentNarratorId: string,
	selector: string,
	options: AliasReadOptions & { membership?: "archived" | "addressable" } = {},
): Promise<string[]> {
	const normalized = selector.trim();
	if (!normalized) return [];
	const { membership, ...read } = options;
	const { db, narrators } = await loadAliasDb();
	const scope = teamMembersWhere(parentNarratorId);
	const statusWhere =
		membership === "archived"
			? eq(narrators.status, "archived")
			: membership === "addressable"
				? inArray(narrators.status, [...ADDRESSABLE_NARRATOR_STATUSES])
				: undefined;
	const readOptions = { ...read, executionPolicy: "worker-required" as const, maxRows: 5 };
	const ids = new Set<string>();
	const collect = async (query: Parameters<typeof readQuery>[0]) => {
		const rows = (await readQuery(query, readOptions)) as { id: string }[];
		for (const row of rows) ids.add(row.id);
	};
	const newest = [desc(narrators.createdAt), desc(narrators.id)] as const;
	await collect(
		db
			.select({ id: narrators.id })
			.from(narrators)
			.where(
				and(
					eq(narrators.parentNarratorId, parentNarratorId),
					eq(narrators.id, normalized),
					statusWhere,
				),
			)
			.orderBy(...newest)
			.limit(1),
	);
	await collect(
		db
			.select({ id: narrators.id })
			.from(narrators)
			.where(and(scope, eq(narrators.aliasSelector, normalized), statusWhere))
			.orderBy(...newest)
			.limit(5),
	);
	await collect(
		db
			.select({ id: narrators.id })
			.from(narrators)
			.where(and(scope, eq(narrators.titleSlug, normalized), statusWhere))
			.orderBy(...newest)
			.limit(5),
	);
	await collect(
		db
			.select({ id: narrators.id })
			.from(narrators)
			.where(and(scope, eq(narrators.title, normalized), statusWhere))
			.orderBy(...newest)
			.limit(5),
	);
	const like = escapeLikeNeedle(normalized);
	if (like && normalized.length >= 2 && normalized.length < 21) {
		await collect(
			db
				.select({ id: narrators.id })
				.from(narrators)
				.where(and(scope, sql`${narrators.id} LIKE ${`${like}%`} ESCAPE '\\'`, statusWhere))
				.orderBy(...newest)
				.limit(5),
		);
	}
	return [...ids];
}

export interface SubagentAliasPersistenceAdapter {
	getExistingAlias(
		parentNarratorId: string,
		subagentId: string,
		options?: AliasReadOptions,
	): Promise<string | undefined>;
	getTakenAliases(
		parentNarratorId: string,
		excludeSubagentId: string,
		options?: AliasReadOptions,
		base?: string,
		alsoTaken?: (alias: string) => boolean,
	): Promise<Set<string>>;
	persistAlias(
		parentNarratorId: string,
		subagentId: string,
		alias: string,
		options?: AliasReadOptions,
		expected?: { alias: string | undefined },
	): Promise<void>;
}

const defaultSubagentAliasPersistenceAdapter: SubagentAliasPersistenceAdapter = {
	getExistingAlias: getExistingSubagentAlias,
	getTakenAliases: getPersistedTakenAliases,
	persistAlias: persistSubagentAlias,
};

let subagentAliasPersistenceAdapter = defaultSubagentAliasPersistenceAdapter;

export function setSubagentAliasPersistenceAdapterForTests(
	adapter?: SubagentAliasPersistenceAdapter,
): void {
	subagentAliasPersistenceAdapter = adapter ?? defaultSubagentAliasPersistenceAdapter;
}

/**
 * Register and persist a subagent alias. Unlike the in-memory registry, this
 * checks already-persisted sibling aliases/title aliases so aliases remain
 * resolvable after the parent narrator session ends or the server restarts.
 */
export async function registerAndPersistSubagentAlias(
	parentNarratorId: string,
	subagentId: string,
	desiredAlias?: string,
	options: AliasReadOptions = {},
): Promise<{ alias: string; conflicted: boolean }> {
	return subagentAliasRegistrationLock.acquire(parentNarratorId, async () => {
		const reg = getOrCreateRegistry(parentNarratorId);
		// Recovery passes the (mutable) title, not necessarily the alias originally
		// printed in Agent/Send results. Never overwrite that selector just because
		// the parent turn's cleanup cleared the in-memory registry.
		const persistedExisting = await subagentAliasPersistenceAdapter.getExistingAlias(
			parentNarratorId,
			subagentId,
			options,
		);
		const existing = persistedExisting || reg.idToAlias.get(subagentId);
		const base = existing || aliasBaseFor(subagentId, desiredAlias);
		const persistedTaken = await subagentAliasPersistenceAdapter.getTakenAliases(
			parentNarratorId,
			subagentId,
			options,
			base,
			(candidate) => {
				const memoryOwner = reg.aliasToId.get(candidate);
				return memoryOwner !== undefined && memoryOwner !== subagentId;
			},
		);
		const isTaken = (candidate: string) => {
			const memoryOwner = reg.aliasToId.get(candidate);
			return (
				persistedTaken.has(candidate) || (memoryOwner !== undefined && memoryOwner !== subagentId)
			);
		};
		const { alias, conflicted } =
			existing && !isTaken(existing)
				? { alias: existing, conflicted: false }
				: uniqueAliasFrom(base, isTaken, subagentId);

		await subagentAliasPersistenceAdapter.persistAlias(
			parentNarratorId,
			subagentId,
			alias,
			options,
			{ alias: persistedExisting },
		);
		setRegistryAlias(reg, subagentId, alias);
		return { alias, conflicted: conflicted || alias !== base };
	});
}

/**
 * After an archived subagent becomes addressable again, give it a free alias
 * when a sibling already holds the one it had. The live owner keeps that name.
 *
 * Membership is the team grant, not `parentNarratorId`: a primary session fork
 * also stores a parent and must not gain a subagent alias.
 */
export async function reconcileRestoredSubagentAlias(narratorId: string): Promise<void> {
	const { db, narrators } = await loadAliasDb();
	const row = await readQueryFirst(
		db
			.select({
				id: narrators.id,
				parentNarratorId: narrators.parentNarratorId,
				status: narrators.status,
				runtimeRegistrationJson: narrators.runtimeRegistrationJson,
			})
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.limit(1),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
	if (!row?.parentNarratorId) return;
	if (!isTeamMember(row, row.parentNarratorId)) return;
	if (!(ADDRESSABLE_NARRATOR_STATUSES as readonly string[]).includes(row.status)) return;
	await registerAndPersistSubagentAlias(row.parentNarratorId, narratorId);
}

/**
 * Register a background task alias. If the desired alias is taken,
 * appends an incrementing suffix (-2, -3, ...).
 * Returns the final unique alias and whether a conflict occurred.
 */
export function registerTaskAlias(
	narratorId: string,
	realId: string,
	desiredAlias?: string,
): { alias: string; conflicted: boolean } {
	const reg = getOrCreateRegistry(narratorId);

	// Already registered
	const existing = reg.idToAlias.get(realId);
	if (existing) return { alias: existing, conflicted: false };

	const base = aliasBaseFor(realId, desiredAlias);
	const { alias, conflicted } = uniqueAliasFrom(
		base,
		(candidate) => reg.aliasToId.has(candidate),
		realId,
	);
	setRegistryAlias(reg, realId, alias);
	return { alias, conflicted };
}

/**
 * Re-register a task's persisted alias exactly, as it was printed to the session.
 *
 * Unlike {@link registerTaskAlias}, the alias is not treated as a title: slugifying
 * would truncate a long alias and could drop its `-2` suffix, handing this task
 * another task's handle. Only if another id already holds the alias in this process
 * is a suffixed variant minted, so a handle never resolves to the wrong task.
 */
export function restoreTaskAlias(
	narratorId: string,
	realId: string,
	alias: string,
): { alias: string; conflicted: boolean } {
	const reg = getOrCreateRegistry(narratorId);
	const existing = reg.idToAlias.get(realId);
	if (existing) return { alias: existing, conflicted: existing !== alias };
	const result = uniqueAliasFrom(alias, (candidate) => reg.aliasToId.has(candidate), realId);
	setRegistryAlias(reg, realId, result.alias);
	return result;
}

/**
 * Resolve an alias or real ID to the actual task/subagent ID.
 * Checks alias registry first, then returns the input as-is (assumed to be a real ID).
 */
export function resolveTaskAlias(narratorId: string, aliasOrId: string): string {
	const reg = getAliasRegistryMap().get(narratorId);
	if (!reg) return aliasOrId;
	return reg.aliasToId.get(aliasOrId) ?? aliasOrId;
}

/** Get the alias for a real ID (if registered). */
export function getTaskAlias(narratorId: string, realId: string): string | undefined {
	return getAliasRegistryMap().get(narratorId)?.idToAlias.get(realId);
}

/**
 * Remove ONE task alias registration.
 *
 * For a caller whose task creation failed AFTER it minted the alias (the row it
 * names will never exist). Registering again for the same id would return the
 * stale alias, so the entry has to go: the next attempt re-mints from the base
 * name (a `-2` suffix only if the freed name is somehow retaken first).
 */
export function unregisterTaskAlias(narratorId: string, realId: string): void {
	const reg = getAliasRegistryMap().get(narratorId);
	if (!reg) return;
	const alias = reg.idToAlias.get(realId);
	if (!alias) return;
	reg.idToAlias.delete(realId);
	reg.aliasToId.delete(alias);
}

/** Clean up alias registry for a narrator. */
export function clearAliasRegistry(narratorId: string): void {
	getAliasRegistryMap().delete(narratorId);
}
