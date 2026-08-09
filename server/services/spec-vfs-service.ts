import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
	specFileRevisions,
	specNamespaceFiles,
	specNamespaces,
	specProtectedTasks,
} from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
import { generateId } from "../lib/id";
import { eventBus } from "../lib/event-bus";
import {
	analyzeSpecTasksCandidate,
	compileSpecTasks,
	detectProtectedMutations,
	parseSpecTasksDocument,
	SPEC_TASKS_PATH,
	type SpecTasksDocument,
	serializeSpecTasksDocument,
	taskTextHash,
} from "./spec-task-service";

export const SPEC_URI_PREFIX = "spec://";

const MAX_SPEC_FILE_CHARS = 200_000;
const MAX_SPEC_PATH_CHARS = 240;

const specWriteLock = new AsyncMutex();

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DEFAULT_INDEX = `# Work Spec

This is the root of the narrator's virtual Work Spec directory.

- Task queue: spec://tasks.json
- Behavior fence: spec://behavior_fence

Use additional spec://*.md files for design notes when the task becomes complex.
`;

const DEFAULT_BEHAVIOR_FENCE = "";

/**
 * Built-in spec files. Two independent readonly axes:
 * - `agentReadonly`: the assistant's Write/Edit tools cannot modify the file.
 * - `uiEditable`: the file can be edited by the user through the Spec panel (UI route).
 *
 * `behavior_fence` is agent-readonly (UI-editable) by default: it captures durable
 * behavior constraints the user wants obeyed. The assistant may write it only through
 * a one-shot grant (first tool call of a user turn), passed via `allowFenceMutation`.
 */
const BUILTIN_FILES: Record<
	string,
	{ content: string; agentReadonly: boolean; uiEditable: boolean }
> = {
	behavior_fence: { content: DEFAULT_BEHAVIOR_FENCE, agentReadonly: true, uiEditable: true },
	"index.md": { content: DEFAULT_INDEX, agentReadonly: false, uiEditable: true },
	[SPEC_TASKS_PATH]: {
		content: serializeSpecTasksDocument({ tasks: [] }),
		agentReadonly: false,
		uiEditable: true,
	},
};

export interface SpecResolvedFile {
	path: string;
	uri: string;
	content: string;
	/** True when the assistant's Write/Edit tools cannot modify this file. */
	readonly: boolean;
	/** True when the user may edit this file via the Spec panel (UI route). */
	uiEditable: boolean;
	builtin: boolean;
	revisionId?: string | null;
	namespaceId: string;
}

export interface SpecWriteOptions {
	sourceToolUseId?: string | null;
	sourceMessageId?: string | null;
	createdBy?: "system" | "user" | "assistant";
	allowProtectedTaskMutation?: boolean;
	/**
	 * One-shot grant that lets an `agent` actor write `spec://behavior_fence` despite it
	 * being agent-readonly. Set by Write/Edit tools when the current tool call is the first
	 * of a user turn (see behavior-fence-grant). Ignored for non-fence paths.
	 */
	allowFenceMutation?: boolean;
	/**
	 * Who is performing the write. `"agent"` (default) is subject to `agentReadonly`;
	 * `"user"` (UI route) is subject to `uiEditable`.
	 */
	actor?: "agent" | "user";
}

export interface SpecCandidateAnalysis {
	path: string;
	namespaceId: string;
	protectedMutations: Awaited<ReturnType<typeof analyzeSpecTasksCandidate>>["protectedMutations"];
}

export function isSpecUri(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(SPEC_URI_PREFIX);
}

export function toSpecUri(path: string): string {
	return `${SPEC_URI_PREFIX}${normalizeSpecPath(path)}`;
}

export function normalizeSpecPath(input: string): string {
	let path = input.trim();
	if (path.startsWith(SPEC_URI_PREFIX)) path = path.slice(SPEC_URI_PREFIX.length);
	path = path.replace(/^\/+/, "");
	try {
		path = decodeURIComponent(path);
	} catch {
		// Keep raw path if it is not URI-encoded.
	}
	path = path.replace(/\\/g, "/");
	if (!path) throw new Error("spec:// path must not be empty");
	if (path.length > MAX_SPEC_PATH_CHARS) {
		throw new Error(`spec:// path must be at most ${MAX_SPEC_PATH_CHARS} characters`);
	}
	const parts = path.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error("spec:// path must not contain empty, '.', or '..' segments");
	}
	if (!parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part))) {
		throw new Error("spec:// path segments may only contain letters, numbers, '.', '_', and '-'");
	}
	return parts.join("/");
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function formatProtectedMutationError(
	mutations: Awaited<ReturnType<typeof analyzeSpecTasksCandidate>>["protectedMutations"],
): string {
	const details = mutations
		.map((mutation) => `- ${mutation.kind}: ${mutation.text} (${mutation.details})`)
		.join("\n");
	return `This change affects protected task(s) and requires taskReflection before it can be applied.\n${details}`;
}

