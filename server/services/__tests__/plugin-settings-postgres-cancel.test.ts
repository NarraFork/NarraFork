import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createPostgresPluginSettingsStore } from "../postgres-plugin-settings-store";

const address = {
	pluginId: "com.example.cancel",
	contributionId: "test",
	targetKind: "custom-api" as const,
	targetId: "provider-1",
};
function gate<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
describe("PostgreSQL plugin store cancellation", () => {
	test("abort during pool admission returns a failure and late admission executes no SQL", async () => {
		const admitted = gate<void>();
		let calls = 0;
		const client = {
			begin: async (callback: (tx: unknown) => Promise<unknown>) => {
				await admitted.promise;
				return callback({
					unsafe: () => {
						calls++;
						return Promise.resolve([]);
					},
				});
			},
		};
		const store = createPostgresPluginSettingsStore(client as unknown as SQL),
			controller = new AbortController(),
			reason = new Error("fixture cancelled");
		const pending = store.getSetting(address, { signal: controller.signal });
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		admitted.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(calls).toBe(0);
	});
	test("abort cancels the exact in-flight query and the transaction rolls back without fallback", async () => {
		const started = gate<void>(),
			blocked = gate<unknown[]>();
		let cancelled = 0,
			rolledBack = false;
		const query = Object.assign(blocked.promise, {
			cancel() {
				cancelled++;
				blocked.resolve([]);
			},
		});
		const client = {
			begin: async (callback: (tx: unknown) => Promise<unknown>) => {
				try {
					return await callback({
						unsafe: (text: string) => {
							if (text.startsWith("SELECT")) {
								started.resolve();
								return query;
							}
							return Object.assign(Promise.resolve([]), { cancel() {} });
						},
					});
				} catch (error) {
					rolledBack = true;
					throw error;
				}
			},
		};
		const store = createPostgresPluginSettingsStore(client as unknown as SQL),
			controller = new AbortController();
		const pending = store.getSetting(address, { signal: controller.signal });
		await started.promise;
		controller.abort(new Error("fixture cancelled"));
		await expect(pending).rejects.toThrow("fixture cancelled");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(cancelled).toBe(1);
		expect(rolledBack).toBe(true);
	});
});
