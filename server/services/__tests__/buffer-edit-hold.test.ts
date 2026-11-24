import { expect, test } from "bun:test";
import { createBufferEditHolds } from "../buffer-edit-hold";

const identity = { messageId: "message", userId: "user", token: "token" };
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

test("begin is serialized with the complete async claim/validation section", async () => {
	const holds = createBufferEditHolds();
	const claiming = gate();
	let claimed = false;
	const claim = holds.exclusive("n", async () => {
		await claiming.promise;
		claimed = true;
	});
	const begin = holds.begin("n", identity, async () => !claimed);
	claiming.release();
	await claim;
	await expect(begin).rejects.toThrow("being edited");
	expect(holds.held("n")).toBe(false);

	const validation = gate();
	const first = holds.begin("n", identity, async () => {
		await validation.promise;
		return true;
	});
	const followingClaim = holds.exclusive("n", () => !holds.held("n"));
	validation.release();
	await first;
	expect(await followingClaim).toBe(false);
});

test("same token renews idempotently; users and replacement tokens cannot steal or release a hold", async () => {
	let now = 0;
	const holds = createBufferEditHolds(() => now, 100);
	const changes: string[] = [];
	holds.setListener((id) => {
		changes.push(id);
	});
	expect(await holds.begin("n", identity, async () => true)).toMatchObject({
		token: "token",
		expiresAt: 100,
		leaseMs: 100,
	});
	now = 50;
	expect((await holds.begin("n", identity, async () => false)).expiresAt).toBe(150);
	await expect(holds.renew("n", { ...identity, userId: "other" })).rejects.toThrow();
	await holds.release("n", { ...identity, userId: "other" });
	expect(holds.held("n")).toBe(true);
	now = 151;
	holds.expire();
	expect(holds.held("n")).toBe(false);
	expect(changes).toEqual(["n", "n"]);
	const replacement = { ...identity, token: "replacement" };
	await holds.begin("n", replacement, async () => true);
	await holds.release("n", identity);
	expect(holds.held("n")).toBe(true);
	await expect(holds.mutate("n", "message", async () => {}, identity)).rejects.toThrow();
	await holds.release("n", replacement);
	expect(holds.held("n")).toBe(false);
});

test("slow attachment saves pin TTL; failures retain a full retry window and reject bypass mutations", async () => {
	let now = 0;
	const holds = createBufferEditHolds(() => now, 100);
	await holds.begin("n", identity, async () => true);
	await expect(holds.mutate("n", "message", async () => {})).rejects.toThrow();
	await expect(holds.mutate("n", undefined, async () => {})).rejects.toThrow();
	const uploading = gate();
	const started = gate();
	const save = holds.mutate(
		"n",
		"message",
		async () => {
			started.release();
			await uploading.promise;
			await holds.mutate("n", "message", async () => {});
			throw new Error("disk full");
		},
		identity,
	);
	await started.promise;
	now = 1000;
	holds.expire();
	expect(holds.held("n")).toBe(true);
	await expect(holds.release("n", identity)).rejects.toThrow();
	await expect(holds.mutate("n", "message", async () => {}, identity)).rejects.toThrow();
	uploading.release();
	await expect(save).rejects.toThrow("disk full");
	holds.expire();
	expect(holds.held("n")).toBe(true);
	now = 1101;
	holds.expire();
	expect(holds.held("n")).toBe(false);
});

test("legacy saves block begin/claim only while saving and wake a deferred consumer", async () => {
	const holds = createBufferEditHolds();
	const saving = gate();
	const started = gate();
	const changes: string[] = [];
	holds.setListener((id) => {
		changes.push(id);
	});
	const save = holds.mutate("n", "message", async () => {
		started.release();
		await saving.promise;
	});
	await started.promise;
	await expect(holds.begin("n", identity, async () => true)).rejects.toThrow();
	expect(holds.held("n")).toBe(true);
	saving.release();
	await save;
	expect(holds.held("n")).toBe(false);
	expect(changes).toEqual(["n"]);
	await expect(holds.mutate("n", "message", async () => {}, identity)).rejects.toThrow();
});
