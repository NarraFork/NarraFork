import { describe, expect, mock, test } from "bun:test";
import { getNetwork, getPageSnapshot } from "../actions";
import type { BrowserSession } from "../session";

// No Chrome dependency: exercise snapshot through the public diagnostics action.
function sessionWithTitle(title: () => Promise<string>): BrowserSession {
	return {
		page: { url: () => "https://example.test/", title },
		networkCaptureEnabled: true,
		networkRequests: [
			{
				id: "request-1",
				url: "https://example.test/api",
				method: "GET",
				resourceType: "fetch",
				startedAt: 0,
				status: 200,
				requestHeaders: {},
			},
		],
	} as unknown as BrowserSession;
}

function expectDiagnostics(result: Awaited<ReturnType<typeof getNetwork>>) {
	expect(result.count).toBe(1);
	expect(result.totalCount).toBe(1);
	expect(result.output).toContain("GET 200 fetch https://example.test/api");
	expect(result.snapshot.url).toBe("https://example.test/");
}

describe("Browser snapshot title budget", () => {
	test("exports a safe snapshot for callers outside diagnostics", async () => {
		const session = sessionWithTitle(async () => {
			throw new Error("Target closed during launch");
		});
		expect(await getPageSnapshot(session.page)).toEqual({
			url: "https://example.test/",
			title: "[Title unavailable]",
		});
	});

	test("preserves successful titles, including an empty title", async () => {
		for (const title of ["Example", ""]) {
			const result = await getNetwork(sessionWithTitle(async () => title));
			expectDiagnostics(result);
			expect(result.snapshot.title).toBe(title);
		}
	});

	test("returns diagnostics with an explicit fallback when title rejects", async () => {
		const result = await getNetwork(
			sessionWithTitle(async () => {
				throw new Error("Execution context was destroyed");
			}),
		);
		expectDiagnostics(result);
		expect(result.snapshot.title).toBe("[Title unavailable]");
	});

	test("also degrades when title throws synchronously", async () => {
		const result = await getNetwork(
			sessionWithTitle(() => {
				throw new Error("Target closed");
			}),
		);
		expectDiagnostics(result);
		expect(result.snapshot.title).toBe("[Title unavailable]");
	});

	test("bounds a stalled title without retrying and safely consumes its late rejection", async () => {
		let rejectTitle!: (reason: Error) => void;
		const title = mock(
			() =>
				new Promise<string>((_resolve, reject) => {
					rejectTitle = reject;
				}),
		);
		const startedAt = performance.now();
		const result = await getNetwork(sessionWithTitle(title));
		const elapsed = performance.now() - startedAt;
		expectDiagnostics(result);
		expect(result.snapshot.title).toBe("[Title unavailable]");
		expect(elapsed).toBeGreaterThanOrEqual(900);
		expect(elapsed).toBeLessThan(2_500);
		expect(title).toHaveBeenCalledTimes(1);
		// The timeout does not cancel CDP; rejection can arrive after we returned.
		rejectTitle(new Error("Late protocol failure"));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});
