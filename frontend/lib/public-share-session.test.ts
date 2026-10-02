import { afterEach, describe, expect, it, mock } from "bun:test";
import type { PublicSharedSession } from "@shared/public-narrator-share";
import { type PublicShareClient, PublicShareError } from "./public-share-api";

const authChanges: unknown[] = [];
mock.module("./narrator-ws-manager", () => ({
	setNarratorWSShareAuth: (auth: unknown) => authChanges.push(auth),
}));
const { PublicShareSession } = await import("./public-share-session");
const controllers: InstanceType<typeof PublicShareSession>[] = [];
const card = { narratorId: "narrator", title: "Shared", roomId: "room" } as PublicSharedSession;
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};
function create(session: PublicShareClient["session"]) {
	const controller = new PublicShareSession({ session } as PublicShareClient, "share", "secret");
	controllers.push(controller);
	return controller;
}
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.stop();
	authChanges.length = 0;
});

describe("public share session recovery", () => {
	it("exposes transient errors and retries explicitly to live", async () => {
		let calls = 0;
		const controller = create(async () => {
			if (++calls === 1) throw new PublicShareError(503);
			return card;
		});
		controller.start();
		await flush();
		expect(controller.getSnapshot().phase).toBe("error");
		expect(calls).toBe(1);
		controller.reconnect();
		expect(controller.getSnapshot().phase).toBe("loading");
		await flush();
		expect(controller.getSnapshot().phase).toBe("live");
		expect(authChanges).toEqual([{ shareId: "share", token: "secret" }]);
	});

	it("keeps unavailable permanent and refuses retries", async () => {
		let calls = 0;
		const controller = create(async () => {
			calls++;
			throw new PublicShareError(410);
		});
		controller.start();
		await flush();
		controller.reconnect();
		await flush();
		expect(calls).toBe(1);
		expect(controller.getSnapshot().phase).toBe("unavailable");
		expect(controller.getSnapshot().session).toBeNull();
	});

	it("aborts stop and ignores late success or failure", async () => {
		for (const fail of [false, true]) {
			let signal: AbortSignal | undefined;
			let settle: (() => void) | undefined;
			const controller = create((s) => {
				signal = s;
				return new Promise((resolve, reject) => {
					settle = () => (fail ? reject(new Error("offline")) : resolve(card));
				});
			});
			controller.start();
			controller.stop();
			expect(signal?.aborted).toBe(true);
			settle?.();
			await flush();
			expect(controller.getSnapshot().phase).toBe("loading");
			controller.reconnect();
			expect(authChanges.filter(Boolean)).toEqual([]);
		}
	});

	it("retry aborts the stale request and ignores its late result", async () => {
		let firstSignal: AbortSignal | undefined;
		let resolveFirst: ((card: PublicSharedSession) => void) | undefined;
		let calls = 0;
		const controller = create((signal) => {
			if (++calls > 1) return Promise.resolve(card);
			firstSignal = signal;
			return new Promise((resolve) => {
				resolveFirst = resolve;
			});
		});
		controller.start();
		controller.reconnect();
		expect(firstSignal?.aborted).toBe(true);
		await flush();
		resolveFirst?.({ ...card, title: "stale" });
		await flush();
		expect(controller.getSnapshot().session?.title).toBe("Shared");
		expect(authChanges.filter(Boolean)).toHaveLength(1);
	});
});