function syncProtectedLocksInTransaction(
	tx: DbTransaction,
	namespaceId: string,
	document: SpecTasksDocument,
	revisionId: string,
): void {
	const now = new Date().toISOString();
	const protectedTasksInDoc = document.tasks.filter((task) => task.protected);
	for (const task of protectedTasksInDoc) {
		const hash = taskTextHash(task.text);
		const existing = tx.query.specProtectedTasks
			.findFirst({
				where: and(
					eq(specProtectedTasks.namespaceId, namespaceId),
					eq(specProtectedTasks.textHash, hash),
				),
			})
			.sync();
		if (!existing) {
			tx.insert(specProtectedTasks)
				.values({
					id: generateId(),
					namespaceId,
					textHash: hash,
					text: task.text,
					status: task.status,
					firstRevisionId: revisionId,
					lastRevisionId: revisionId,
					createdAt: now,
					updatedAt: now,
					completedAt: task.status === "done" ? now : null,
				})
				.run();
			continue;
		}
		tx.update(specProtectedTasks)
			.set({
				status: task.status,
				lastRevisionId: revisionId,
				updatedAt: now,
				...(task.status === "done" && !existing.completedAt ? { completedAt: now } : {}),
			})
			.where(eq(specProtectedTasks.id, existing.id))
			.run();
	}

	const hashesInDoc = protectedTasksInDoc.map((task) => taskTextHash(task.text));
	const openLocks = tx.query.specProtectedTasks
		.findMany({
			where: and(
				eq(specProtectedTasks.namespaceId, namespaceId),
				inArray(specProtectedTasks.status, ["todo", "doing", "blocked"]),
			),
		})
		.sync();
	for (const lock of openLocks) {
		if (hashesInDoc.includes(lock.textHash)) continue;
		tx.update(specProtectedTasks)
			.set({
				status: "deleted",
				deletedAt: now,
				updatedAt: now,
				lastRevisionId: revisionId,
			})
			.where(eq(specProtectedTasks.id, lock.id))
			.run();
	}
}

async function getNamespace(narratorId: string) {
	return db.query.specNamespaces.findFirst({ where: eq(specNamespaces.narratorId, narratorId) });
}

export async function ensureNamespace(
	narratorId: string,
): Promise<typeof specNamespaces.$inferSelect> {
	const existing = await getNamespace(narratorId);
	if (existing) return existing;
	const now = new Date().toISOString();
	try {
		const [created] = await db
			.insert(specNamespaces)
			.values({ id: generateId(), narratorId, createdAt: now, updatedAt: now })
			.returning();
		return created;
	} catch (err) {
		const raced = await getNamespace(narratorId);
		if (raced) return raced;
		throw err;
	}
}

async function getCurrentFile(namespaceId: string, path: string) {
	return db.query.specNamespaceFiles.findFirst({
		where: and(eq(specNamespaceFiles.namespaceId, namespaceId), eq(specNamespaceFiles.path, path)),
	});
}

async function getRevision(revisionId: string | null | undefined) {
	if (!revisionId) return null;
	return db.query.specFileRevisions.findFirst({ where: eq(specFileRevisions.id, revisionId) });
}

/** Whether the assistant's Write/Edit tools are blocked for this path. */
function isAgentReadonly(path: string): boolean {
	return BUILTIN_FILES[path]?.agentReadonly ?? false;
}

/** Whether the user may edit this path via the Spec panel. Non-builtin files are always UI-editable. */
function isUiEditable(path: string): boolean {
	const builtin = BUILTIN_FILES[path];
	return builtin ? builtin.uiEditable : true;
}

