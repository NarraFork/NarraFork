import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { specFileRevisions, specNamespaceFiles, type specNamespaces } from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { isSpecUri, normalizeSpecPath, SPEC_URI_PREFIX } from "../lib/spec-uri";
import { knowledgeWriteStore } from "./knowledge/store";
import type { SpecProtectedMutation } from "./knowledge/write-store";
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

export { isSpecUri, normalizeSpecPath, SPEC_URI_PREFIX };

const MAX_SPEC_FILE_CHARS = 200_000;

const specWriteLock = new AsyncMutex();

/** The lock-row type the protected-mutation detector declares (the full table row).
 *  The store projects rows to the fields the detector actually reads, so the write
 *  path widens the projection back at exactly one point — see writeSpecFile. */
type TaskLockRows = Parameters<typeof detectProtectedMutations>[0];

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
	actor?: SpecWriteActor;
}

/**
 * Write actors recognised by the spec VFS policy checks.
 *
 * There is deliberately no `"plugin"` member: the policy axis here is "is this write
 * subject to agentReadonly or to uiEditable", and a plugin dispatching work into a
 * narrator's queue is on the agent side of that line. A plugin therefore writes as
 * `"agent"` — it does not get the user's ability to mint protected tasks for free.
 */
export type SpecWriteActor = "agent" | "user";

export interface SpecCandidateAnalysis {
	path: string;
	namespaceId: string;
	protectedMutations: Awaited<ReturnType<typeof analyzeSpecTasksCandidate>>["protectedMutations"];
}

