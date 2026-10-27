import { describe, expect, mock, test } from "bun:test";
import { loadWithRetry } from "./lazy-with-retry";

const fetchError = () => new Error("Failed to fetch dynamically imported module: /panel.tsx");

describe("loadWithRetry", () => {
	test("returns an immediate success without another request", async () => {
		const importer = mock(async () => ({ default: "panel" }));
		await expect(loadWithRetry(importer, { delayMs: 0 })).resolves.toEqual({ default: "panel" });
		expect(importer).toHaveBeenCalledTimes(1);
	});

	test("retries a transient module fetch failure once", async () => {
		let attempts = 0;
		const importer = mock(async () => {
			attempts++;
			if (attempts === 1) throw fetchError();
			return { default: "recovered" };
		});
		await expect(loadWithRetry(importer, { delayMs: 0 })).resolves.toEqual({
			default: "recovered",
		});
		expect(importer).toHaveBeenCalledTimes(2);
	});

	test("a persistent fetch failure reaches the boundary after the bounded retry", async () => {
		const error = fetchError();
		const importer = mock(async () => {
			throw error;
		});
		await expect(loadWithRetry(importer, { delayMs: 0 })).rejects.toBe(error);
		expect(importer).toHaveBeenCalledTimes(2);
	});

	test("does not retry errors thrown by module evaluation", async () => {
		const error = new Error("module bug");
		const importer = mock(async () => {
			throw error;
		});
		await expect(loadWithRetry(importer, { delayMs: 0 })).rejects.toBe(error);
		expect(importer).toHaveBeenCalledTimes(1);
	});
});
