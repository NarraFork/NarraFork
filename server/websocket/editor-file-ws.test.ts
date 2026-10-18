import { expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import { revokeUserSessions } from "../lib/auth";
import { generateId } from "../lib/id";
import { editorActorForSubject } from "../routes/editor-documents";
import { getEditorDocumentService } from "../services/editor-document-runtime";
import { editorFileSubscriptions } from "../services/editor-file-subscription";
import { handleEditorFileMessage, releaseEditorFileSubscriptions } from "./editor-file-ws";

const settle = async (predicate: () => boolean) => {
	const end = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("Subscription did not settle");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

test.each([
	"token",
	"cwd",
	"root",
	"owner",
	"deleted-user",
	"backpressure",
] as const)("real file-authorized Host subscription revokes %s without path/body leakage or late frames", async (mutation) => {
	const root = await mkdtemp(join(testEnvironment.isolatedHome, "editor-watch-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	await writeFile(join(workspace, "ignored.txt"), "private file body");
	const userId = generateId(),
		narratorId = generateId(),
		now = new Date().toISOString();
	db.insert(users)
		.values({ id: userId, username: userId, passwordHash: "fixture", role: "user", createdAt: now })
		.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			ownerUserId: userId,
			visibility: "private",
			cwd: workspace,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const service = getEditorDocumentService(),
		frames: Record<string, unknown>[] = [];
	let buffered = 0;
	const ws = {
		data: {
			userId,
			lastPongAt: Date.now(),
			sessionExp: Date.now() / 1000 + 60,
			sessionTokenVersion: 0,
		},
		send: (frame: string) => {
			frames.push(JSON.parse(frame));
		},
		getBufferedAmount: () => buffered,
		close: mock(() => {}),
	};
	try {
		const actor = editorActorForSubject({
			userId,
			narratorId,
			auth: {
				type: "session",
				user: { sub: userId, role: "user", iat: Date.now() / 1000, exp: ws.data.sessionExp, sv: 0 },
			},
		});
		const doc = await service.create(actor, {
			path: "ignored.txt",
			origin: "legacy",
			deviceId: "local",
		});
		await handleEditorFileMessage(ws, {
			type: "editor_file_subscribe",
			subscriptionId: "opaque",
			narratorId,
			docId: doc.docId,
		});
		await settle(() => frames.length === 1);
		expect(frames[0].type).toBe("editor_file_subscribed");
		// Watching is independent of document lifetime; it must not pin/touch hidden docs.
		await service.remove(actor, doc.docId);
		if (mutation === "token") {
			await revokeUserSessions(userId);
			await expect(
				actor.authorize({ path: "ignored.txt", origin: "legacy" }, "read"),
			).rejects.toThrow("expired");
		} else if (mutation === "cwd")
			db.update(narrators).set({ cwd: root }).where(eq(narrators.id, narratorId)).run();
		else if (mutation === "root") {
			await rename(workspace, join(root, "retired"));
			await mkdir(workspace);
		} else if (mutation === "owner")
			db.update(narrators)
				.set({ ownerUserId: null, visibility: "private" })
				.where(eq(narrators.id, narratorId))
				.run();
		else if (mutation === "deleted-user") db.delete(users).where(eq(users.id, userId)).run();
		else buffered = 256 * 1024 + 1;
		editorFileSubscriptions.hint(narratorId);
		await settle(() =>
			mutation === "backpressure" ? ws.close.mock.calls.length === 1 : frames.length === 2,
		);
		if (mutation !== "backpressure")
			expect(frames[1]).toEqual({
				type: "editor_file_error",
				subscriptionId: "opaque",
				code: "access_denied",
			});
		else expect(ws.close).toHaveBeenCalledWith(1013, "Editor backpressure; reconnect");
		editorFileSubscriptions.hint();
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(frames).toHaveLength(mutation === "backpressure" ? 1 : 2);
		expect(JSON.stringify(frames)).not.toContain(workspace);
		expect(JSON.stringify(frames)).not.toContain("private file body");
		expect(editorFileSubscriptions.diagnostics.resources).toBe(0);
	} finally {
		releaseEditorFileSubscriptions(ws);
		db.delete(narrators).where(eq(narrators.id, narratorId)).run();
		db.delete(users).where(eq(users.id, userId)).run();
		await rm(root, { recursive: true, force: true });
	}
});
