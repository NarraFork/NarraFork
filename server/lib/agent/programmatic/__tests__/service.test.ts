import { describe, expect, test } from "bun:test";
import type { ChildFrame, ResponseFrame, StartFrame } from "../protocol";
import { ProgrammaticError } from "../protocol";
import type { CleanupReport, IsolationDriver, SandboxPolicy, SandboxSession } from "../sandbox";
import { createProgrammaticService, type ExecutionOptions } from "../service";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Test synchronization timed out")), 1500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function eventually(predicate: () => boolean) {
	await bounded(
		(async () => {
			const deadline = Date.now() + 1000;
			while (!predicate()) {
				if (Date.now() >= deadline) throw new Error("Expected state was not reached");
				await new Promise<void>((resolve) => setTimeout(resolve, 1));
			}
		})(),
	);
}

class Frames implements AsyncIterable<string> {
	private queue: string[] = [];
	private ended = false;
	private changed = deferred<void>();

	push(frame: ChildFrame) {
		this.queue.push(JSON.stringify(frame));
		this.changed.resolve();
	}

	close() {
		this.ended = true;
		this.changed.resolve();
	}

	async *[Symbol.asyncIterator]() {
		while (true) {
			const next = this.queue.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (this.ended) return;
			this.changed = deferred<void>();
			await this.changed.promise;
		}
	}
}

const policy: SandboxPolicy = {
	kind: "podman",
	uid: 1000,
	memoryBytes: 128 * 1024 * 1024,
	maxPids: 32,
	cpuCores: 1,
	cpuSeconds: 2,
};
const ready: ChildFrame = {
	type: "ready",
	version: 1,
	probe: {
		uid: policy.uid,
		memoryBytes: policy.memoryBytes,
		pids: policy.maxPids,
		cpuQuota: 100000,
		cpuPeriod: 100000,
	},
};
const success: ChildFrame = { type: "result", version: 1, ok: true, value: 42, logs: [] };
const call = (sequence = 1): ChildFrame => ({
	type: "call",
	version: 1,
	sequence,
	receiver: "catalog-id",
	method: "read",
	args: null,
});

function fixture() {
	const frames = new Frames();
	const started = deferred<StartFrame>();
	const verified = deferred<void>();
	const response = deferred<ResponseFrame>();
	const events: string[] = [];
	const sent: Array<StartFrame | ResponseFrame> = [];
	const hooks = {
		available: async () => {},
		verify: async () => {},
		send: async (_frame: StartFrame | ResponseFrame) => {},
		cleanup: { confirmed: true, exitCode: 0 } as CleanupReport,
	};
	let launches = 0;
	let checks = 0;
	let invokes = 0;
	const session: SandboxSession = {
		policy,
		frames,
		exited: Promise.resolve(0),
		async verifyIsolation() {
			events.push("verify-enter");
			verified.resolve();
			await hooks.verify();
			events.push("verify-complete");
		},
		async send(json) {
			const frame = JSON.parse(json) as StartFrame | ResponseFrame;
			events.push(`send-${frame.type}`);
			sent.push(frame);
			if (frame.type === "start") started.resolve(frame);
			else response.resolve(frame);
			await hooks.send(frame);
		},
		async terminate() {
			frames.close();
			return hooks.cleanup;
		},
		stderr: () => "",
	};
	const driver: IsolationDriver = {
		policy,
		async checkAvailable() {
			checks++;
			await hooks.available();
		},
		async launch() {
			launches++;
			return session;
		},
	};
	const controller = new AbortController();
	const input: ExecutionOptions = {
		source: "return 42",
		signal: controller.signal,
		wallMs: 1000,
		identity: {
			runId: "run-1",
			narratorId: "narrator-1",
			actorUserId: "user-1",
			outerToolCallId: "tool-1",
			teamId: "team-1",
		},
		receivers: [
			{
				id: "catalog-id",
				name: "catalog",
				methods: [
					{
						name: "read",
						description: "Read catalog",
						effect: "read",
						validate: (args) => args,
						async invoke() {
							invokes++;
							return "42";
						},
					},
				],
			},
		],
		authorize: async () => true,
		audit: async () => {},
	};
	return {
		frames,
		started,
		verified,
		response,
		events,
		sent,
		hooks,
		driver,
		controller,
		input,
		launches: () => launches,
		checks: () => checks,
		invokes: () => invokes,
	};
}

