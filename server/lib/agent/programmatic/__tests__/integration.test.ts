import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GatewayAuditEvent } from "../gateway";
import { createPodmanDriver } from "../podman-driver";
import { type JsonValue, ProgrammaticError } from "../protocol";
import { createProgrammaticService, type ExecutionOptions } from "../service";

// Explicit opt-in: no pulling images or selecting an ambient mutable tag in tests.
const imageId = process.env.NF_PROGRAMMATIC_TEST_IMAGE;
const suite = imageId ? describe : describe.skip;
suite("programmatic service through real rootless Podman", () => {
	const driver = createPodmanDriver({ imageId: imageId ?? "0".repeat(64) });
	const testHome = process.env.HOME;
	beforeAll(async () => {
		// Rootless Podman needs its existing image store. Application data remains
		// isolated by the preload's unchanged NARRAFORK_HOME.
		if (process.env.NARRAFORK_ORIGINAL_HOME) process.env.HOME = process.env.NARRAFORK_ORIGINAL_HOME;
		await driver.checkAvailable();
	}, 15000);
	afterAll(() => {
		if (testHome === undefined) delete process.env.HOME;
		else process.env.HOME = testHome;
	});
	function options(
		source: string,
		invoke: (args: JsonValue) => Promise<string> = async (args) => JSON.stringify(args),
	): ExecutionOptions {
		return {
			identity: {
				runId: crypto.randomUUID(),
				actorUserId: "integration-user",
				narratorId: "integration-narrator",
				outerToolCallId: "integration-call",
				teamId: "integration-team",
			},
			source,
			signal: new AbortController().signal,
			wallMs: 15000,
			receivers: [
				{
					id: "catalog-1",
					name: "catalog",
					methods: [
						{
							name: "read",
							description: "Read bounded fixture data",
							effect: "read",
							validate(args) {
								if (!Array.isArray(args)) throw new Error("expected args");
								return args;
							},
							invoke: (args) => invoke(args),
						},
					],
				},
			],
			authorize: async () => true,
			audit: async () => {},
		};
	}
	function deferred<T>() {
		let resolve: (value: T) => void = () => {};
		const promise = new Promise<T>((done) => {
			resolve = done;
		});
		return { promise, resolve };
	}
	test("returns a plain value and releases actual container resources", async () => {
		const service = createProgrammaticService({ driver });
		const result = await service.execute(options("const value:number=42; return value;"));
		expect(result.ok).toBe(true);
		expect(result.result?.value).toBe(42);
		expect(result.cleanup.confirmed).toBe(true);
		expect(result.resourcesReleased).toBe(true);
		expect(service.activeRuns()).toBe(0);
	}, 20000);
	test("sync loops/callbacks await async host replies without blocking application heartbeat", async () => {
		const service = createProgrammaticService({ driver });
		const audit: GatewayAuditEvent[] = [];
		let heartbeats = 0,
			observedWhileWaiting = 0;
		const timer = setInterval(() => heartbeats++, 5);
		const input = options(
			"const values=[1,2,3].map(n=>catalog.read(n)); deliver(values, 'complete');",
			async (args) => {
				const before = heartbeats;
				await new Promise((resolve) => setTimeout(resolve, 40));
				observedWhileWaiting += heartbeats - before;
				return JSON.stringify((args as number[])[0] * 2);
			},
		);
		input.audit = async (event) => {
			audit.push(event);
		};
		try {
			const result = await service.execute(input);
			expect(result.ok).toBe(true);
			expect(result.result?.value).toEqual([2, 4, 6]);
			expect(result.result?.delivery?.summary).toBe("complete");
			expect(observedWhileWaiting).toBeGreaterThan(3);
			expect(audit.map((entry) => entry.phase)).toEqual(
				Array.from({ length: 3 }, () => ["request", "authorized", "completed"] as const).flat(),
			);
			expect(
				audit.every((entry) => entry.identity.actorUserId === input.identity.actorUserId),
			).toBe(true);
			expect(result.stats.calls).toBe(3);
			expect(result.cleanup.confirmed).toBe(true);
		} finally {
			clearInterval(timer);
		}
	}, 20000);
	test("denied authorization never reaches the method, even when the script catches it", async () => {
		const service = createProgrammaticService({ driver });
		let called = 0;
		const input = options("try{catalog.read();}catch{} return 'pretend success';", async () => {
			called++;
			return "null";
		});
		input.authorize = async () => false;
		const result = await service.execute(input);
		expect(result.ok).toBe(false);
		expect(called).toBe(0);
		expect(result.error?.code).toBe("DENIED");
		expect(result.cleanup.confirmed).toBe(true);
	}, 20000);
	test("nonfatal domain failure can be handled before another synchronous call", async () => {
		const service = createProgrammaticService({ driver });
		const result = await service.execute(
			options(
				"let code;try{catalog.read(false);}catch(e){code=e.code;}deliver([code,catalog.read(true)]);",
				async (args) => {
					if (!(args as boolean[])[0])
						throw new ProgrammaticError("NOT_FOUND", "fixture absent", false);
					return '"found"';
				},
			),
		);
		expect(result.ok).toBe(true);
		expect(result.result?.value).toEqual(["NOT_FOUND", "found"]);
		expect(result.cleanup.confirmed).toBe(true);
	}, 20000);
	test("cancels a waiting RPC and retains capacity until an uncooperative host promise settles", async () => {
		const service = createProgrammaticService({ driver });
		const began = deferred<void>(),
			release = deferred<string>();
		const input = options("return catalog.read();", async () => {
			began.resolve();
			return release.promise;
		});
		const controller = new AbortController();
		input.signal = controller.signal;
		const work = service.execute(input);
		await began.promise;
		controller.abort();
		const result = await work;
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("CANCELLED");
		expect(result.cleanup.confirmed).toBe(true);
		expect(result.resourcesReleased).toBe(false);
		expect(service.activeRuns()).toBe(1);
		await expect(service.execute(options("return 1;"))).rejects.toMatchObject({ code: "CAPACITY" });
		release.resolve('"late"');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(service.activeRuns()).toBe(0);
	}, 20000);
	for (const [label, source] of [
		["infinite synchronous loop", "while(true){}"],
		[
			"unrelated native Atomics wait",
			"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);",
		],
	] as const)
		test(`${label} is bounded outside the VM`, async () => {
			const service = createProgrammaticService({ driver });
			const input = options(source);
			input.wallMs = 7000;
			const started = Date.now();
			const result = await service.execute(input);
			expect(result.ok).toBe(false);
			expect(result.cleanup.confirmed).toBe(true);
			expect(result.resourcesReleased).toBe(true);
			expect(Date.now() - started).toBeLessThan(17000);
		}, 20000);
	test("oversized results are rejected rather than presented as complete", async () => {
		const result = await createProgrammaticService({ driver }).execute(
			options("return '中'.repeat(30000);"),
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("OUTPUT_LIMIT");
		expect(result.cleanup.confirmed).toBe(true);
	}, 20000);
	test("delivery remains invalid after a caught post-delivery call", async () => {
		let calls = 0;
		const result = await createProgrammaticService({ driver }).execute(
			options("deliver('x');try{catalog.read();}catch{}", async () => {
				calls++;
				return "null";
			}),
		);
		expect(result.ok).toBe(false);
		expect(calls).toBe(0);
		expect(result.result?.delivery).toBeUndefined();
		expect(result.cleanup.confirmed).toBe(true);
	}, 20000);
	for (const source of [
		"}; catalog.read(); function replacement(){",
		"}; (() => catalog.read())(); function replacement(){",
		"}; globalThis.__nfCompiledEntry = (() => {catalog.read();return function(){",
	])
		test(`wrapper escape produces no RPC: ${source}`, async () => {
			let calls = 0;
			const result = await createProgrammaticService({ driver }).execute(
				options(source, async () => {
					calls++;
					return "null";
				}),
			);
			expect(result.ok).toBe(false);
			expect(result.error?.code).toBe("SCRIPT_CONTRACT");
			expect(calls).toBe(0);
			expect(result.stats.calls).toBe(0);
			expect(result.cleanup.confirmed).toBe(true);
		}, 20000);
	test("keyword text and return IIFE remain valid synchronous source", async () => {
		const result = await createProgrammaticService({ driver }).execute(
			options(
				'// async await Promise import\nreturn (() => catalog.read("async await Promise import"))();',
			),
		);
		expect(result.ok).toBe(true);
		expect(result.result?.value).toEqual(["async await Promise import"]);
		expect(result.stats.calls).toBe(1);
	}, 20000);
	test("user code cannot reach application globals or dynamically compile code", async () => {
		const result = await createProgrammaticService({ driver }).execute(
			options(
				"const hidden=['process','Bun','require','fetch'].map(key=>typeof globalThis[key]); let rejected=false;try{({}).constructor.constructor('return process')();}catch{rejected=true;} const blocked=[];for(const load of [()=>globalThis['require']('node:fs'),()=>require('node:fs')]){try{load();blocked.push(false);}catch{blocked.push(true);}}return {hidden,rejected,blocked};",
			),
		);
		expect(result.ok).toBe(true);
		expect(result.result?.value).toEqual({
			hidden: ["undefined", "undefined", "undefined", "undefined"],
			rejected: true,
			blocked: [true, true],
		});
	}, 20000);
});
