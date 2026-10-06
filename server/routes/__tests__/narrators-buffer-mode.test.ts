import { describe, expect, mock, test } from "bun:test";
import { resolveBufferQueueMode } from "@shared/buffer-queue-mode";
import { Hono } from "hono";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors";
import { updateBufferedMessageModeSchema } from "../../lib/validators/narrators";

// Execute the actual HTTP registrations with injected boundaries, without global module mocks.
const source = await Bun.file(new URL("../narrators.ts", import.meta.url)).text();
function section(start: string, end: string) {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	if (from < 0 || to < 0) throw new Error(`Missing buffer route boundary: ${start}`);
	return source.slice(from, to);
}
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
	[
		section("async function applyPendingBufferModeControl(", "// Changing a queued mode"),
		section('narratorRoutes.patch("/:id/buffer/:mid/mode"', "// Explicit retry"),
		section('narratorRoutes.post("/:id/buffer/:mid/retry"', "// Remove a single"),
		section('narratorRoutes.delete("/:id/buffer/:mid"', "// Reorder queued"),
		section('narratorRoutes.delete("/:id/buffer"', "// Exact-layout"),
	]
		.join("\n")
		.replace(/import\(\s*"\.\.\/services\/[^"]+"\s*\)/g, "Promise.resolve(services)"),
);

