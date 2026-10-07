import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceContext } from "@shared/workspace-context";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { terminals, users } from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { resolveTerminalWorkspaceActivityScope } from "./terminal-workspace-activity-scope";

let root: string;
let userId: string;
let terminalId: string;
let context: WorkspaceContext;
beforeEach(async () => {
	root = await mkdtemp(join(await realpath(tmpdir()), "terminal-origin-scope-"));
	userId = crypto.randomUUID();
	terminalId = crypto.randomUUID();
	const now = new Date().toISOString();
	db.insert(users)
		.values({
			id: userId,
			username: userId,
			passwordHash: "isolated-test-not-secret",
			createdAt: now,
		})
		.run();
	context = {
		revision: 3,
		contextKey: `terminal:${terminalId}`,
		deviceId: "local",
		cwd: root,
		pathFlavor: "posix",
		capabilities: { switchDirectory: true },
	};
	db.insert(terminals)
		.values({
			id: terminalId,
			name: "Actual standalone terminal",
			ownerUserId: userId,
			cwd: root,
			status: "exited",
			exitCode: null,
			workspaceRevision: context.revision,
			workspaceContext: {
				...context,
				terminalOrigin: { version: 1, runtimeGeneration: localBackend.runtimeGeneration },
			} as WorkspaceContext,
			createdAt: now,
		})
		.run();
});
afterEach(async () => {
	db.delete(terminals).where(eq(terminals.id, terminalId)).run();
	db.delete(users).where(eq(users.id, userId)).run();
	await rm(root, { recursive: true, force: true });
});
function request() {
	return {
		principal: { userId, isAdmin: false },
		terminalId,
		workspaceContext: context,
		runtimeGeneration: localBackend.runtimeGeneration,
		signal: AbortSignal.timeout(10_000),
	};
}

test("real pending standalone terminal admits a local activity without a fabricated narrator", async () => {
	const actual = await resolveTerminalWorkspaceActivityScope(request());
	expect(actual.scope.deviceId).toBe("local");
	expect(actual.scope.canonicalRoot).toBe(root);
	const token = actual.coordinator.registerActivity({
		scope: actual.scope,
		runtime: actual.runtime,
	});
	await actual.assertCurrent();
	actual.coordinator.endActivity(token, "finished");
});
test("caller owner, frozen root, context and stored generation are conjunctive", async () => {
	await expect(
		resolveTerminalWorkspaceActivityScope({
			...request(),
			principal: { userId: "other-user", isAdmin: false },
		}),
	).rejects.toThrow();
	await expect(
		resolveTerminalWorkspaceActivityScope({
			...request(),
			workspaceContext: { ...context, cwd: "/other-root" },
		}),
	).rejects.toThrow("prepared metadata");
	db.update(terminals).set({ workspaceContext: context }).where(eq(terminals.id, terminalId)).run();
	await expect(resolveTerminalWorkspaceActivityScope(request())).rejects.toThrow(
		"prepared metadata",
	);
});
test("late owner and role revocation prevent current source admission", async () => {
	const actual = await resolveTerminalWorkspaceActivityScope(request());
	db.update(terminals).set({ ownerUserId: null }).where(eq(terminals.id, terminalId)).run();
	await expect(actual.assertCurrent()).rejects.toThrow("prepared metadata");
	db.update(terminals).set({ ownerUserId: userId }).where(eq(terminals.id, terminalId)).run();
	db.update(users).set({ role: "admin" }).where(eq(users.id, userId)).run();
	await expect(actual.assertCurrent()).rejects.toThrow("role changed");
});
