import { expect, test } from "bun:test";
import { ReasoningTranslationScheduler } from "../reasoning-translation-scheduler";

function harness() {
	const calls: Array<{ id: string; signal: AbortSignal; finish: () => void }> = [];
	const scheduler = new ReasoningTranslationScheduler(
		(id: string) => id,
		(id, signal) => new Promise((finish) => calls.push({ id, signal, finish })),
		(error) => {
			throw error;
		},
	);
	return { scheduler, calls };
}

test("coalesces demand and aborts only when the last viewer leaves", async () => {
	const { scheduler, calls } = harness();
	const a = {};
	const b = {};
	scheduler.replace(a, ["same"]);
	scheduler.replace(b, ["same"]);
	await Promise.resolve();
	expect(calls.map(({ id }) => id)).toEqual(["same"]);
	scheduler.replace(a, []);
	expect(calls[0].signal.aborted).toBe(false);
	scheduler.replace(b, []);
	expect(calls[0].signal.aborted).toBe(true);
	calls[0].finish();
});

test("bounds running work and drops hidden queued work before calling the provider", async () => {
	const { scheduler, calls } = harness();
	const a = {};
	scheduler.replace(a, ["a", "b", "c", "d", "hidden", "visible"]);
	await Promise.resolve();
	expect(calls.map(({ id }) => id)).toEqual(["a", "b", "c", "d"]);
	scheduler.replace(a, ["a", "b", "c", "d", "visible"]);
	calls[0].finish();
	await Bun.sleep(0);
	expect(calls.map(({ id }) => id)).toEqual(["a", "b", "c", "d", "visible"]);
	scheduler.replace(a, []);
	for (const call of calls) call.finish();
});

test("reports status per viewer and releases completed jobs for a later request", async () => {
	const { scheduler, calls } = harness();
	const a = {};
	const b = {};
	const statuses: string[] = [];
	scheduler.replace(a, ["same"], (_target, state) => statuses.push(`a:${state}`));
	scheduler.replace(b, ["same"], (_target, state) => statuses.push(`b:${state}`));
	await Promise.resolve();
	scheduler.replace(a, []);
	calls[0].finish();
	await Bun.sleep(0);
	expect(statuses).toEqual(["a:queued", "a:running", "b:running", "a:idle", "b:idle"]);
	scheduler.replace(b, ["same"]);
	await Promise.resolve();
	expect(calls).toHaveLength(2);
	calls[1].finish();
});