type QueueRow = { id: string; state?: "queued" | "failed"; queueMode?: string; priority?: boolean };
function fixture(
	options: {
		rows?: QueueRow[];
		mutation?: boolean;
		child?: boolean;
		claimedAfterRetry?: boolean;
		retryError?: string;
		controlError?: boolean;
		wakeResult?: boolean;
		deliveryError?: AppError;
		deliveryGate?: Promise<void>;
		receiptState?: "claimed" | "materialized";
	} = {},
) {
	let rows = options.rows ?? [{ id: "message", state: "queued", queueMode: "turn" }];
	let locked = false;
	const order: string[] = [];
	const controls: unknown[][] = [];
	const clears: unknown[][] = [];
	const update = mock(async (_id: string, mid: string, mode: string) => {
		expect(locked).toBe(true);
		order.push("mutation");
		if (options.mutation === false || !rows.some((row) => row.id === mid)) return false;
		rows = rows.map((row) => (row.id === mid ? { ...row, queueMode: mode } : row));
		return true;
	});
	const retryMutation = mock(async (_id: string, mid: string) => {
		expect(locked).toBe(true);
		order.push("retry");
		if (options.retryError) throw new Error(options.retryError);
		if (options.mutation === false) return false;
		rows = options.claimedAfterRetry
			? rows.filter((row) => row.id !== mid)
			: rows.map((row) => (row.id === mid ? { ...row, state: "queued" as const } : row));
		return true;
	});
	const authoritativeRead = mock(async () => {
		order.push("read");
		return rows;
	});
	const services = {
		withNarratorStartAdmission: async (_id: string, callback: () => Promise<void>) => {
			locked = true;
			try {
				await callback();
			} finally {
				locked = false;
			}
		},
		applyBufferedQueueModeControl: (...args: unknown[]) => {
			expect(locked).toBe(true);
			// PG safety: failing to supply explicit authority would hit a forbidden sync read.
			if (args[2] === undefined || args[3] === undefined)
				throw new Error("Forbidden sync queue probe");
			expect(options.child).not.toBe(true);
			controls.push(args);
			if (options.controlError) throw new Error("Control failed");
		},
		applySubagentBufferedQueueModeControl: (...args: unknown[]) => {
			expect(locked).toBe(true);
			expect(options.child).toBe(true);
			if (args[2] === undefined || args[3] === undefined)
				throw new Error("Forbidden sync queue probe");
			controls.push(args);
		},
		readBufferedMessageDeliveryReceipt: async () =>
			options.receiptState
				? {
						id: "message",
						state: options.receiptState,
						recipientMessageId: "delivered-user",
						lastError: null,
					}
				: undefined,
		waitForBufferedMessageDelivery: async () => {
			expect(locked).toBe(false);
			order.push("delivery");
			await options.deliveryGate;
			if (options.deliveryError) throw options.deliveryError;
			return { delivered: true, messageId: "delivered-user" };
		},
		wakeInboxIfEligible: async () => {
			expect(locked).toBe(false);
			order.push("wake");
			return options.wakeResult ?? false; // Busy owners leave delivery to their finalizer.
		},

		removeSubagentBufferedMessage: async (_id: string, mid: string) => {
			rows = rows.filter((row) => row.id !== mid);
			return true;
		},
		clearSubagentBufferedMessages: async () => {
			rows = [];
		},
	};
	const routes = new Hono();
	const bindings = {
		narratorRoutes: routes,
		services,
		AppError,
		NotFoundError,
		ValidationError,
		updateBufferedMessageModeSchema,
		resolveBufferQueueMode,
		updateBufferedMessageMode: update,
		retryBufferedMessage: retryMutation,
		getBufferedMessagesAsync: authoritativeRead,
		narratorService: { getById: async () => ({ variant: options.child ? "subagent" : "primary" }) },
		isSubagentVariant: (variant: string) => variant === "subagent",
		clearBufferedMessageSoftStopIfIdle: (...args: unknown[]) => {
			if (args[1] === undefined) throw new Error("Forbidden sync queue probe");
			clears.push(args);
		},
		broadcastBufferQueue: async () => {
			expect(locked).toBe(false);
			order.push("broadcast");
		},
	};
	new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
	routes.onError((error, c) =>
		c.json({ error: error.message }, error instanceof AppError ? (error.statusCode as 400) : 500),
	);
	return {
		controls,
		clears,
		order,
		update,
		retryMutation,
		rows: () => rows,
		authoritativeRead,
		retry: () => routes.request("/session/buffer/message/retry", { method: "POST" }),
		mode: (body: unknown = { mode: "tool" }) =>
			routes.request("/session/buffer/message/mode", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		remove: () => routes.request("/session/buffer/message", { method: "DELETE" }),
		clear: () => routes.request("/session/buffer", { method: "DELETE" }),
	};
}

describe("buffer retry HTTP mutation", () => {
	test("selected failed urgent retry is promoted under admission before cancellation or delivery", async () => {
		const f = fixture({
			rows: [
				{ id: "newer-urgent", state: "queued", queueMode: "interrupt" },
				{ id: "message", state: "failed", queueMode: "interrupt" },
			],
		});
		expect((await f.retry()).status).toBe(200);
		expect(f.update).toHaveBeenCalledWith("session", "message", "interrupt");
		expect(f.order).toEqual(["read", "retry", "mutation", "read", "delivery", "broadcast"]);
		expect(f.controls).toEqual([["session", "interrupt", true, true]]);
	});
	test("lost urgent retry promotion without a valid claim receipt is conflict, not false delivery", async () => {
		const f = fixture({
			claimedAfterRetry: true,
			rows: [{ id: "message", state: "failed", queueMode: "interrupt" }],
		});
		expect((await f.retry()).status).toBe(409);
		expect(f.controls).toEqual([]);
		expect(f.order).toEqual(["read", "retry", "mutation"]);
	});
	test("already materialized retry confirms receipt without cancelling the fresh owner", async () => {
		const f = fixture({
			claimedAfterRetry: true,
			receiptState: "materialized",
			rows: [{ id: "message", state: "failed", queueMode: "interrupt" }],
		});
		expect(await (await f.retry()).json()).toMatchObject({ ok: true, delivered: true });
		expect(f.controls).toEqual([]);
		expect(f.order).toEqual(["read", "retry", "mutation", "delivery", "broadcast"]);
	});
	for (const mode of ["tool", "interrupt", "turn"] as const) {
		test(`busy primary retry restores ${mode} controls with PostgreSQL-safe authority`, async () => {
			const f = fixture({
				rows: [
					{ id: "earlier", state: "queued", queueMode: "turn" },
					{ id: "message", state: "failed", queueMode: mode },
				],
			});
			const response = await f.retry();
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(
				mode === "interrupt"
					? { ok: true, resumed: true, delivered: true, messageId: "delivered-user" }
					: { ok: true, resumed: false },
			);
			expect(f.controls).toEqual([["session", mode, mode !== "turn", true]]);
			expect(f.order).toEqual([
				"read",
				"retry",
				...(mode === "interrupt" ? ["mutation"] : []),
				"read",
				mode === "interrupt" ? "delivery" : "wake",
				"broadcast",
			]);
			expect(f.rows().map((row) => row.id)).toEqual(["earlier", "message"]);
		});
	}
	test("busy child retries legacy urgent mode via child tool controls", async () => {
		const f = fixture({ child: true, rows: [{ id: "message", state: "failed", priority: true }] });
		expect((await f.retry()).status).toBe(200);
		expect(f.controls).toEqual([["session", "tool", true, true]]);
	});
	test("busy child interrupt retry signals the child instead of primary execution", async () => {
		const f = fixture({
			child: true,
			rows: [{ id: "message", state: "failed", queueMode: "interrupt" }],
		});
		expect((await f.retry()).status).toBe(200);
		expect(f.controls).toEqual([["session", "interrupt", true, true]]);
	});
	test("instant claim after retry must not interrupt the new signal owner", async () => {
		const f = fixture({
			claimedAfterRetry: true,
			receiptState: "claimed",
			rows: [{ id: "message", state: "failed", queueMode: "interrupt" }],
		});
		expect((await f.retry()).status).toBe(200);
		expect(f.controls).toEqual([]);
		expect(f.order).toEqual(["read", "retry", "mutation", "delivery", "broadcast"]);
	});
	test("ordinary retry preserves another queued guidance signal, excluding failed guidance", async () => {
		for (const state of ["queued", "failed"] as const) {
			const f = fixture({
				rows: [
					{ id: "message", state: "failed", queueMode: "turn" },
					{ id: "other", state, queueMode: "tool" },
				],
			});
			expect((await f.retry()).status).toBe(200);
			expect(f.controls).toEqual([["session", "turn", state === "queued", true]]);
		}
	});
	test("failed payload validation does not signal, wake or alter the durable row", async () => {
		const f = fixture({
			retryError: "Attachment missing",
			rows: [{ id: "message", state: "failed" }],
		});
		const response = await f.retry();
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Attachment missing" });
		expect(f.controls).toEqual([]);
		expect(f.rows()[0]?.state).toBe("failed");
	});
	test("a post-commit control error leaves the payload queued without a second retry", async () => {
		const f = fixture({
			controlError: true,
			rows: [{ id: "message", state: "failed", queueMode: "tool" }],
		});
		expect((await f.retry()).status).toBe(500);
		expect(f.retryMutation).toHaveBeenCalledTimes(1);
		expect(f.rows()[0]?.state).toBe("queued");
	});
	test("nonfailed or missing retry target is rejected without controls", async () => {
		const f = fixture({ mutation: false });
		expect((await f.retry()).status).toBe(400);
		expect(f.controls).toEqual([]);
	});
});

describe("buffer mode HTTP mutation", () => {
	test("interrupt acknowledgement waits for materialization after releasing admission", async () => {
		const gate = Promise.withResolvers<void>();
		const f = fixture({ deliveryGate: gate.promise });
		let responded = false;
		const pending = Promise.resolve(f.mode({ mode: "interrupt" })).then((response) => {
			responded = true;
			return response;
		});
		await Bun.sleep(10);
		expect(responded).toBe(false);
		expect(f.order).toEqual(["mutation", "read", "delivery"]);
		gate.resolve();
		expect(await (await pending).json()).toEqual({
			ok: true,
			delivered: true,
			messageId: "delivered-user",
		});
	});
	for (const status of [409, 499, 504]) {
		test(`interrupt delivery failure ${status} preserves durable input and publishes it`, async () => {
			const f = fixture({ deliveryError: new AppError("not delivered", status, "DELIVERY_ERROR") });
			const response = await f.mode({ mode: "interrupt" });
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({ error: "not delivered" });
			expect(f.rows()).toEqual([{ id: "message", state: "queued", queueMode: "interrupt" }]);
			expect(f.retryMutation).not.toHaveBeenCalled();
			expect(f.controls).toHaveLength(1);
			expect(f.order).toEqual(["mutation", "read", "delivery", "broadcast"]);
		});
	}
	for (const receiptState of ["claimed", "materialized"] as const) {
		test(`concurrent urgent ${receiptState} request confirms receipt without cancelling a new owner`, async () => {
			const f = fixture({ mutation: false, receiptState });
			const response = await f.mode({ mode: "interrupt" });
			expect(await response.json()).toEqual({
				ok: true,
				delivered: true,
				messageId: "delivered-user",
			});
			expect(f.controls).toEqual([]);
		});
	}
	for (const mode of ["tool", "interrupt"] as const) {
		for (const wakeResult of [true, false]) {
			test(`${wakeResult ? "idle" : "busy"} queued ${mode} mode wakes after admission unlock`, async () => {
				const f = fixture({ wakeResult });
				const response = await f.mode({ mode });
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual(
					mode === "interrupt"
						? { ok: true, delivered: true, messageId: "delivered-user" }
						: { ok: true },
				);
				expect(f.controls).toEqual([["session", mode, true, true]]);
				expect(f.order).toEqual([
					"mutation",
					"read",
					mode === "interrupt" ? "delivery" : "wake",
					"broadcast",
				]);
			});
		}
	}
	test("queued turn mode never wakes even with an idle owner", async () => {
		const f = fixture({ wakeResult: true });
		expect((await f.mode({ mode: "turn" })).status).toBe(200);
		expect(f.controls).toEqual([["session", "turn", false, true]]);
		expect(f.order).toEqual(["mutation", "read", "broadcast"]);
	});
	test("claimed, consumed or missing target yields conflict without controls or broadcast", async () => {
		const f = fixture({ mutation: false });
		expect((await f.mode()).status).toBe(409);
		expect(f.controls).toEqual([]);
		expect(f.order).toEqual(["mutation"]);
	});
	for (const mode of ["tool", "interrupt", "turn"] as const) {
		test(`failed ${mode} mode changes metadata without cancellation, retry or wake`, async () => {
			const f = fixture({
				wakeResult: true,
				rows: [{ id: "message", state: "failed", queueMode: "turn" }],
			});
			expect((await f.mode({ mode })).status).toBe(200);
			expect(f.controls).toEqual([["session", mode, false, false]]);
			expect(f.order).toEqual(["mutation", "read", "broadcast"]);
			expect(f.retryMutation).not.toHaveBeenCalled();
			expect(f.rows()).toEqual([{ id: "message", state: "failed", queueMode: mode }]);
		});
	}
	test("downgrade preserves other queued guidance but ignores failed guidance", async () => {
		for (const state of ["queued", "failed"] as const) {
			const f = fixture({
				rows: [
					{ id: "message", state: "queued", queueMode: "interrupt" },
					{ id: "other", state, priority: true },
				],
			});
			expect((await f.mode({ mode: "turn" })).status).toBe(200);
			expect(f.controls).toEqual([["session", "turn", state === "queued", true]]);
		}
	});
	test("child controls receive the same queued authority", async () => {
		const f = fixture({ child: true });
		expect((await f.mode()).status).toBe(200);
		expect(f.controls).toEqual([["session", "tool", true, true]]);
	});
	test("invalid modes fail before mutation", async () => {
		const f = fixture();
		expect((await f.mode({ mode: "urgent" })).status).toBe(400);
		expect(f.update).not.toHaveBeenCalled();
	});
	test("delete and clear pass authoritative remaining guidance, avoiding PG sync reads", async () => {
		const f = fixture({
			rows: [
				{ id: "message", state: "queued", queueMode: "tool" },
				{ id: "ordinary", state: "queued", queueMode: "turn" },
				{ id: "failed", state: "failed", queueMode: "interrupt" },
			],
		});
		expect((await f.remove()).status).toBe(200);
		expect(f.clears).toEqual([["session", false]]);
		expect((await f.clear()).status).toBe(200);
		expect(f.clears).toEqual([
			["session", false],
			["session", false],
		]);
	});
});