export async function readSpecFile(narratorId: string, uri: string): Promise<SpecResolvedFile> {
	const path = normalizeSpecPath(uri);
	const namespace = await ensureNamespace(narratorId);
	const current = await getCurrentFile(namespace.id, path);
	if (current?.deleted) throw new Error(`Spec file not found: ${toSpecUri(path)}`);
	const revision = await getRevision(current?.revisionId);
	if (revision) {
		return {
			path,
			uri: toSpecUri(path),
			content: revision.content,
			readonly: isAgentReadonly(path),
			uiEditable: isUiEditable(path),
			builtin: false,
			revisionId: revision.id,
			namespaceId: namespace.id,
		};
	}
	const builtin = BUILTIN_FILES[path];
	if (builtin) {
		return {
			path,
			uri: toSpecUri(path),
			content: builtin.content,
			readonly: builtin.agentReadonly,
			uiEditable: builtin.uiEditable,
			builtin: true,
			revisionId: null,
			namespaceId: namespace.id,
		};
	}
	throw new Error(`Spec file not found: ${toSpecUri(path)}`);
}

export async function analyzeSpecWriteCandidate(
	narratorId: string,
	uri: string,
	content: string,
): Promise<SpecCandidateAnalysis> {
	const path = normalizeSpecPath(uri);
	const namespace = await ensureNamespace(narratorId);
	if (path !== SPEC_TASKS_PATH) return { path, namespaceId: namespace.id, protectedMutations: [] };
	const result = await analyzeSpecTasksCandidate(namespace.id, content);
	return { path, namespaceId: namespace.id, protectedMutations: result.protectedMutations };
}

export async function writeSpecFile(
	narratorId: string,
	uri: string,
	content: string,
	options: SpecWriteOptions = {},
): Promise<SpecResolvedFile> {
	const path = normalizeSpecPath(uri);
	const actor = options.actor ?? "agent";
	const fenceMutationAllowed = path === "behavior_fence" && options.allowFenceMutation === true;
	if (actor === "agent" && isAgentReadonly(path) && !fenceMutationAllowed) {
		if (path === "behavior_fence") {
			throw new Error(
				`${toSpecUri(path)} may only be written on your first tool call of the current user turn, and only when the user explicitly asked you to record a behavior. It is otherwise read-only — propose changes to the user instead of writing directly.`,
			);
		}
		throw new Error(`${toSpecUri(path)} is read-only`);
	}
	if (actor === "user" && !isUiEditable(path)) {
		throw new Error(`${toSpecUri(path)} is not editable`);
	}
	if (content.length > MAX_SPEC_FILE_CHARS) {
		throw new Error(`Spec file content must be at most ${MAX_SPEC_FILE_CHARS} characters`);
	}
	if (path === "index.md" && !content.trim()) {
		throw new Error("spec://index.md must not be empty");
	}
	const namespace = await ensureNamespace(narratorId);
	const tasksDocument = path === SPEC_TASKS_PATH ? parseSpecTasksDocument(content) : null;

	return specWriteLock.acquire(`${namespace.id}:${path}`, async () => {
		db.transaction((tx) => {
			const now = new Date().toISOString();
			const current = tx.query.specNamespaceFiles
				.findFirst({
					where: and(
						eq(specNamespaceFiles.namespaceId, namespace.id),
						eq(specNamespaceFiles.path, path),
					),
				})
				.sync();

			if (tasksDocument) {
				const locks = tx.query.specProtectedTasks
					.findMany({ where: eq(specProtectedTasks.namespaceId, namespace.id) })
					.sync();
				const protectedMutations = detectProtectedMutations(locks, tasksDocument);
				if (protectedMutations.length > 0 && !options.allowProtectedTaskMutation) {
					throw new Error(formatProtectedMutationError(protectedMutations));
				}
			}

			const revisionId = generateId();
			tx.insert(specFileRevisions)
				.values({
					id: revisionId,
					namespaceId: namespace.id,
					path,
					content,
					contentHash: hashContent(content),
					parentRevisionId: current?.revisionId ?? null,
					sourceToolUseId: options.sourceToolUseId ?? null,
					sourceMessageId: options.sourceMessageId ?? null,
					createdBy: options.createdBy ?? "assistant",
					createdAt: now,
				})
				.run();

			if (current) {
				tx.update(specNamespaceFiles)
					.set({ revisionId, deleted: false, updatedAt: now })
					.where(eq(specNamespaceFiles.id, current.id))
					.run();
			} else {
				tx.insert(specNamespaceFiles)
					.values({
						id: generateId(),
						namespaceId: namespace.id,
						path,
						revisionId,
						deleted: false,
						updatedAt: now,
					})
					.run();
			}

			tx.update(specNamespaces)
				.set({ updatedAt: now })
				.where(eq(specNamespaces.id, namespace.id))
				.run();

			if (tasksDocument) {
				syncProtectedLocksInTransaction(tx, namespace.id, tasksDocument, revisionId);
			}
		});

		const written = await readSpecFile(narratorId, toSpecUri(path));
		eventBus.emit({
			type: "spec:changed",
			narratorId,
			path,
			uri: toSpecUri(path),
			revisionId: written.revisionId ?? null,
			updatedBy: actor,
		});
		return written;
	});
}

