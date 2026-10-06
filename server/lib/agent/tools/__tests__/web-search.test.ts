import { describe, expect, test } from "bun:test";
import { withSearchTimeout } from "../web-search";

describe("WebSearch timeout helper", () => {
	test("rejects on timeout even when the provider ignores AbortSignal", async () => {
		const startedAt = Date.now();

		try {
			await withSearchTimeout(
				undefined,
				() =>
					new Promise<string>(() => {
						// Intentionally ignore the provided AbortSignal.
					}),
				20,
			);
			throw new Error("Expected withSearchTimeout to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).name).toBe("TimeoutError");
			expect((err as Error).message).toBe("Web search timed out");
		}

		expect(Date.now() - startedAt).toBeLessThan(500);
	});

	test("rejects caller abort as AbortError instead of TimeoutError", async () => {
		const controller = new AbortController();
		const promise = withSearchTimeout(
			controller.signal,
			() =>
				new Promise<string>(() => {
					// Intentionally ignore the provided AbortSignal.
				}),
			1_000,
		);

		controller.abort();

		try {
			await promise;
			throw new Error("Expected withSearchTimeout to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).name).toBe("AbortError");
			expect((err as Error).message).not.toBe("Web search timed out");
		}
	});
});
