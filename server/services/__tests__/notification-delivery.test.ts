import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "@server/lib/logger";
import {
	deliverNotification,
	NOTIFICATION_MAX_QUEUED,
	NOTIFICATION_RESPONSE_MAX_BYTES,
} from "../notification-delivery";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restore();
});
const input = {
	channel: "dingtalk" as const,
	webhook: "https://example.test/hook?access_token=private-token",
	secret: "private-secret",
	title: "private-title",
	message: "private-message",
	source: "narrator" as const,
	narratorId: "narrator-1",
	userId: "user-1",
};
function respond(body: unknown, status = 200) {
	globalThis.fetch = mock(
		async () => new Response(JSON.stringify(body), { status }),
	) as unknown as typeof fetch;
}

describe("bounded notification delivery", () => {
	it("checks DingTalk and both Feishu business result shapes", async () => {
		respond({ errcode: 0 });
		expect((await deliverNotification(input)).status).toBe("success");
		respond({ code: 0 });
		expect((await deliverNotification({ ...input, channel: "feishu" })).status).toBe("success");
		respond({ StatusCode: 0 });
		expect((await deliverNotification({ ...input, channel: "feishu" })).status).toBe("success");
		for (const channel of ["dingtalk", "feishu"] as const) {
			respond({ errcode: 310000, code: 19001, errmsg: input.webhook, msg: input.secret });
			expect((await deliverNotification({ ...input, channel })).reason).toBe("business_error");
		}
	});

	it("returns no URL, secret, body or response raw text, including network errors and logs", async () => {
		const log = spyOn(logger, "info").mockImplementation(() => {});
		globalThis.fetch = mock(async () => {
			throw new Error(`${input.webhook} ${input.secret}`);
		}) as unknown as typeof fetch;
		const result = await deliverNotification(input);
		expect(result.reason).toBe("delivery_error");
		const output = JSON.stringify({ result, logs: log.mock.calls });
		for (const privateValue of [input.webhook, input.secret, input.title, input.message])
			expect(output).not.toContain(privateValue);
		expect(log.mock.calls[0]?.[1]).toMatchObject({
			source: "narrator",
			narratorId: "narrator-1",
			userId: "user-1",
			channel: "dingtalk",
			status: "failed",
		});
	});

	it("checks HTTP status, rejects malformed or missing business codes, and never retries", async () => {
		respond({ errcode: 0, leak: input.secret }, 429);
		expect((await deliverNotification(input)).reason).toBe("http_error");
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		for (const body of [{}, null, { errcode: "0" }]) {
			respond(body);
			expect((await deliverNotification(input)).reason).toBe("invalid_response");
		}
	});

	it("bounds streaming reads to 8KiB and cancels oversized bodies", async () => {
		let pulls = 0;
		let cancelled = false;
		globalThis.fetch = mock(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							pulls++;
							controller.enqueue(new Uint8Array(4096));
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		) as unknown as typeof fetch;
		expect(NOTIFICATION_RESPONSE_MAX_BYTES).toBe(8192);
		expect((await deliverNotification(input)).reason).toBe("response_too_large");
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThanOrEqual(4);
	});

	it("times out fetch with a signal and does not retry", async () => {
		globalThis.fetch = mock(
			(_url: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				}),
		) as unknown as typeof fetch;
		expect((await deliverNotification({ ...input, timeoutMs: 5 })).reason).toBe("timeout");
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("times out a stalled response body, not just response headers", async () => {
		let cancelled = false;
		globalThis.fetch = mock(
			async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
		) as unknown as typeof fetch;
		expect((await deliverNotification({ ...input, timeoutMs: 5 })).reason).toBe("timeout");
		expect(cancelled).toBe(true);
	});

	it("passes caller cancellation to an in-flight fetch", async () => {
		const controller = new AbortController();
		globalThis.fetch = mock(
			(_url: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error(input.secret)), {
						once: true,
					});
					controller.abort();
				}),
		) as unknown as typeof fetch;
		expect((await deliverNotification({ ...input, signal: controller.signal })).reason).toBe(
			"cancelled",
		);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("cancels stalled streaming response reads", async () => {
		let cancelled = false;
		const abort = new AbortController();
		globalThis.fetch = mock(
			async () =>
				new Response(
					new ReadableStream({
						start() {
							setTimeout(() => abort.abort(), 5);
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		) as unknown as typeof fetch;
		expect((await deliverNotification({ ...input, signal: abort.signal })).reason).toBe(
			"cancelled",
		);
		expect(cancelled).toBe(true);
	});

	it("does not request for already aborted signals", async () => {
		respond({ errcode: 0 });
		const controller = new AbortController();
		controller.abort();
		expect((await deliverNotification({ ...input, signal: controller.signal })).reason).toBe(
			"cancelled",
		);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("times out queued requests without fetching and restores queue capacity", async () => {
		const blocker = new AbortController();
		globalThis.fetch = mock(
			(_url: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
						once: true,
					});
				}),
		) as unknown as typeof fetch;
		const first = deliverNotification({ ...input, signal: blocker.signal });
		const second = deliverNotification({ ...input, signal: blocker.signal });
		const queued = await deliverNotification({ ...input, timeoutMs: 5 });
		expect(queued.reason).toBe("timeout");
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		blocker.abort();
		await Promise.all([first, second]);
		respond({ errcode: 0 });
		expect((await deliverNotification(input)).status).toBe("success");
	});

	it("caps the waiting queue at 32, rejects overflow as busy and removes cancelled entries", async () => {
		const blocker = new AbortController();
		const queuedController = new AbortController();
		globalThis.fetch = mock(
			(_url: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
						once: true,
					});
				}),
		) as unknown as typeof fetch;
		const running = [
			deliverNotification({ ...input, signal: blocker.signal }),
			deliverNotification({ ...input, signal: blocker.signal }),
		];
		const pending = Array.from({ length: NOTIFICATION_MAX_QUEUED }, () =>
			deliverNotification({ ...input, signal: queuedController.signal }),
		);
		expect(NOTIFICATION_MAX_QUEUED).toBe(32);
		expect(await deliverNotification(input)).toMatchObject({
			channel: "dingtalk",
			status: "failed",
			reason: "busy",
		});
		queuedController.abort();
		expect((await Promise.all(pending)).every((result) => result.reason === "cancelled")).toBe(
			true,
		);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		const newController = new AbortController();
		const replacement = deliverNotification({ ...input, signal: newController.signal });
		newController.abort();
		expect((await replacement).reason).toBe("cancelled");
		blocker.abort();
		await Promise.all(running);
		respond({ errcode: 0 });
		expect((await deliverNotification(input)).status).toBe("success");
	});

	it("limits concurrent requests globally to two and cancels queued work", async () => {
		const releases: Array<() => void> = [];
		let active = 0;
		let maximum = 0;
		globalThis.fetch = mock(async () => {
			active++;
			maximum = Math.max(maximum, active);
			await new Promise<void>((resolve) => releases.push(resolve));
			active--;
			return new Response('{"errcode":0}');
		}) as unknown as typeof fetch;
		const first = deliverNotification(input);
		const second = deliverNotification(input);
		const controller = new AbortController();
		const queued = deliverNotification({ ...input, signal: controller.signal });
		const fourth = deliverNotification(input);
		await Promise.resolve();
		expect(releases).toHaveLength(2);
		controller.abort();
		expect((await queued).reason).toBe("cancelled");
		releases[0]?.();
		releases[1]?.();
		await Promise.all([first, second]);
		expect(releases).toHaveLength(3);
		releases[2]?.();
		expect((await fourth).status).toBe("success");
		expect(maximum).toBe(2);
	});
});
