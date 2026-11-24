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
	const begin = holds.begin("n", identity, async () => (claimed ? undefined : 0));
	claiming.release();
	await claim;
	await expect(begin).rejects.toThrow("being edited");
	expect(holds.held("n")).toBe(false);

	const validation = gate();
	const first = holds.begin("n", identity, async () => {
		await validation.promise;
		return 0;
	});
	const followingClaim = holds.exclusive("n", () => !holds.held("n"));
	validation.release();
	await first;
	expect(await followingClaim).toBe(false);
});

test("same-token begin restores a lease expired during its revision read before a queued claim can run", async () => {
	let now = 0;
	const holds = createBufferEditHolds(() => now, 100);
	await holds.begin("n", identity, async () => 7);
	now = 99;
	const reading = gate();
	const resumeRead = gate();
	const begin = holds.begin(
		"n",
		identity,
		async () => {
			reading.release();
			await resumeRead.promise;
			return 7;
		},
		7,
	);
	await reading.promise;
	now = 101;
	holds.expire();
	expect(holds.held("n")).toBe(false);
	const claim = holds.exclusive("n", () => !holds.held("n"));
	resumeRead.release();
	expect(await begin).toMatchObject({ ok: true, contentRevision: 7, expiresAt: 201 });
	expect(holds.held("n")).toBe(true);
	expect(await claim).toBe(false);
	expect((await holds.renew("n", identity, 7)).contentRevision).toBe(7);
});

for (const initiallyHeld of [false, true])
	test(`authorization loss during a ${initiallyHeld ? "same-token" : "new"} begin revision read cannot grant a lease`, async () => {
		const holds = createBufferEditHolds();
		if (initiallyHeld) await holds.begin("n", identity, async () => 7);
		const reading = gate();
		const resumeRead = gate();
		const events: string[] = [];
		const begin = holds.begin(
			"n",
			identity,
			async () => {
				reading.release();
				await resumeRead.promise;
				return 7;
			},
			7,
		);
		await reading.promise;
		const revoked = holds.quiesceForAuthorizationLoss(
			"n",
			() => {
				events.push("stop");
			},
			async () => {
				events.push("clear");
			},
		);
		expect(events).toEqual([]);
		resumeRead.release();
		const outcome = await begin.then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);
		await revoked;
		expect(outcome).toMatchObject({ error: { statusCode: 409, code: "BUFFER_EDIT_CONFLICT" } });
		expect(events).toEqual(["stop", "clear"]);
		expect(holds.held("n")).toBe(false);
	});

test("same token renews idempotently; users and replacement tokens cannot steal or release a hold", async () => {
	let now = 0;
	const holds = createBufferEditHolds(() => now, 100);
	const changes: string[] = [];
	holds.setListener((id) => {
		changes.push(id);
	});
	expect(await holds.begin("n", identity, async () => 0)).toMatchObject({
		token: "token",
		expiresAt: 100,
		leaseMs: 100,
	});
	now = 50;
	expect((await holds.begin("n", identity, async () => 0)).expiresAt).toBe(150);
	await expect(holds.renew("n", { ...identity, userId: "other" })).rejects.toThrow();
	await holds.release("n", { ...identity, userId: "other" });
	expect(holds.held("n")).toBe(true);
	now = 151;
	holds.expire();
	expect(holds.held("n")).toBe(false);
	expect(changes).toEqual(["n", "n"]);
	const replacement = { ...identity, token: "replacement" };
	await holds.begin("n", replacement, async () => 0);
	await holds.release("n", identity);
	expect(holds.held("n")).toBe(true);
	await expect(holds.mutate("n", "message", async () => {}, identity)).rejects.toThrow();
	await holds.release("n", replacement);
	expect(holds.held("n")).toBe(false);
});

test("expired drafts can reacquire only their original revision and cannot overwrite a newer editor", async () => {
	let now = 0;
	let revision = 4;
	let text = "original";
	const holds = createBufferEditHolds(() => now, 100);
	const first = await holds.begin("n", identity, async () => revision);
	expect(first.contentRevision).toBe(4);
	await expect(holds.begin("n", identity, async () => revision, 3)).rejects.toMatchObject({
		code: "BUFFER_EDIT_STALE",
	});
	expect((await holds.renew("n", identity)).contentRevision).toBe(4);
	now = 101;
	holds.expire();
	expect(
		(await holds.begin("n", identity, async () => revision, first.contentRevision)).contentRevision,
	).toBe(4);
	now = 202;
	holds.expire();
	const second = { ...identity, token: "other-editor" };
	await holds.begin("n", second, async () => revision);
	await holds.mutate(
		"n",
		"message",
		async () => {
			holds.assertMutationRevision(revision);
			text = "other editor saved";
			revision++;
		},
		second,
	);
	await holds.release("n", second);
	await expect(
		holds.begin("n", identity, async () => revision, first.contentRevision),
	).rejects.toMatchObject({ statusCode: 409, code: "BUFFER_EDIT_STALE" });
	expect(holds.held("n")).toBe(false);
	await expect(
		holds.mutate(
			"n",
			"message",
			async () => {
				text = "stale draft";
			},
			identity,
		),
	).rejects.toThrow();
	expect(text).toBe("other editor saved");
});

test("leased saves retain their immutable revision baseline, while legacy saves remain compatible", async () => {
	const holds = createBufferEditHolds();
	await holds.begin("n", identity, async () => 7);
	await expect(
		holds.mutate(
			"n",
			"message",
			async () => {
				holds.assertMutationRevision(8);
			},
			identity,
		),
	).rejects.toMatchObject({ statusCode: 409, code: "BUFFER_EDIT_STALE" });
	await expect(holds.begin("n", identity, async () => 8)).rejects.toMatchObject({
		code: "BUFFER_EDIT_STALE",
	});
	expect((await holds.renew("n", identity)).contentRevision).toBe(7);
	await holds.release("n", identity);
	await holds.mutate("n", "message", async () => {
		holds.assertMutationRevision(8);
	});
});

test("slow attachment saves pin TTL; failures retain a full retry window and reject bypass mutations", async () => {
	let now = 0;
	const holds = createBufferEditHolds(() => now, 100);
	await holds.begin("n", identity, async () => 0);
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
	await expect(holds.begin("n", identity, async () => 0)).rejects.toThrow();
	expect(holds.held("n")).toBe(true);
	saving.release();
	await save;
	expect(holds.held("n")).toBe(false);
	expect(changes).toEqual(["n"]);
	await expect(holds.mutate("n", "message", async () => {}, identity)).rejects.toThrow();
});
