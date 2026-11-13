/**
 * Sessions with real Dynamic Spec state for the import's tests: everything is written through
 * `spec-vfs-service`, so revisions, locks and `created_by` are what production leaves behind.
 */
import { db } from "../../../../db";
import { narrators, userPreferences, users } from "../../../../db/schema";
import { generateId } from "../../../../lib/id";
import { writeSpecFile } from "../../../spec-vfs-service";
import { OUTLINE_TASKS_PAGE_ALIAS } from "../../model";
import { outlineStore } from "../../store";

export const NOW = "2026-11-10T00:00:00.000Z";

export async function makeUser(language?: "en" | "zh-CN"): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `si${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	if (language)
		await db
			.insert(userPreferences)
			.values({ id: generateId(), userId: id, language, createdAt: NOW, updatedAt: NOW });
	return id;
}

export async function makeSession(
	options: {
		owner?: string | null;
		backend?: "spec" | "outline";
		archived?: boolean;
		type?: "primary" | "subagent";
		root?: string;
	} = {},
): Promise<{ id: string; owner: string | null }> {
	const owner = options.owner === undefined ? await makeUser() : options.owner;
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: options.type ?? "primary",
		variant: options.type === "subagent" ? "general" : "primary",
		traits: ["standalone"],
		status: options.archived ? "archived" : "idle",
		cwd: "/tmp",
		taskBackend: options.backend ?? "spec",
		ownerUserId: owner,
		visibility: "private",
		...(options.root ? { aclRootNarratorId: options.root, parentNarratorId: options.root } : {}),
		createdAt: NOW,
		updatedAt: NOW,
	});
	return { id, owner };
}

export interface FixtureTask {
	text: string;
	status?: "todo" | "doing" | "done" | "blocked";
	protected?: true;
}

/** Write tasks.json as `by` (the Spec panel and `/goal` write as the user; the agent as itself). */
export async function writeTasks(
	narratorId: string,
	tasks: readonly FixtureTask[],
	by: "user" | "assistant" = "assistant",
): Promise<void> {
	await writeSpecFile(narratorId, "spec://tasks.json", JSON.stringify({ tasks }), {
		actor: by === "user" ? "user" : "agent",
		createdBy: by,
		allowProtectedTaskMutation: true,
	});
}

export async function writeNote(narratorId: string, path: string, content: string): Promise<void> {
	await writeSpecFile(narratorId, `spec://${path}`, content, { actor: "user", createdBy: "user" });
}

export interface ImportedTask {
	id: string;
	sid: string;
	text: string;
	status: string | null;
	humanCreated: boolean;
	lockedBy: string | null;
	manager: string | null;
	holder: string | null;
	children: string[];
}

/** The session's task page as it reads now, in order. */
export async function taskPage(narratorId: string): Promise<ImportedTask[]> {
	const space = await outlineStore.findSpace({ kind: "session", narratorId });
	if (!space) return [];
	const [page] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	if (!page) return [];
	const rows = await outlineStore.listChildren(space.id, page.id, 200);
	const claims = new Map(
		(await outlineStore.getTaskClaims(rows.map((row) => row.id))).map((c) => [c.taskBlockId, c]),
	);
	const out: ImportedTask[] = [];
	for (const row of rows) {
		const children = await outlineStore.listChildren(space.id, row.id, 50);
		out.push({
			id: row.id,
			sid: row.sid,
			text: row.content,
			status: row.taskJson?.status ?? null,
			humanCreated: row.taskJson?.humanCreated === true,
			lockedBy: row.taskJson?.lock
				? `${row.taskJson.lock.by.kind}:${row.taskJson.lock.by.id}`
				: null,
			manager: row.taskJson?.manager
				? `${row.taskJson.manager.kind}:${row.taskJson.manager.id}`
				: null,
			holder: claims.get(row.id)?.holderNarratorId ?? null,
			children: children.map((child) => child.content),
		});
	}
	return out;
}

/** The pages of the session space: title and the contents under it (one level). */
export async function pages(
	narratorId: string,
): Promise<Array<{ sid: string; title: string; blocks: string[] }>> {
	const space = await outlineStore.findSpace({ kind: "session", narratorId });
	if (!space) return [];
	const rows = await outlineStore.listChildren(space.id, null, 200);
	const out: Array<{ sid: string; title: string; blocks: string[] }> = [];
	for (const row of rows) {
		const children = await outlineStore.listChildren(space.id, row.id, 500);
		out.push({ sid: row.sid, title: row.content, blocks: children.map((c) => c.content) });
	}
	return out;
}

export async function backendOf(narratorId: string): Promise<string | undefined> {
	const row = await db.query.narrators.findFirst({
		where: (n, { eq }) => eq(n.id, narratorId),
		columns: { taskBackend: true },
	});
	return row?.taskBackend;
}

export async function commitCount(narratorId: string): Promise<number> {
	const space = await outlineStore.findSpace({ kind: "session", narratorId });
	return space ? space.nextSeq - 1 : 0;
}
