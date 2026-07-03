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
import {
	analyzeSpecTasksCandidate,
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

const HOW_TO_USE_SPEC = `# HOW TO USE SPEC

You can use spec:// files with Read, Write, Edit and Grep.

Core files:

- spec://index.md — overview and free-form planning notes.
- spec://tasks.json — the minimal task queue used for task reminders and continuation.
- spec://protected_requirements — read-only user intent and supervision principles.
- spec://HOW_TO_USE_SPEC.md — this help file.

The public tasks.json format is intentionally small:

\`\`\`json
{
	"tasks": [
		{ "text": "Do the current thing", "status": "doing" },
		{ "text": "Do not bypass this requirement", "status": "todo", "protected": true }
	]
}
\`\`\`

Allowed task statuses: todo, doing, done, blocked.
Only task fields text/status/protected are allowed. Do not add summary, ids, timestamps, evidence, or runtime metadata to tasks.json.

Protected tasks may be created by the assistant, but after creation their content is locked. Completing or deleting a protected task requires taskReflection.
`;

const DEFAULT_INDEX = `# Work Spec

This is the root of the narrator's virtual Work Spec directory.

- Task queue: spec://tasks.json
- Protected requirements: spec://protected_requirements
- Usage guide: spec://HOW_TO_USE_SPEC.md

Use additional spec://*.md files for design notes when the task becomes complex.
`;

const DEFAULT_PROTECTED_REQUIREMENTS = `# Protected Requirements

No protected requirements have been set for this narrator yet.

This file is read-only for the assistant. User- or system-provided supervision principles can be stored here in a future UI/API layer.
`;

const BUILTIN_FILES: Record<string, { content: string; readonly: boolean }> = {
	"HOW_TO_USE_SPEC.md": { content: HOW_TO_USE_SPEC, readonly: true },
	protected_requirements: { content: DEFAULT_PROTECTED_REQUIREMENTS, readonly: true },
	"index.md": { content: DEFAULT_INDEX, readonly: false },
	[SPEC_TASKS_PATH]: { content: serializeSpecTasksDocument({ tasks: [] }), readonly: false },
};

export interface SpecResolvedFile {
	path: string;
	uri: string;
	content: string;
	readonly: boolean;
	builtin: boolean;
	revisionId?: string | null;
	namespaceId: string;
}

export interface SpecWriteOptions {
	sourceToolUseId?: string | null;
	sourceMessageId?: string | null;
	createdBy?: "system" | "user" | "assistant";
	allowProtectedTaskMutation?: boolean;
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
			readonly: BUILTIN_FILES[path]?.readonly ?? false,
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
			readonly: builtin.readonly,
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
	if (BUILTIN_FILES[path]?.readonly) {
		throw new Error(`${toSpecUri(path)} is read-only`);
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

		return readSpecFile(narratorId, toSpecUri(path));
	});
}

export async function deleteSpecFile(narratorId: string, uri: string): Promise<void> {
	const path = normalizeSpecPath(uri);
	if (BUILTIN_FILES[path]?.readonly) throw new Error(`${toSpecUri(path)} is read-only`);
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
			readonly: BUILTIN_FILES[row.path]?.readonly ?? false,
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
			readonly: builtin.readonly,
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
};
