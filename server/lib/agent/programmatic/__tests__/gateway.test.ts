import { afterEach, describe, expect, mock, test } from "bun:test";
import { createGateway, type GatewayOptions } from "../gateway";
import {
	type CallFrame,
	type MethodDefinition,
	ProgrammaticError,
	type ResponseFrame,
} from "../protocol";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const gateways: ReturnType<typeof createGateway>[] = [];
afterEach(async () => {
	for (const gateway of gateways.splice(0)) {
		gateway.close();
		await gateway.drained();
	}
});

function setup(
	overrides: Partial<GatewayOptions> = {},
	methodOverrides: Partial<MethodDefinition> = {},
) {
	const controller = new AbortController();
	const invoke = mock(async () => '{"answer":42}');
	const authorize = mock(async () => true);
	const audit = mock(async () => {});
	const onFatal = mock((_error: ProgrammaticError) => {});
	const method: MethodDefinition = {
		name: "lookup",
		description: "Read a fixture",
		effect: "read",
		validate: (args) => args,
		invoke,
		...methodOverrides,
	};
	const options: GatewayOptions = {
		identity: {
			runId: "run",
			narratorId: "narrator",
			actorUserId: "actor",
			outerToolCallId: "outer",
			teamId: "team",
			projectId: "project",
		},
		receivers: [{ id: "fixture-id", name: "fixture", methods: [method] }],
		budgets: {
			requestBytes: 2048,
			responseBytes: 2048,
			transferBytes: 8192,
			maxCalls: 10,
			wallMs: 5000,
			resultBytes: 1024,
			maxLogs: 2,
			logBytes: 128,
			summaryChars: 128,
		},
		signal: controller.signal,
		deadlineAt: Date.now() + 5000,
		authorize,
		audit,
		onFatal,
		...overrides,
	};
	const gateway = createGateway(options);
	gateways.push(gateway);
	return { gateway, controller, invoke, authorize, audit, onFatal, options, method };
}

function call(sequence = 1, args: CallFrame["args"] = null): CallFrame {
	return { type: "call", version: 1, sequence, receiver: "fixture-id", method: "lookup", args };
}