export async function deleteSpecFile(narratorId: string, uri: string): Promise<void> {
	const path = normalizeSpecPath(uri);
	// Built-in files are never deletable: they would reappear in listSpecFiles,
	// so deletion has no lasting effect and only causes confusion.
	if (BUILTIN_FILES[path])
		throw new Error(`${toSpecUri(path)} is a built-in file and cannot be deleted`);
	const namespace = await ensureNamespace(narratorId);
	const current = await getCurrentFile(namespace.id, path);
	if (!current) return;
	await db
		.update(specNamespaceFiles)
		.set({ deleted: true, updatedAt: new Date().toISOString() })
		.where(eq(specNamespaceFiles.id, current.id));
}

export async function listSpecFiles(narratorId: string): Promise<SpecResolvedFile[]> {
	const namespace = await ensureNamespace(narratorId);
	const rows = await db.query.specNamespaceFiles.findMany({
		where: and(
			eq(specNamespaceFiles.namespaceId, namespace.id),
			eq(specNamespaceFiles.deleted, false),
		),
	});
	const files: SpecResolvedFile[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const revision = await getRevision(row.revisionId);
		if (!revision) continue;
		seen.add(row.path);
		files.push({
			path: row.path,
			uri: toSpecUri(row.path),
			content: revision.content,
			readonly: isAgentReadonly(row.path),
			uiEditable: isUiEditable(row.path),
			builtin: false,
			revisionId: revision.id,
			namespaceId: namespace.id,
		});
	}
	for (const [path, builtin] of Object.entries(BUILTIN_FILES)) {
		if (seen.has(path)) continue;
		files.push({
			path,
			uri: toSpecUri(path),
			content: builtin.content,
			readonly: builtin.agentReadonly,
			uiEditable: builtin.uiEditable,
			builtin: true,
			revisionId: null,
			namespaceId: namespace.id,
		});
	}
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function forkSpecNamespace(
	parentNarratorId: string,
	childNarratorId: string,
): Promise<void> {
	const parent = await ensureNamespace(parentNarratorId);
	const existingChild = await getNamespace(childNarratorId);
	if (existingChild) return;
	const now = new Date().toISOString();
	const childNamespaceId = generateId();
	await db.insert(specNamespaces).values({
		id: childNamespaceId,
		narratorId: childNarratorId,
		forkedFromNamespaceId: parent.id,
		createdAt: now,
		updatedAt: now,
	});
	const parentFiles = await db.query.specNamespaceFiles.findMany({
		where: and(
			eq(specNamespaceFiles.namespaceId, parent.id),
			eq(specNamespaceFiles.deleted, false),
		),
	});
	if (parentFiles.length > 0) {
		await db.insert(specNamespaceFiles).values(
			parentFiles.map((file) => ({
				id: generateId(),
				namespaceId: childNamespaceId,
				path: file.path,
				revisionId: file.revisionId,
				deleted: false,
				updatedAt: now,
			})),
		);
	}
	const parentProtectedTasks = await db.query.specProtectedTasks.findMany({
		where: eq(specProtectedTasks.namespaceId, parent.id),
	});
	if (parentProtectedTasks.length > 0) {
		await db.insert(specProtectedTasks).values(
			parentProtectedTasks.map((task) => ({
				id: generateId(),
				namespaceId: childNamespaceId,
				textHash: task.textHash,
				text: task.text,
				status: task.status,
				firstRevisionId: task.firstRevisionId,
				lastRevisionId: task.lastRevisionId,
				createdAt: now,
				updatedAt: now,
				completedAt: task.completedAt,
				deletedAt: task.deletedAt,
			})),
		);
	}
}

export async function readTasksFileForNarrator(narratorId: string): Promise<SpecResolvedFile> {
	return readSpecFile(narratorId, toSpecUri(SPEC_TASKS_PATH));
}

/**
 * Append a protected task to spec://tasks.json (used by the /goal command).
 * Idempotent: if a task with the same trimmed text already exists, it is left
 * untouched and no new task is added. Written as the user, so the protected-task
 * lock is created without requiring taskReflection.
 */
export async function appendProtectedSpecTask(
	narratorId: string,
	objective: string,
): Promise<{ added: boolean; written: SpecResolvedFile }> {
	const text = objective.trim();
	if (!text) throw new Error("objective must not be empty");
	const current = await readTasksFileForNarrator(narratorId);
	const document = parseSpecTasksDocument(current.content);
	const existing = document.tasks.find((task) => task.text.trim() === text);
	if (existing) {
		// A task with this text already exists — leave it as-is, don't duplicate.
		return { added: false, written: current };
	}
	const nextDocument: SpecTasksDocument = {
		tasks: [...document.tasks, { text, status: "todo", protected: true }],
	};
	const written = await writeSpecFile(
		narratorId,
		toSpecUri(SPEC_TASKS_PATH),
		serializeSpecTasksDocument(nextDocument),
		{ actor: "user", createdBy: "user", allowProtectedTaskMutation: true },
	);
	return { added: true, written };
}

export interface SpecTasksSummary {
	/** Total number of tasks currently in tasks.json. */
	total: number;
	/** Number of open tasks (todo / doing / blocked). */
	open: number;
	/** Number of open protected tasks. */
	protectedOpen: number;
}

/**
 * Summarize the narrator's tasks.json without loading full task text into the
 * caller. Used by fork carryover to decide whether to surface the reset card.
 */
export async function summarizeSpecTasks(narratorId: string): Promise<SpecTasksSummary> {
	const file = await readTasksFileForNarrator(narratorId);
	const document = parseSpecTasksDocument(file.content);
	const compiled = compileSpecTasks(document);
	const open = compiled.tasks.filter(
		(task) => task.status === "doing" || task.status === "todo" || task.status === "blocked",
	).length;
	return {
		total: compiled.tasks.length,
		open,
		protectedOpen: compiled.protectedOpenCount,
	};
}

/**
 * Empty the narrator's tasks.json (reset to `{ "tasks": [] }`). Written as the
 * user with protected-task mutation allowed, so protected locks are released
 * (marked deleted) without requiring taskReflection. Only affects this
 * narrator's own namespace — a forked child has an independent namespace, so
 * clearing the child never touches the parent.
 */
export async function clearSpecTasks(narratorId: string): Promise<SpecResolvedFile> {
	return writeSpecFile(
		narratorId,
		toSpecUri(SPEC_TASKS_PATH),
		serializeSpecTasksDocument({ tasks: [] }),
		{ actor: "user", createdBy: "user", allowProtectedTaskMutation: true },
	);
}

/**
 * Reset the narrator's entire Dynamic Spec namespace to its initial state:
 * every tracked file is dropped (so built-in files fall back to their defaults
 * and custom *.md notes disappear) and all open protected-task locks are
 * marked deleted. Operates only on this narrator's namespace, so resetting a
 * forked child never affects the parent.
 */
export async function resetSpecNamespace(narratorId: string): Promise<void> {
	const namespace = await ensureNamespace(narratorId);
	const now = new Date().toISOString();
	db.transaction((tx) => {
		// Drop all tracked files. Built-in paths (index.md / tasks.json /
		// behavior_fence) revert to their BUILTIN_FILES defaults because
		// readSpecFile falls back when there is no namespace-file row; custom
		// *.md notes simply cease to exist.
		tx.delete(specNamespaceFiles).where(eq(specNamespaceFiles.namespaceId, namespace.id)).run();

		// Release every open protected-task lock so a future tasks.json write is
		// not blocked by a stale commitment from before the reset.
		tx.update(specProtectedTasks)
			.set({ status: "deleted", deletedAt: now, updatedAt: now })
			.where(
				and(
					eq(specProtectedTasks.namespaceId, namespace.id),
					inArray(specProtectedTasks.status, ["todo", "doing", "blocked"]),
				),
			)
			.run();

		tx.update(specNamespaces)
			.set({ updatedAt: now })
			.where(eq(specNamespaces.id, namespace.id))
			.run();
	});
}

export const specVfsService = {
	isSpecUri,
	toSpecUri,
	normalizeSpecPath,
	ensureNamespace,
	readSpecFile,
	writeSpecFile,
	deleteSpecFile,
	listSpecFiles,
	analyzeSpecWriteCandidate,
	forkSpecNamespace,
	readTasksFileForNarrator,
	appendProtectedSpecTask,
	summarizeSpecTasks,
	clearSpecTasks,
	resetSpecNamespace,
};
