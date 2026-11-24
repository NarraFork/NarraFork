import { expect, test } from "bun:test";
import { createBufferEditHolds } from "../buffer-edit-hold";
import { readBufferEditLeaseBody, withBufferEditRequestDeadline } from "../buffer-edit-request";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

for (const leased of [false, true])
	test(`slow input is cancelled at an absolute deadline; ${leased ? "leased" : "legacy"} pin waits for work cleanup`, async () => {
		const holds = createBufferEditHolds();
		const identity = { messageId: "m", userId: "u", token: "t" };
		if (leased) await holds.begin("n", identity, async () => 0);
		const cancelled = gate();
		const unwinding = gate();
		const cleanup = gate();
		let writes = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"text":"unfinished'));
			},
			cancel() {
				cancelled.release();
			},
		});
		const request = new Request("http://localhost/buffer", { method: "PATCH", body });
		const save = holds.mutate(
			"n",
			"m",
			() =>
				withBufferEditRequestDeadline(
					request,
					async (bounded) => {
						try {
							await bounded.json();
							writes++;
						} finally {
							unwinding.release();
							await cleanup.promise;
						}
					},
					20,
					holds.mutationSignal(),
				),
			leased ? identity : undefined,
		);
		await cancelled.promise;
		await unwinding.promise;
		expect(holds.held("n")).toBe(true);
		expect(writes).toBe(0);
		cleanup.release();
		await expect(save).rejects.toMatchObject({ statusCode: 408 });
		expect(holds.held("n")).toBe(leased);
		await holds.release("n", identity);
	});

test("small lease bodies enforce byte limits even when Content-Length lies", async () => {
	const request = new Request("http://localhost/edit", {
		method: "POST",
		headers: { "content-length": "1" },
		body: JSON.stringify({ token: "x".repeat(1100) }),
	});
	await expect(readBufferEditLeaseBody(request)).rejects.toMatchObject({ statusCode: 413 });
});

test("authorization loss aborts a saved body, waits for unwinding, clears last and never wakes", async () => {
	const holds = createBufferEditHolds();
	const identity = { messageId: "m", userId: "u", token: "t" };
	const events: string[] = [];
	await holds.begin("n", identity, async () => 0);
	holds.setListener(() => {
		events.push("wake");
	});
	const entered = gate();
	const cleanup = gate();
	const unwinding = gate();
	const request = new Request("http://localhost/edit", {
		method: "PATCH",
		body: new ReadableStream<Uint8Array>(),
	});
	const save = holds.mutate(
		"n",
		"m",
		() =>
			withBufferEditRequestDeadline(
				request,
				async (bounded) => {
					entered.release();
					try {
						await bounded.json();
						events.push("write");
					} finally {
						unwinding.release();
						await cleanup.promise;
						events.push("save-settled");
					}
				},
				1000,
				holds.mutationSignal(),
			),
		identity,
	);
	await entered.promise;
	const revoked = holds.quiesceForAuthorizationLoss(
		"n",
		() => {
			events.push("stop");
		},
		async () => {
			events.push("clear");
		},
	);
	await unwinding.promise;
	expect(events).toEqual(["stop"]);
	expect(holds.held("n")).toBe(true);
	await expect(holds.begin("n", identity, async () => 0)).rejects.toThrow();
	cleanup.release();
	await expect(save).rejects.toMatchObject({ statusCode: 403 });
	await revoked;
	expect(events).toEqual(["stop", "save-settled", "clear"]);
	holds.expire();
	expect(holds.held("n")).toBe(false);
	expect(events).not.toContain("wake");
});

test("failed revocation cleanup stays fenced until an explicit retry succeeds", async () => {
	const holds = createBufferEditHolds();
	let notifications = 0;
	holds.setListener(() => {
		notifications++;
	});
	await expect(
		holds.quiesceForAuthorizationLoss(
			"n",
			() => {},
			async () => {
				throw new Error("cleanup failed");
			},
		),
	).rejects.toThrow("cleanup failed");
	expect(holds.held("n")).toBe(true);
	await expect(holds.mutate("n", "m", async () => {})).rejects.toThrow();
	await holds.quiesceForAuthorizationLoss(
		"n",
		() => {},
		async () => {},
	);
	expect(holds.held("n")).toBe(false);
	expect(notifications).toBe(0);
});