function expectError(response: ResponseFrame, code: string, fatal = true) {
	expect(response).toMatchObject({
		type: "response",
		version: 1,
		ok: false,
		error: { code, fatal },
	});
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const slotBytes = (value: unknown) => Math.max(JSON.stringify(value).length * 2, bytes(value));

// Bound waits so a cancellation regression fails rather than hanging the suite.
async function promptly<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Operation did not settle promptly")), 500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe("programmatic gateway", () => {
	test("pins host identity and freezes authorization, invocation and audit context", async () => {
		const seen: Parameters<GatewayOptions["authorize"]>[] = [];
		const identity = {
			runId: "run",
			narratorId: "narrator",
			actorUserId: "actor",
			outerToolCallId: "outer",
			teamId: "team",
			projectId: "project",
		};
		const original = { ...identity };
		const invocation = mock(async (...[_args, context]: Parameters<MethodDefinition["invoke"]>) => {
			expect(context.identity).toEqual(original);
			expect(Object.isFrozen(context)).toBe(true);
			expect(context.identity).toBe(seen[0]?.[1].identity);
			return "null";
		});
		const events: Parameters<GatewayOptions["audit"]>[0][] = [];
		const { gateway } = setup(
			{
				identity,
				authorize: async (request, context) => {
					seen.push([request, context]);
					expect(Object.isFrozen(request)).toBe(true);
					expect(Object.isFrozen(request.args)).toBe(true);
					expect(Object.isFrozen(context.identity)).toBe(true);
					return true;
				},
				audit: async (event) => {
					events.push(event);
				},
			},
			{ invoke: invocation },
		);
		identity.actorUserId = "changed";
		const request = call(1, { actorUserId: "forged", nested: { runId: "forged" } });
		expect((await gateway.dispatch(request)).ok).toBe(true);
		expect(invocation).toHaveBeenCalledTimes(1);
		expect(seen[0]?.[1].sequence).toBe(1);
		expect(events.map((event) => event.phase)).toEqual(["request", "authorized", "completed"]);
		for (const event of events) {
			expect(event.identity).toEqual(original);
			expect(Object.isFrozen(event)).toBe(true);
			expect(event.requestBytes).toBe(bytes(request));
			expect(event.requestHash).toMatch(/^[a-f0-9]{64}$/);
		}
	});

	test.each([
		"actorUserId",
		"identity",
		"signal",
		"deadlineAt",
	])("rejects extra frame field %s", async (field) => {
		const { gateway, invoke, authorize } = setup();
		expectError(await gateway.dispatch({ ...call(), [field]: "forged" }), "PROTOCOL");
		expect(invoke).not.toHaveBeenCalled();
		expect(authorize).not.toHaveBeenCalled();
	});

	test("rejects non-read registration", () => {
		expect(() => setup({}, { effect: "write" as MethodDefinition["effect"] })).toThrow(
			"Only unique read methods",
		);
	});

	test("copies the read-only registration rather than retaining mutable host definitions", async () => {
		const { gateway, method, invoke } = setup();
		const replacement = mock(async () => "null");
		Object.assign(method, { invoke: replacement, effect: "write" });
		expect(gateway.manifest).toEqual([
			{
				id: "fixture-id",
				name: "fixture",
				methods: [{ name: "lookup", description: "Read a fixture" }],
			},
		]);
		expect((await gateway.dispatch(call())).ok).toBe(true);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(replacement).not.toHaveBeenCalled();
	});

	test.each([
		1, 3,
	])("rejects repeated or skipped sequence %i after the first call", async (sequence) => {
		const { gateway, invoke } = setup();
		expect((await gateway.dispatch(call())).ok).toBe(true);
		expectError(await gateway.dispatch(call(sequence)), "PROTOCOL");
		expectError(await gateway.dispatch(call(2)), "PROTOCOL");
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	test("concurrent dispatch fails closed and does not invoke a second method", async () => {
		const entered = deferred<void>();
		const release = deferred<string>();
		const invoke = mock(async () => {
			entered.resolve();
			return release.promise;
		});
		const { gateway } = setup({}, { invoke });
		const first = gateway.dispatch(call());
		try {
			await promptly(entered.promise);
			expectError(await promptly(gateway.dispatch(call(2))), "CONCURRENT");
			expectError(await promptly(first), "CONCURRENT");
			expect(invoke).toHaveBeenCalledTimes(1);
		} finally {
			release.resolve("null");
		}
	});

	test.each(["deny", "throw"])("authorization %s cannot invoke", async (mode) => {
		const { gateway, invoke } = setup({
			authorize: async () => {
				if (mode === "throw") throw new Error("private authorization details");
				return false;
			},
		});
		const response = await gateway.dispatch(call());
		expectError(response, mode === "deny" ? "DENIED" : "AUTHORIZATION");
		expect(JSON.stringify(response)).not.toContain("private authorization details");
		expect(invoke).not.toHaveBeenCalled();
	});

	test("cancellation during authorization prevents invocation even after authorization succeeds", async () => {
		const entered = deferred<void>();
		const permission = deferred<boolean>();
		const { gateway, controller, invoke } = setup({
			authorize: async () => {
				entered.resolve();
				return permission.promise;
			},
		});
		const response = gateway.dispatch(call());
		try {
			await promptly(entered.promise);
			controller.abort();
			expectError(await promptly(response), "CANCELLED");
		} finally {
			permission.resolve(true);
		}
		await gateway.drained();
		expect(invoke).not.toHaveBeenCalled();
	});

	test.each([
		"request",
		"authorized",
	] as const)("audit failure at %s prevents invocation", async (phase) => {
		const { gateway, invoke } = setup({
			audit: async (event) => {
				if (event.phase === phase) throw new Error("sink unavailable");
			},
		});
		expectError(await gateway.dispatch(call()), "AUDIT_FAILED");
		expect(invoke).not.toHaveBeenCalled();
	});

	test.each([
		"ordinary",
		"programmatic",
	])("nonfatal %s domain errors allow the next request", async (kind) => {
		let attempts = 0;
		const { gateway, onFatal } = setup(
			{},
			{
				invoke: async () => {
					if (attempts++ === 0) {
						if (kind === "programmatic")
							throw new ProgrammaticError("NOT_FOUND", "Missing fixture", false);
						throw new Error("private domain details");
					}
					return "42";
				},
			},
		);
		const response = await gateway.dispatch(call());
		expectError(response, kind === "ordinary" ? "DOMAIN" : "NOT_FOUND", false);
		expect(JSON.stringify(response)).not.toContain("private domain details");
		expect(await gateway.dispatch(call(2))).toMatchObject({ sequence: 2, ok: true, value: 42 });
		expect(onFatal).not.toHaveBeenCalled();
	});

	test("request budget accepts exactly the UTF-16 slot boundary and rejects one byte less", async () => {
		const request = call(1, "small");
		const base = setup();
		const exact = setup({ budgets: { ...base.options.budgets, requestBytes: slotBytes(request) } });
		expect((await exact.gateway.dispatch(request)).ok).toBe(true);
		const short = setup({
			budgets: { ...base.options.budgets, requestBytes: slotBytes(request) - 1 },
		});
		expectError(await short.gateway.dispatch(request), "OUTPUT_LIMIT");
		expect(short.invoke).not.toHaveBeenCalled();
	});

	test("response budget includes the envelope at its exact UTF-16 slot boundary", async () => {
		const output = "x".repeat(200);
		const response: ResponseFrame = {
			type: "response",
			version: 1,
			sequence: 1,
			ok: true,
			value: output,
		};
		const base = setup();
		const exact = setup(
			{ budgets: { ...base.options.budgets, responseBytes: slotBytes(response) } },
			{ invoke: async () => JSON.stringify(output) },
		);
		expect(await exact.gateway.dispatch(call())).toEqual(response);
		const short = setup(
			{ budgets: { ...base.options.budgets, responseBytes: slotBytes(response) - 1 } },
			{ invoke: async () => JSON.stringify(output) },
		);
		expectError(await short.gateway.dispatch(call()), "OUTPUT_LIMIT");
	});

	test("total transfer budget accumulates request and response bytes across calls", async () => {
		const request = call();
		const response: ResponseFrame = {
			type: "response",
			version: 1,
			sequence: 1,
			ok: true,
			value: { answer: 42 },
		};
		const base = setup();
		const oneRound = bytes(request) + bytes(response);
		const { gateway, invoke } = setup({
			budgets: { ...base.options.budgets, transferBytes: oneRound },
		});
		expect(await gateway.dispatch(request)).toEqual(response);
		expect(gateway.stats()).toEqual({
			calls: 1,
			requestBytes: bytes(request),
			responseBytes: bytes(response),
		});
		await expect(gateway.dispatch(call(2))).rejects.toMatchObject({
			code: "TRANSFER_LIMIT",
			fatal: true,
		});
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	test("response transfer overflow closes the gateway", async () => {
		const base = setup();
		const { gateway, onFatal } = setup({
			budgets: { ...base.options.budgets, transferBytes: bytes(call()) + 1 },
		});
		await expect(gateway.dispatch(call())).rejects.toMatchObject({ code: "TRANSFER_LIMIT" });
		expect(onFatal).toHaveBeenCalledTimes(1);
	});

	test("call budget permits its boundary but not another invocation", async () => {
		const base = setup();
		const { gateway, invoke } = setup({ budgets: { ...base.options.budgets, maxCalls: 1 } });
		expect((await gateway.dispatch(call())).ok).toBe(true);
		expectError(await gateway.dispatch(call(2)), "CALL_LIMIT");
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	test.each(["close", "expired", "aborted"])("%s before dispatch cannot invoke", async (mode) => {
		const controller = new AbortController();
		if (mode === "aborted") controller.abort();
		const { gateway, invoke } = setup({
			signal: controller.signal,
			deadlineAt: Date.now() + (mode === "expired" ? -1 : 5000),
		});
		if (mode === "close") {
			gateway.close();
			gateway.close();
		}
		expectError(
			await gateway.dispatch(call()),
			{ close: "CLOSED", expired: "EXPIRED", aborted: "CANCELLED" }[mode] ?? "",
		);
		expect(invoke).not.toHaveBeenCalled();
	});

	test.each([
		"cancel",
		"close",
		"deadline",
	])("%s settles dispatch promptly but drains only after the actual invocation", async (mode) => {
		const entered = deferred<void>();
		const release = deferred<string>();
		let signal: AbortSignal | undefined;
		const { gateway, controller, onFatal } = setup(
			mode === "deadline" ? { deadlineAt: Date.now() + 100 } : {},
			{
				invoke: async (_args, context) => {
					signal = context.signal;
					entered.resolve();
					return release.promise; // Deliberately ignores AbortSignal.
				},
			},
		);
		const response = gateway.dispatch(call());
		let drained = false;
		try {
			await promptly(entered.promise);
			expect(gateway.inFlight).toBe(true);
			if (mode === "cancel") controller.abort();
			if (mode === "close") gateway.close();
			expectError(
				await promptly(response),
				{ cancel: "CANCELLED", close: "CLOSED", deadline: "EXPIRED" }[mode] ?? "",
			);
			void gateway.drained().then(() => {
				drained = true;
			});
			await Promise.resolve();
			expect(signal?.aborted).toBe(true);
			expect(gateway.inFlight).toBe(true);
			expect(drained).toBe(false);
			expect(onFatal).toHaveBeenCalledTimes(1);
		} finally {
			release.resolve("null");
		}
		await promptly(gateway.drained());
		expect(gateway.inFlight).toBe(false);
		expect(drained).toBe(true);
	});
});
