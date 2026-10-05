import { describe, expect, test } from "bun:test";
import { generateWithFirstTokenTimeout } from "../generate-first-token-timeout";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("generation first-token timeout", () => {
	test("uses the supplied budget and aborts upstream before output", async () => {
		let upstream: AbortSignal | undefined;
		await expect(
			generateWithFirstTokenTimeout(
				async ({ signal }) => {
					upstream = signal;
					return await new Promise<string>(() => {});
				},
				10,
				new AbortController().signal,
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(upstream?.aborted).toBe(true);
	});

	for (const channel of ["onTextDelta", "onReasoningDelta"] as const) {
		test(`${channel} clears the timer, allowing a long generation`, async () => {
			const result = await generateWithFirstTokenTimeout(
				async (options) => {
					await options[channel]?.("first");
					await wait(40);
					expect(options.signal?.aborted).toBe(false);
					return "complete";
				},
				10,
				new AbortController().signal,
			);
			expect(result).toBe("complete");
		});
	}

	test("empty output does not clear the first-token deadline", async () => {
		await expect(
			generateWithFirstTokenTimeout(
				async ({ onTextDelta }) => {
					await onTextDelta?.("");
					return await new Promise<string>(() => {});
				},
				10,
				new AbortController().signal,
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	test("zero disables the deadline", async () => {
		expect(
			await generateWithFirstTokenTimeout(
				async () => {
					await wait(20);
					return "done";
				},
				0,
				new AbortController().signal,
			),
		).toBe("done");
	});

	test("request cancellation still aborts upstream after the first token", async () => {
		const request = new AbortController();
		let upstream: AbortSignal | undefined;
		const pending = generateWithFirstTokenTimeout(
			async (options) => {
				upstream = options.signal;
				await options.onTextDelta?.("first");
				return await new Promise<string>(() => {});
			},
			10,
			request.signal,
		);
		request.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(upstream?.aborted).toBe(true);
	});

	test("already cancelled requests never invoke generation", async () => {
		const request = new AbortController();
		request.abort();
		let invoked = false;
		await expect(
			generateWithFirstTokenTimeout(
				async () => {
					invoked = true;
				},
				10,
				request.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(invoked).toBe(false);
	});

	test("completion and failure clean up the deadline", async () => {
		let upstream: AbortSignal | undefined;
		await expect(
			generateWithFirstTokenTimeout(
				async ({ signal }) => {
					upstream = signal;
					throw new Error("provider failure");
				},
				10,
				new AbortController().signal,
			),
		).rejects.toThrow("provider failure");
		await wait(20);
		expect(upstream?.aborted).toBe(false);
	});
});
