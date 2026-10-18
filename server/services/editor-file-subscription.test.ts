import { expect, mock, test } from "bun:test";
import type { EditorFileServerMessage } from "@shared/editor-file-events";
import { AppError } from "../lib/errors";
import { EditorFileSubscriptions } from "./editor-file-subscription";

const flush = async () => {
	for (let i = 0; i < 40; i++) await Promise.resolve();
};
function fixture() {
	const pool = new EditorFileSubscriptions();
	const frames: EditorFileServerMessage[] = [];
	let runtime = "runtime1",
		allowed = true,
		live = true;
	const authorize = mock(async () => {
		if (!allowed) throw new AppError("revoked /private/path", 403, "DENIED");
		return runtime;
	});
	const options = {
		id: "opaque",
		narratorId: "n",
		target: { resourceId: "verified-scope", authorize },
		live: () => live,
		send: (frame: EditorFileServerMessage) => {
			frames.push(frame);
		},
	};
	return {
		pool,
		frames,
		authorize,
		options,
		runtime: () => {
			runtime = "runtime2";
		},
		revoke: () => {
			allowed = false;
		},
		disconnect: () => {
			live = false;
		},
	};
}
test("one shared timer/refcounted resource, opaque notifications and final cleanup", async () => {
	const f = fixture();
	const a = f.pool.subscribe(f.options),
		b = f.pool.subscribe({ ...f.options, id: "second" });
	try {
		await flush();
		expect(f.pool.diagnostics).toEqual({ resources: 1, references: 2, running: 0, timers: 1 });
		expect(f.frames).toHaveLength(2);
		expect(Object.keys(f.frames[0]).sort()).toEqual([
			"generation",
			"reason",
			"resourceId",
			"seq",
			"subscriptionId",
			"type",
		]);
		expect(f.authorize).toHaveBeenCalledTimes(4);
		a();
		expect(f.pool.diagnostics.references).toBe(1);
	} finally {
		a();
		b();
	}
	expect(f.pool.diagnostics).toEqual({ resources: 0, references: 0, running: 0, timers: 0 });
});
test("runtime rebind keeps stable resource, generation belongs to each new subscription", async () => {
	const f = fixture(),
		stop = f.pool.subscribe(f.options);
	await flush();
	const first = f.frames[0];
	f.runtime();
	f.pool.hint();
	await flush();
	expect(f.frames[1]).toMatchObject({
		type: "editor_file_changed",
		reason: "rebind",
		seq: 2,
		resourceId: "verified-scope",
	});
	stop();
	const stop2 = f.pool.subscribe(f.options);
	await flush();
	stop2();
	expect(
		"generation" in first &&
			"generation" in f.frames[2] &&
			first.generation !== f.frames[2].generation,
	).toBe(true);
});
test.each([
	"acl",
	"root",
	"user",
	"oauth",
	"device",
	"cwd",
])("%s mutation fences a queued authorization, rechecks, and never publishes late", async () => {
	const f = fixture();
	let resolve!: (value: string) => void;
	f.authorize.mockImplementationOnce(
		() =>
			new Promise((yes) => {
				resolve = yes;
			}),
	);
	const stop = f.pool.subscribe(f.options);
	f.revoke();
	f.pool.hint("n");
	resolve("runtime1");
	await flush();
	stop();
	expect(f.frames).toEqual([
		{ type: "editor_file_error", subscriptionId: "opaque", code: "access_denied" },
	]);
	expect(JSON.stringify(f.frames)).not.toContain("/private/path");
	expect(f.pool.diagnostics.references).toBe(0);
});
test("unsubscribe/disconnect while final authorization awaits drops ACK and pending work", async () => {
	for (const disconnect of [false, true]) {
		const f = fixture();
		let resolve!: (value: string) => void;
		f.authorize
			.mockImplementationOnce(async () => "runtime1")
			.mockImplementationOnce(
				() =>
					new Promise((yes) => {
						resolve = yes;
					}),
			);
		const stop = f.pool.subscribe(f.options);
		await flush();
		if (disconnect) f.disconnect();
		else stop();
		resolve("runtime1");
		await flush();
		stop();
		expect(f.frames).toHaveLength(0);
		expect(f.pool.diagnostics.timers).toBe(0);
	}
});
test("burst coalesces to one pending run and authorization concurrency is four", async () => {
	const pool = new EditorFileSubscriptions();
	const releases: (() => void)[] = [];
	const resolves: ((value: string) => void)[] = [];
	let active = 0,
		peak = 0;
	const authorize = async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise<string>((yes) => resolves.push(yes));
		active--;
		return "r";
	};
	for (let i = 0; i < 12; i++)
		releases.push(
			pool.subscribe({
				id: `${i}`,
				narratorId: "n",
				target: { resourceId: `${i}`, authorize },
				live: () => true,
				send: () => {},
			}),
		);
	for (let i = 0; i < 1000; i++) pool.hint();
	expect(pool.diagnostics.running).toBe(4);
	for (const stop of releases) stop();
	for (const resolve of resolves) resolve("r");
	await flush();
	expect(peak).toBe(4);
	expect(pool.diagnostics).toEqual({ resources: 0, references: 0, running: 0, timers: 0 });
});
