/**
 * Host-side cleanup on the project-delete fallback path.
 *
 * The fallback exists for chapters whose `removeForProjectDeletion` threw, so by
 * construction their containers are still running and their ports still allocated. It
 * used to delete their rows directly, which was survivable only because
 * `container_instances.chapter_id` and `port_allocations.chapter_id` were
 * `ON DELETE NO ACTION`: a surviving row made `DELETE FROM chapters` fail loudly, and
 * the project stayed undeletable until someone looked. Those FKs now cascade, so the
 * same code path succeeds quietly and strands a Podman container against a project that
 * no longer exists, holding a port nothing will release.
 *
 * Asserted here rather than left to the cascade because the failure is invisible from
 * the database: every row is gone either way, and only the host knows the difference.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { chapters, containerInstances, portAllocations, projects } from "../../db/schema";
import { generateId } from "../../lib/id";
import { chapterService } from "../../services/chapter-service";
import { containerService } from "../../services/container-service";
import { terminalService } from "../../services/terminal-service";
import { projectRoutes } from "../projects";

// Deleting a project now requires project `manage`. These tests are about what the
// deletion CLEANS UP (containers, terminals, host state), not about who may trigger
// it — project-acl.test.ts owns that — so the request runs as an admin.
const app = new Hono()
	.use("*", async (c, next) => {
		c.set("user", {
			sub: "delete-fallback-admin",
			role: "admin",
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		});
		await next();
	})
	.route("/projects", projectRoutes);

interface Fixture {
	projectId: string;
	chapterId: string;
	port: number;
	containerRowId: string;
}

let fixture: Fixture;
let restore: () => void;

/** A port well above the allocation pool so a real allocation cannot collide with it. */
function testPort(): number {
	return 60000 + Math.floor(Math.random() * 4000);
}

beforeEach(async () => {
	const now = new Date().toISOString();
	fixture = {
		projectId: generateId(),
		chapterId: generateId(),
		port: testPort(),
		containerRowId: generateId(),
	};
	await db.insert(projects).values({
		id: fixture.projectId,
		name: "Project delete fallback",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(chapters).values({
		id: fixture.chapterId,
		projectId: fixture.projectId,
		title: "Chapter whose removal fails",
		branch: `chapter/fallback-${fixture.chapterId.slice(0, 8)}`,
		baseBranch: "main",
		status: "active",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(containerInstances).values({
		id: fixture.containerRowId,
		chapterId: fixture.chapterId,
		serviceName: "app",
		status: "running",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(portAllocations).values({
		port: fixture.port,
		chapterId: fixture.chapterId,
		serviceName: "app",
		allocatedAt: now,
	});
});

afterEach(async () => {
	restore?.();
	await db.delete(portAllocations).where(eq(portAllocations.port, fixture.port));
	await db.delete(containerInstances).where(eq(containerInstances.id, fixture.containerRowId));
	await db.delete(chapters).where(eq(chapters.id, fixture.chapterId));
	await db.delete(projects).where(eq(projects.id, fixture.projectId));
});

/**
 * Force the fallback by making the per-chapter removal fail, and record what the
 * fallback then asks of the host.
 */
function stubFailingRemoval(): {
	containerCalls: string[];
	terminalCalls: string[];
} {
	const containerCalls: string[] = [];
	const terminalCalls: string[] = [];
	const originalRemove = chapterService.removeForProjectDeletion;
	const originalContainers = containerService.removeChapterContainers;
	const originalTerminals = terminalService.cleanupForChapter;

	chapterService.removeForProjectDeletion = async () => {
		throw new Error("simulated worktree removal failure");
	};
	containerService.removeChapterContainers = async (chapterId: string) => {
		containerCalls.push(chapterId);
	};
	terminalService.cleanupForChapter = async (chapterId: string) => {
		terminalCalls.push(chapterId);
	};

	restore = () => {
		chapterService.removeForProjectDeletion = originalRemove;
		containerService.removeChapterContainers = originalContainers;
		terminalService.cleanupForChapter = originalTerminals;
	};
	return { containerCalls, terminalCalls };
}

describe("project delete fallback", () => {
	test("stops containers and terminals for chapters whose removal failed", async () => {
		const { containerCalls, terminalCalls } = stubFailingRemoval();

		const response = await app.request(`/projects/${fixture.projectId}`, { method: "DELETE" });
		expect(response.status).toBe(200);

		// The point of the test: the host was told to release the resources, not just the
		// rows deleted out from under a still-running container.
		expect(containerCalls).toContain(fixture.chapterId);
		expect(terminalCalls).toContain(fixture.chapterId);

		// And the deletion still completed — cleanup is best-effort, never a new way for a
		// project to become undeletable.
		expect(
			await db.query.projects.findFirst({ where: eq(projects.id, fixture.projectId) }),
		).toBeUndefined();
		expect(
			await db.query.chapters.findFirst({ where: eq(chapters.id, fixture.chapterId) }),
		).toBeUndefined();
		expect(
			await db.query.portAllocations.findFirst({ where: eq(portAllocations.port, fixture.port) }),
		).toBeUndefined();
	});

	test("completes the deletion even when host cleanup itself fails", async () => {
		const originalRemove = chapterService.removeForProjectDeletion;
		const originalContainers = containerService.removeChapterContainers;
		chapterService.removeForProjectDeletion = async () => {
			throw new Error("simulated worktree removal failure");
		};
		// A host that refuses to stop must not strand the project as undeletable: the rows
		// are the only thing NarraFork can still guarantee, so they must go.
		containerService.removeChapterContainers = async () => {
			throw new Error("podman is unreachable");
		};
		restore = () => {
			chapterService.removeForProjectDeletion = originalRemove;
			containerService.removeChapterContainers = originalContainers;
		};

		const response = await app.request(`/projects/${fixture.projectId}`, { method: "DELETE" });
		expect(response.status).toBe(200);
		expect(
			await db.query.projects.findFirst({ where: eq(projects.id, fixture.projectId) }),
		).toBeUndefined();
	});
});
