import { afterAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../../db";
import { projects, users } from "../../db/schema";
import { closeReadDatabase } from "../../lib/db-worker/pool";
import { generateId } from "../../lib/id";
import * as projectAcl from "../project-acl";
import { setProjectVisibility } from "../project-membership";

afterAll(() => closeReadDatabase(sqlite.filename));

test("a stale Worker authority pre-read cannot authorize the membership write transaction", async () => {
	const ownerId = generateId(),
		successorId = generateId(),
		projectId = generateId();
	const now = new Date().toISOString();
	for (const id of [ownerId, successorId])
		db.insert(users).values({ id, username: id, passwordHash: "fixture", createdAt: now }).run();
	db.insert(projects)
		.values({
			id: projectId,
			name: projectId,
			ownerUserId: ownerId,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const original = projectAcl.canManageProject;
	let changed = false;
	const authority = spyOn(projectAcl, "canManageProject").mockImplementation(
		async (row, principal) => {
			const allowed = await original(row, principal);
			if (allowed && !changed && row.id === projectId) {
				changed = true;
				db.update(projects)
					.set({ ownerUserId: successorId })
					.where(eq(projects.id, projectId))
					.run();
			}
			return allowed;
		},
	);
	try {
		await expect(
			setProjectVisibility(projectId, "public", { userId: ownerId, isAdmin: false }),
		).rejects.toThrow("Only the project owner");
		expect(
			db
				.select({ visibility: projects.visibility, ownerUserId: projects.ownerUserId })
				.from(projects)
				.where(eq(projects.id, projectId))
				.get(),
		).toEqual({ visibility: "private", ownerUserId: successorId });
	} finally {
		authority.mockRestore();
		db.delete(projects).where(eq(projects.id, projectId)).run();
		for (const id of [ownerId, successorId]) db.delete(users).where(eq(users.id, id)).run();
	}
});
