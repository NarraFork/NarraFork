import { afterEach, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { legacyProjectMigrations, narrators, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { legacyProjectMigrationService as service } from "../legacy-project-migration";

const userIds: string[] = [];
const narratorIds: string[] = [];
const receipts: string[] = [];
afterEach(async () => {
	for (const id of receipts.splice(0))
		await db.delete(legacyProjectMigrations).where(eq(legacyProjectMigrations.projectId, id));
	if (narratorIds.length) {
		await db
			.update(narrators)
			.set({ parentNarratorId: null, aclRootNarratorId: null })
			.where(inArray(narrators.id, narratorIds));
		await db.delete(narrators).where(inArray(narrators.id, narratorIds.splice(0)));
	}
	for (const id of userIds.splice(0)) await db.delete(users).where(eq(users.id, id));
});
async function fixture() {
	const owner = generateId();
	const other = generateId();
	const now = new Date().toISOString();
	for (const id of [owner, other]) {
		userIds.push(id);
		await db
			.insert(users)
			.values({ id, username: id, passwordHash: "x", role: "user", createdAt: now });
	}
	const primary = generateId();
	const child = generateId();
	const secondary = generateId();
	const hidden = generateId();
	for (const id of [primary, child, secondary, hidden]) {
		narratorIds.push(id);
		await db.insert(narrators).values({
			id,
			ownerUserId: id === hidden ? other : owner,
			visibility: "private",
			writeAudience: "owner",
			type: id === child ? "subagent" : "primary",
			variant: id === secondary ? "background" : "primary",
			parentNarratorId: id === child ? primary : null,
			aclRootNarratorId: id === child ? primary : null,
			createdAt: now,
			updatedAt: now,
		});
	}
	const projectId = generateId();
	const chapterId = generateId();
	const emptyId = generateId();
	receipts.push(projectId);
	await db.insert(legacyProjectMigrations).values({
		projectId,
		projectName: "retired project",
		actorUserId: owner,
		phase: "completed",
		revision: "a".repeat(64),
		narratorIds: [child, secondary, hidden, primary],
		chapterTargets: { [chapterId]: [child, secondary, hidden, primary], [emptyId]: [] },
		createdAt: now,
		updatedAt: now,
	});
	return { owner, other, primary, child, secondary, hidden, projectId, chapterId, emptyId };
}

test("deleted chapter target uses singular frontend contract and prefers the readable primary", async () => {
	const f = await fixture();
	const target = await service.chapterTarget(f.chapterId, { userId: f.owner, isAdmin: false });
	expect(target).toEqual({ projectId: f.projectId, narratorId: f.primary });
});
test("completed receipt restores only targets permitted by current narrator ACL", async () => {
	const f = await fixture();
	const preview = await service.preview(f.projectId, { userId: f.owner, isAdmin: false });
	expect(preview.phase).toBe("completed");
	expect("narratorIds" in preview ? preview.narratorIds : []).toEqual([
		f.child,
		f.secondary,
		f.primary,
	]);
	expect(JSON.stringify(preview)).not.toContain(f.hidden);
	await db.update(narrators).set({ ownerUserId: f.other }).where(eq(narrators.id, f.primary));
	const updated = await service.preview(f.projectId, { userId: f.owner, isAdmin: false });
	expect("narratorIds" in updated ? updated.narratorIds : []).toEqual([f.secondary]);
});
test("empty chapter result and receipt cannot be probed by an unverified caller", async () => {
	const f = await fixture();
	expect(await service.chapterTarget(f.emptyId, { userId: f.owner, isAdmin: false })).toEqual({
		projectId: f.projectId,
		narratorId: null,
	});
	await expect(service.chapterTarget(f.emptyId, { userId: "", isAdmin: false })).rejects.toThrow();
	await expect(service.preview(f.projectId, { userId: f.other, isAdmin: false })).rejects.toThrow();
});