export function toSpecUri(path: string): string {
	return `${SPEC_URI_PREFIX}${normalizeSpecPath(path)}`;
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function formatProtectedMutationError(mutations: readonly SpecProtectedMutation[]): string {
	const details = mutations
		.map((mutation) => `- ${mutation.kind}: ${mutation.text} (${mutation.details})`)
		.join("\n");
	return `This change affects protected task(s) and requires taskReflection before it can be applied.\n${details}`;
}

export async function ensureNamespace(
	narratorId: string,
): Promise<typeof specNamespaces.$inferSelect> {
	// The store owns the get-or-create: a lost create race returns the winner's row
	// (re-read after the conflict), never an error.
	return knowledgeWriteStore.ensureSpecNamespace({
		namespaceId: generateId(),
		narratorId,
		now: new Date().toISOString(),
	});
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
		// The store owns the whole section: revision insert + file pointer switch +
		// namespace touch + protected-lock enforcement. For tasks.json the detector
		// runs INSIDE the section over the locks the section just read; the service
		// keeps ownership of the detection logic (injected, dialect-free) and the
		// error wording.
		const result = await knowledgeWriteStore.writeSpecFileRevision({
			namespaceId: namespace.id,
			path,
			content,
			contentHash: hashContent(content),
			revisionId: generateId(),
			fileIdForCreate: generateId(),
			sourceToolUseId: options.sourceToolUseId ?? null,
			sourceMessageId: options.sourceMessageId ?? null,
			createdBy: options.createdBy ?? "assistant",
			now: new Date().toISOString(),
			...(tasksDocument
				? {
						specTasks: {
							tasks: tasksDocument.tasks.map((task) => ({
								text: task.text,
								status: task.status,
								protected: task.protected === true,
								textHash: taskTextHash(task.text),
							})),
							// The store projects the lock rows to exactly the fields the
							// detector reads (status / textHash / text); the detector's
							// declared parameter is the full table row, so the projection is
							// widened back here — the one cast on this path, and load-bearing:
							// it is why the port never imports the SQLite-bound task service.
							detectProtectedMutations: (locks) =>
								detectProtectedMutations(locks as unknown as TaskLockRows, tasksDocument),
							allowProtectedTaskMutation: options.allowProtectedTaskMutation === true,
						},
					}
				: {}),
		});
		if (!result.ok) {
			throw new Error(formatProtectedMutationError(result.protectedMutations));
		}

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
	await knowledgeWriteStore.markSpecFileDeleted({
		fileId: current.id,
		now: new Date().toISOString(),
	});
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
	// The store owns the whole fork: the existing-child check, the child namespace,
	// the live file pointers and the protected-task locks — one atomic section, so a
	// fork can never materialize half a namespace.
	await knowledgeWriteStore.forkSpecNamespace({
		parentNamespaceId: parent.id,
		childNamespaceId: generateId(),
		childNarratorId,
		now: new Date().toISOString(),
	});
}

export async function readTasksFileForNarrator(narratorId: string): Promise<SpecResolvedFile> {
	return readSpecFile(narratorId, toSpecUri(SPEC_TASKS_PATH));
}

/**
 * Append a task to spec://tasks.json on behalf of an external caller.
 *
 * Idempotent: if a task with the same trimmed text already exists, it is left untouched
 * and no new task is added.
 *
 * `protected` is explicit because the two callers mean different things. The `/goal`
 * command IS the user stating a commitment, so it asks for a protected task. A plugin
 * dispatching work is not the user, so it gets an ordinary task unless it deliberately
 * asks otherwise — a protected task drives auto-continuation and taskReflection and the
 * narrator cannot retract it, which is far too much to hand out by default.
 *
 * The write is attributed to `actor` and needs `allowProtectedTaskMutation` only when it
 * actually creates a protected task; an ordinary append must not carry a privilege it
 * does not need.
 */
export async function appendSpecTaskForExternalActor(
	narratorId: string,
	objective: string,
	options: { protected: boolean; actor: SpecWriteActor },
): Promise<{ added: boolean; protected: boolean; written: SpecResolvedFile }> {
	const text = objective.trim();
	if (!text) throw new Error("objective must not be empty");
	const current = await readTasksFileForNarrator(narratorId);
	const document = parseSpecTasksDocument(current.content);
	const existing = document.tasks.find((task) => task.text.trim() === text);
	if (existing) {
		// A task with this text already exists — leave it as-is, don't duplicate.
		// Report the EXISTING task's protection, not the requested one: nothing changed,
		// so claiming otherwise would misreport the queue's actual state.
		return { added: false, protected: existing.protected === true, written: current };
	}
	const nextDocument: SpecTasksDocument = {
		tasks: [
			...document.tasks,
			{ text, status: "todo", ...(options.protected ? { protected: true } : {}) },
		],
	};
	const written = await writeSpecFile(
		narratorId,
		toSpecUri(SPEC_TASKS_PATH),
		serializeSpecTasksDocument(nextDocument),
		{
			actor: options.actor,
			// `createdBy` is revision authorship and has its own vocabulary: the write actor
			// `"agent"` is recorded as `"assistant"`. They are not interchangeable strings.
			createdBy: options.actor === "user" ? "user" : "assistant",
			...(options.protected ? { allowProtectedTaskMutation: true } : {}),
		},
	);
	return { added: true, protected: options.protected, written };
}

/**
 * Append a protected task as the user (the `/goal` command). The user asking for a goal
 * IS the commitment, so the protected-task lock is created without taskReflection.
 */
export async function appendProtectedSpecTask(
	narratorId: string,
	objective: string,
): Promise<{ added: boolean; written: SpecResolvedFile }> {
	const { added, written } = await appendSpecTaskForExternalActor(narratorId, objective, {
		protected: true,
		actor: "user",
	});
	return { added, written };
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
	// The store owns the reset section: drop all tracked files (built-in paths revert
	// to their defaults because readSpecFile falls back when there is no row), release
	// every open protected-task lock so a future tasks.json write is not blocked by a
	// stale commitment, and touch the namespace.
	await knowledgeWriteStore.resetSpecNamespace({
		namespaceId: namespace.id,
		now: new Date().toISOString(),
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
