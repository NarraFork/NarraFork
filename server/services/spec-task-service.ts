import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { specProtectedTasks } from "../db/schema";
import { generateId } from "../lib/id";

export const SPEC_TASKS_PATH = "tasks.json";

export type SpecTaskStatus = "todo" | "doing" | "done" | "blocked";

export interface SpecTaskItem {
	text: string;
	status: SpecTaskStatus;
	protected?: true;
}

export interface SpecTasksDocument {
	tasks: SpecTaskItem[];
}

export interface LegacyTodoLike {
	content?: unknown;
	text?: unknown;
	status?: unknown;
}

export interface CompiledSpecTasks {
	tasks: SpecTaskItem[];
	currentTask: SpecTaskItem | null;
	nextTask: SpecTaskItem | null;
	blocked: boolean;
	complete: boolean;
	protectedOpenCount: number;
}

export interface ProtectedTaskMutation {
	kind: "modify" | "delete" | "complete";
	text: string;
	fromStatus?: SpecTaskStatus | "deleted";
	toStatus?: SpecTaskStatus | "deleted";
	details: string;
}

export interface SpecTaskValidationResult {
	document: SpecTasksDocument;
	compiled: CompiledSpecTasks;
	protectedMutations: ProtectedTaskMutation[];
}

const TASK_TEXT_MAX_CHARS = 1000;
const TASKS_MAX_ITEMS = 100;

export function taskTextHash(text: string): string {
	return createHash("sha256").update(text.trim()).digest("hex");
}

function normalizeTaskStatus(value: unknown): SpecTaskStatus {
	if (value === "pending") return "todo";
	if (value === "in_progress" || value === "active") return "doing";
	if (value === "completed" || value === "complete") return "done";
	if (value === "todo" || value === "doing" || value === "done" || value === "blocked") {
		return value;
	}
	throw new Error(`Invalid task status: ${String(value)}`);
}

function legacyTodoToSpecTask(raw: LegacyTodoLike, index: number): SpecTaskItem {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`todos[${index}] must be an object`);
	}
	const textSource = typeof raw.content === "string" ? raw.content : raw.text;
	if (typeof textSource !== "string" || !textSource.trim()) {
		throw new Error(`todos[${index}].content must be a non-empty string`);
	}
	const text = textSource.trim();
	if ([...text].length > TASK_TEXT_MAX_CHARS) {
		throw new Error(`todos[${index}].content must be at most ${TASK_TEXT_MAX_CHARS} characters`);
	}
	return { text, status: normalizeTaskStatus(raw.status ?? "todo") };
}

export function buildSpecTasksDocumentFromLegacyTodos(
	todos: LegacyTodoLike[],
	existingDocument: SpecTasksDocument = { tasks: [] },
): SpecTasksDocument {
	const protectedTasks = existingDocument.tasks.filter((task) => task.protected);
	const protectedByHash = new Map(
		protectedTasks.map((task) => [taskTextHash(task.text), task] as const),
	);
	const protectedStatusOverrides = new Map<string, SpecTaskStatus>();
	const replacementTasks: SpecTaskItem[] = [];

	for (const [index, todo] of todos.entries()) {
		const task = legacyTodoToSpecTask(todo, index);
		const hash = taskTextHash(task.text);
		if (protectedByHash.has(hash)) {
			protectedStatusOverrides.set(hash, task.status);
			continue;
		}
		replacementTasks.push(task);
	}

	const preservedProtectedTasks = protectedTasks.map((task) => {
		const overrideStatus = protectedStatusOverrides.get(taskTextHash(task.text));
		return overrideStatus ? { ...task, status: overrideStatus, protected: true as const } : task;
	});

	return { tasks: [...preservedProtectedTasks, ...replacementTasks] };
}