describe("programmatic host service with a fake isolation driver", () => {
	test("awaits availability and verified isolation before sending source", async () => {
		const f = fixture();
		const available = deferred<void>();
		const verification = deferred<void>();
		f.hooks.available = () => available.promise;
		f.hooks.verify = () => verification.promise;
		const service = createProgrammaticService({ driver: f.driver });
		const running = service.execute(f.input);
		try {
			expect(f.checks()).toBe(1);
			expect(f.launches()).toBe(0);
			available.resolve();
			f.frames.push(ready);
			await bounded(f.verified.promise);
			expect(f.sent).toHaveLength(0);
			verification.resolve();
			const start = await bounded(f.started.promise);
			expect(start.source).toBe(f.input.source);
			expect(f.events).toEqual(["verify-enter", "verify-complete", "send-start"]);
			f.frames.push(success);
			f.frames.close();
			const result = await bounded(running);
			expect(result.ok).toBe(true);
			expect(result.resourcesReleased).toBe(true);
			expect(service.activeRuns()).toBe(0);
		} finally {
			available.resolve();
			verification.resolve();
			f.controller.abort();
			await bounded(running);
		}
	});

	for (const [name, frame] of [
		["call", call()],
		["result", success],
	] as const) {
		test(`rejects ${name} before ready`, async () => {
			const f = fixture();
			f.frames.push(frame);
			const result = await bounded(
				createProgrammaticService({ driver: f.driver }).execute(f.input),
			);
			expect(result.error?.code).toBe("PROTOCOL");
			expect(result.ok).toBe(false);
			expect(f.sent).toHaveLength(0);
			expect(f.invokes()).toBe(0);
		});
	}

	test("rejects duplicate ready", async () => {
		const f = fixture();
		f.frames.push(ready);
		f.frames.push(ready);
		const result = await bounded(createProgrammaticService({ driver: f.driver }).execute(f.input));
		expect(result.error?.code).toBe("PROTOCOL");
		expect(result.ok).toBe(false);
	});

	test("rejects result during isolation verification, before start", async () => {
		const f = fixture();
		const verification = deferred<void>();
		f.hooks.verify = () => verification.promise;
		f.frames.push(ready);
		const running = createProgrammaticService({ driver: f.driver }).execute(f.input);
		try {
			await bounded(f.verified.promise);
			f.frames.push(success);
			const result = await bounded(running);
			expect(result.error?.code).toBe("PROTOCOL");
			expect(f.sent).toHaveLength(0);
		} finally {
			verification.resolve();
			f.controller.abort();
			await bounded(running);
		}
	});

	for (const [name, frame] of [
		["concurrent call", call(2)],
		["premature result", success],
	] as const) {
		test(`rejects ${name} while authorization is pending`, async () => {
			const f = fixture();
			const authorization = deferred<boolean>();
			const entered = deferred<void>();
			f.input.authorize = () => {
				entered.resolve();
				return authorization.promise;
			};
			f.frames.push(ready);
			const running = createProgrammaticService({ driver: f.driver }).execute(f.input);
			try {
				await bounded(f.started.promise);
				f.frames.push(call());
				await bounded(entered.promise);
				f.frames.push(frame);
				const result = await bounded(running);
				expect(result.error?.code).toBe("PROTOCOL");
				expect(result.ok).toBe(false);
				expect(f.invokes()).toBe(0);
			} finally {
				authorization.resolve(true);
				f.controller.abort();
				await bounded(running);
			}
		});
	}

	for (const frame of [ready, call(), success]) {
		test(`rejects ${frame.type} after a terminal result`, async () => {
			const f = fixture();
			f.frames.push(ready);
			f.hooks.send = async (outgoing) => {
				if (outgoing.type !== "start") return;
				f.frames.push(success);
				f.frames.push(frame);
				f.frames.close();
			};
			const result = await bounded(
				createProgrammaticService({ driver: f.driver }).execute(f.input),
			);
			expect(result.ok).toBe(false);
			expect(result.error?.code).toBe("PROTOCOL");
		});
	}

	test("authorization denial never invokes a receiver", async () => {
		const f = fixture();
		f.input.authorize = async () => false;
		f.frames.push(ready);
		const running = createProgrammaticService({ driver: f.driver }).execute(f.input);
		await bounded(f.started.promise);
		f.frames.push(call());
		const result = await bounded(running);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("DENIED");
		expect(f.invokes()).toBe(0);
	});

	test("caller cancellation wins over an already queued success result", async () => {
		const f = fixture();
		f.frames.push(ready);
		f.hooks.send = async (frame) => {
			if (frame.type !== "start") return;
			f.frames.push(success);
			f.frames.close();
			f.controller.abort();
		};
		const result = await bounded(createProgrammaticService({ driver: f.driver }).execute(f.input));
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("CANCELLED");
	});

	for (const phase of ["authorize", "invoke"] as const) {
		test(`pending ${phase} retains capacity after cancellation until its promise drains`, async () => {
			const f = fixture();
			const entered = deferred<void>();
			const authorization = deferred<boolean>();
			const invocation = deferred<string>();
			let invocationCount = 0;
			if (phase === "authorize") {
				f.input.authorize = () => {
					entered.resolve();
					return authorization.promise;
				};
			} else {
				f.input.receivers = [
					{
						id: "catalog-id",
						name: "catalog",
						methods: [
							{
								name: "read",
								description: "Read",
								effect: "read",
								validate: (args) => args,
								invoke: () => {
									invocationCount++;
									entered.resolve();
									return invocation.promise;
								},
							},
						],
					},
				];
			}
			const service = createProgrammaticService({ driver: f.driver, maxConcurrent: 1 });
			f.frames.push(ready);
			const running = service.execute(f.input);
			try {
				await bounded(f.started.promise);
				f.frames.push(call());
				await bounded(entered.promise);
				f.controller.abort();
				const result = await bounded(running);
				expect(result.error?.code).toBe("CANCELLED");
				expect(result.ok).toBe(false);
				expect(result.cleanup.confirmed).toBe(true);
				expect(result.resourcesReleased).toBe(false);
				expect(service.activeRuns()).toBe(1);
				await expect(
					service.execute({
						...f.input,
						signal: new AbortController().signal,
						identity: { ...f.input.identity, runId: "run-2" },
					}),
				).rejects.toMatchObject({ code: "CAPACITY" });
				expect(f.launches()).toBe(1);
				authorization.resolve(true);
				invocation.resolve("42");
				await eventually(() => service.activeRuns() === 0);
				expect(f.invokes()).toBe(0);
				expect(invocationCount).toBe(phase === "invoke" ? 1 : 0);
				expect(f.sent.filter((frame) => frame.type === "response")).toHaveLength(0);
			} finally {
				authorization.resolve(true);
				invocation.resolve("42");
				f.controller.abort();
				await bounded(running);
				await eventually(() => service.activeRuns() === 0);
			}
		});
	}

	test("unconfirmed cleanup retains capacity without waiting for the cleanup timeout", async () => {
		const f = fixture();
		f.hooks.cleanup = { confirmed: false, exitCode: null };
		f.frames.push(ready);
		f.hooks.send = async (frame) => {
			if (frame.type === "start") {
				f.frames.push(success);
				f.frames.close();
			}
		};
		const service = createProgrammaticService({ driver: f.driver });
		const result = await bounded(service.execute(f.input));
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("RECLAIM_PENDING");
		expect(result.resourcesReleased).toBe(false);
		expect(service.activeRuns()).toBe(1);
		await expect(service.execute(f.input)).rejects.toMatchObject({ code: "CAPACITY" });
		expect(f.launches()).toBe(1);
	});

	for (const field of [
		"runId",
		"narratorId",
		"actorUserId",
		"outerToolCallId",
		"teamId",
		"projectId",
	] as const) {
		test(`invalid ${field} fails before availability or launch`, async () => {
			const f = fixture();
			const service = createProgrammaticService({ driver: f.driver });
			await expect(
				service.execute({
					...f.input,
					identity: { ...f.input.identity, [field]: "\n" },
				}),
			).rejects.toMatchObject({ code: "IDENTITY" });
			expect(f.checks()).toBe(0);
			expect(f.launches()).toBe(0);
			expect(service.activeRuns()).toBe(0);
		});
	}

	for (const key of ["maxConcurrent", "maxPerUser", "maxPerTeam"] as const) {
		for (const value of [0, -1, 1.5, 17, Number.NaN]) {
			test(`invalid ${key}=${value} fails before launch`, () => {
				const f = fixture();
				expect(() => createProgrammaticService({ driver: f.driver, [key]: value })).toThrow(
					ProgrammaticError,
				);
				expect(f.checks()).toBe(0);
				expect(f.launches()).toBe(0);
			});
		}
	}

	test("wall deadline stops an otherwise idle admitted session", async () => {
		const f = fixture();
		f.frames.push(ready);
		const service = createProgrammaticService({ driver: f.driver });
		const result = await bounded(service.execute({ ...f.input, wallMs: 30 }));
		expect(f.sent.some((frame) => frame.type === "start")).toBe(true);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("DEADLINE");
		expect(result.resourcesReleased).toBe(true);
		expect(service.activeRuns()).toBe(0);
	});

	test("failed availability cannot be bypassed by a driver declaring podman policy", async () => {
		const f = fixture();
		f.hooks.available = async () => {
			throw new ProgrammaticError("ISOLATION_REQUIRED", "Isolation unavailable");
		};
		const result = await bounded(createProgrammaticService({ driver: f.driver }).execute(f.input));
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("ISOLATION_REQUIRED");
		expect(f.checks()).toBe(1);
		expect(f.launches()).toBe(0);
	});

	test("missing checkAvailable cannot launch a sandbox", async () => {
		const f = fixture();
		const driver = { policy, launch: f.driver.launch } as unknown as IsolationDriver;
		let failedClosed = false;
		try {
			const result = await bounded(createProgrammaticService({ driver }).execute(f.input));
			failedClosed = !result.ok && !!result.error;
		} catch (error) {
			if (!(error instanceof ProgrammaticError)) throw error;
			failedClosed = true;
		}
		expect(failedClosed).toBe(true);
		expect(f.launches()).toBe(0);
	});
});
