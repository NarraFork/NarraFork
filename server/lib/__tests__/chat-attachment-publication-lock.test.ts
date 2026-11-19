import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { testEnvironment } from "../../../tests/preload";
import {
	setChatAttachmentsDirForTests,
	withChatAttachmentPublicationLock,
} from "../chat-attachments";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(() => setChatAttachmentsDirForTests(null));

test("cleanup cannot enter a room while file and row publication are still settling", async () => {
	setChatAttachmentsDirForTests(join(testEnvironment.isolatedHome, "publication-lock"));
	const entered = deferred(),
		release = deferred();
	const order: string[] = [];
	const publication = withChatAttachmentPublicationLock("room", async () => {
		order.push("publication");
		entered.resolve();
		await release.promise;
		order.push("published");
	});
	await entered.promise;
	const cleanup = withChatAttachmentPublicationLock("room", async () => {
		order.push("cleanup");
	});
	try {
		await Promise.resolve();
		expect(order).toEqual(["publication"]);
	} finally {
		release.resolve();
		await Promise.all([publication, cleanup]);
	}
	expect(order).toEqual(["publication", "published", "cleanup"]);
});

test("a running operation retains ownership after request cancellation until it settles", async () => {
	const controller = new AbortController(),
		entered = deferred(),
		release = deferred();
	let reclaimed = false;
	const publication = withChatAttachmentPublicationLock(
		"cancel-room",
		async () => {
			entered.resolve();
			await release.promise;
		},
		{ signal: controller.signal },
	);
	await entered.promise;
	controller.abort();
	const cleanup = withChatAttachmentPublicationLock("cancel-room", async () => {
		reclaimed = true;
	});
	try {
		await Promise.resolve();
		expect(reclaimed).toBe(false);
	} finally {
		release.resolve();
	}
	await Promise.all([publication, cleanup]);
	expect(reclaimed).toBe(true);
});

test("same-directory nested acquisition is rejected and the parent lease is released", async () => {
	await expect(
		withChatAttachmentPublicationLock("nested", () =>
			withChatAttachmentPublicationLock("nested", async () => {}),
		),
	).rejects.toThrow("non-reentrant");
	await expect(withChatAttachmentPublicationLock("nested", async () => "released")).resolves.toBe(
		"released",
	);
});