function parseTask(raw: unknown, index: number): SpecTaskItem {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`tasks[${index}] must be an object`);
	}
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["text", "status", "protected"]);
	const extraKeys = Object.keys(obj).filter((key) => !allowed.has(key));
	if (extraKeys.length > 0) {
		throw new Error(
			`tasks[${index}] contains unsupported field(s): ${extraKeys.join(", ")}. ` +
				"Only text/status/protected are allowed.",
		);
	}
	if (typeof obj.text !== "string" || !obj.text.trim()) {
		throw new Error(`tasks[${index}].text must be a non-empty string`);
	}
	const text = obj.text.trim();
	if ([...text].length > TASK_TEXT_MAX_CHARS) {
		throw new Error(`tasks[${index}].text must be at most ${TASK_TEXT_MAX_CHARS} characters`);
	}
	const status = normalizeTaskStatus(obj.status ?? "todo");
	const task: SpecTaskItem = { text, status };
	if (obj.protected === true) task.protected = true;
	else if (obj.protected !== undefined && obj.protected !== false) {
		throw new Error(`tasks[${index}].protected must be true or omitted`);
	}
	return task;
}

export function parseSpecTasksDocument(content: string): SpecTasksDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		throw new Error(
			`tasks.json must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("tasks.json must be an object with a tasks array");
	}
	const obj = parsed as Record<string, unknown>;
	const allowed = new Set(["tasks"]);
	const extraKeys = Object.keys(obj).filter((key) => !allowed.has(key));
	if (extraKeys.length > 0) {
		throw new Error(
			`tasks.json contains unsupported top-level field(s): ${extraKeys.join(", ")}. ` +
				"Only tasks is allowed.",
		);
	}
	if (!Array.isArray(obj.tasks)) throw new Error("tasks.json must contain a tasks array");
	if (obj.tasks.length > TASKS_MAX_ITEMS) {
		throw new Error(`tasks.json may contain at most ${TASKS_MAX_ITEMS} tasks`);
	}
	return { tasks: obj.tasks.map(parseTask) };
}

export function serializeSpecTasksDocument(document: SpecTasksDocument): string {
	return `${JSON.stringify(document, null, "\t")}\n`;
}

export function compileSpecTasks(document: SpecTasksDocument): CompiledSpecTasks {
	const currentTask = document.tasks.find((task) => task.status === "doing") ?? null;
	const nextTask = document.tasks.find((task) => task.status === "todo") ?? null;
	return {
		tasks: document.tasks,
		currentTask,
		nextTask,
		blocked: document.tasks.some((task) => task.status === "blocked"),
		complete: !document.tasks.some(
			(task) => task.status === "doing" || task.status === "todo" || task.status === "blocked",
		),
		protectedOpenCount: document.tasks.filter(
			(task) =>
				task.protected &&
				(task.status === "doing" || task.status === "todo" || task.status === "blocked"),
		).length,
	};
}

async function listProtectedLocks(namespaceId: string) {
	return db.query.specProtectedTasks.findMany({
		where: eq(specProtectedTasks.namespaceId, namespaceId),
	});
}

export function detectProtectedMutations(
	locks: Array<typeof specProtectedTasks.$inferSelect>,
	document: SpecTasksDocument,
): ProtectedTaskMutation[] {
	const byHash = new Map(document.tasks.map((task) => [taskTextHash(task.text), task]));
	const protectedNewHashes = new Set(
		document.tasks.filter((task) => task.protected).map((task) => taskTextHash(task.text)),
	);
	const mutations: ProtectedTaskMutation[] = [];
	for (const lock of locks) {
		if (lock.status === "done" || lock.status === "deleted") continue;
		const current = byHash.get(lock.textHash);
		if (!current) {
			mutations.push({
				kind: "delete",
				text: lock.text,
				fromStatus: lock.status as SpecTaskStatus,
				toStatus: "deleted",
				details: "Protected task was removed from tasks.json.",
			});
			continue;
		}
		if (!current.protected) {
			mutations.push({
				kind: "modify",
				text: lock.text,
				fromStatus: lock.status as SpecTaskStatus,
				toStatus: current.status,
				details: "Protected task had its protected flag removed.",
			});
		}
		if (current.status === "done") {
			mutations.push({
				kind: "complete",
				text: lock.text,
				fromStatus: lock.status as SpecTaskStatus,
				toStatus: "done",
				details: "Protected task was marked done.",
			});
		}
	}

	// If a protected lock disappeared but a different protected task appeared, flag this as a likely
	// content rewrite rather than silently accepting a delete+create that weakens the commitment.
	const activeLockHashes = new Set(
		locks
			.filter((lock) => lock.status !== "done" && lock.status !== "deleted")
			.map((lock) => lock.textHash),
	);
	for (const hash of protectedNewHashes) {
		if (!activeLockHashes.has(hash)) continue;
	}
	return mutations;
}

async function syncProtectedLocks(
	namespaceId: string,
	document: SpecTasksDocument,
	revisionId?: string | null,
): Promise<void> {
	const now = new Date().toISOString();
	const protectedTasksInDoc = document.tasks.filter((task) => task.protected);
	for (const task of protectedTasksInDoc) {
		const hash = taskTextHash(task.text);
		const existing = await db.query.specProtectedTasks.findFirst({
			where: and(
				eq(specProtectedTasks.namespaceId, namespaceId),
				eq(specProtectedTasks.textHash, hash),
			),
		});
		if (!existing) {
			await db.insert(specProtectedTasks).values({
				id: generateId(),
				namespaceId,
				textHash: hash,
				text: task.text,
				status: task.status,
				firstRevisionId: revisionId ?? null,
				lastRevisionId: revisionId ?? null,
				createdAt: now,
				updatedAt: now,
				completedAt: task.status === "done" ? now : null,
			});
			continue;
		}
		await db
			.update(specProtectedTasks)
			.set({
				status: task.status,
				lastRevisionId: revisionId ?? existing.lastRevisionId,
				updatedAt: now,
				...(task.status === "done" && !existing.completedAt ? { completedAt: now } : {}),
			})
			.where(eq(specProtectedTasks.id, existing.id));
	}

	const hashesInDoc = protectedTasksInDoc.map((task) => taskTextHash(task.text));
	const openLocks = await db.query.specProtectedTasks.findMany({
		where: and(
			eq(specProtectedTasks.namespaceId, namespaceId),
			inArray(specProtectedTasks.status, ["todo", "doing", "blocked"]),
		),
	});
	for (const lock of openLocks) {
		if (hashesInDoc.includes(lock.textHash)) continue;
		await db
			.update(specProtectedTasks)
			.set({
				status: "deleted",
				deletedAt: now,
				updatedAt: now,
				lastRevisionId: revisionId ?? lock.lastRevisionId,
			})
			.where(eq(specProtectedTasks.id, lock.id));
	}
}

export async function validateSpecTasksWrite(
	namespaceId: string,
	content: string,
	options: { allowProtectedMutations?: boolean; revisionId?: string | null } = {},
): Promise<SpecTaskValidationResult> {
	const document = parseSpecTasksDocument(content);
	const compiled = compileSpecTasks(document);
	const locks = await listProtectedLocks(namespaceId);
	const protectedMutations = detectProtectedMutations(locks, document);
	if (protectedMutations.length > 0 && !options.allowProtectedMutations) {
		const details = protectedMutations
			.map((mutation) => `- ${mutation.kind}: ${mutation.text} (${mutation.details})`)
			.join("\n");
		throw new Error(
			`This change affects protected task(s) and requires taskReflection before it can be applied.\n${details}`,
		);
	}
	await syncProtectedLocks(namespaceId, document, options.revisionId ?? null);
	return { document, compiled, protectedMutations };
}

export async function analyzeSpecTasksCandidate(
	namespaceId: string,
	content: string,
): Promise<SpecTaskValidationResult> {
	const document = parseSpecTasksDocument(content);
	const compiled = compileSpecTasks(document);
	const locks = await listProtectedLocks(namespaceId);
	return { document, compiled, protectedMutations: detectProtectedMutations(locks, document) };
}

export async function compileTasksForNamespace(
	namespaceId: string,
	content: string,
): Promise<CompiledSpecTasks> {
	const document = parseSpecTasksDocument(content);
	await syncProtectedLocks(namespaceId, document, null);
	return compileSpecTasks(document);
}

export const specTaskService = {
	parseSpecTasksDocument,
	serializeSpecTasksDocument,
	compileSpecTasks,
	buildSpecTasksDocumentFromLegacyTodos,
	validateSpecTasksWrite,
	analyzeSpecTasksCandidate,
	compileTasksForNamespace,
	detectProtectedMutations,
	taskTextHash,
};
