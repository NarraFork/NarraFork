import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	capturePlannedUpdateRecoverySnapshot,
	getUpdateCoordinationStatus,
	resetUpdateCoordinationForTests,
	scheduleUpdate,
} from "../../services/update-coordinator";
import {
	canOperatorShutdown,
	registerOperatorShutdownHandler,
	scheduleOperatorShutdown,
} from "../server-restart";
import { preservesRecoveryOnShutdown } from "../shutdown-activity";
import { createSystemLifecycle } from "../system-lifecycle";

afterEach(() => {
	registerOperatorShutdownHandler(null);
	resetUpdateCoordinationForTests();
});

describe("operator shutdown admission", () => {
	test("a queued legacy shutdown owns its grace window and blocks system preparation", async () => {
		const handler = mock(async ({ reason }: { reason: string }) => ({
			success: true,
			reason,
			pid: process.pid,
			durationMs: 0,
		}));
		registerOperatorShutdownHandler(handler);
		expect(canOperatorShutdown()).toBe(true);
		expect(scheduleOperatorShutdown({ reason: "operator_requested" })).toBe(true);
		expect(canOperatorShutdown()).toBe(false);
		expect(scheduleOperatorShutdown({ reason: "system_prepared_shutdown" })).toBe(false);
		const lifecycle = createSystemLifecycle({
			coordination: getUpdateCoordinationStatus,
			canShutdown: canOperatorShutdown,
			schedule: () => scheduleUpdate(undefined, "system_shutdown"),
			drain: async () => capturePlannedUpdateRecoverySnapshot(),
			persist: () => {
				throw new Error("must not checkpoint");
			},
			assertNotCancelled: () => {},
			markClosing: () => {},
			shutdown: () => scheduleOperatorShutdown({ reason: "system_prepared_shutdown" }),
			cancel: () => {},
			cleanup: async () => {},
			isCancellation: () => false,
		});
		expect(lifecycle.prepare().success).toBe(false);
		expect(lifecycle.shutdown().success).toBe(false);
		expect(getUpdateCoordinationStatus().scheduled).toBe(false);
		await Bun.sleep(350);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith({ reason: "operator_requested" });
	});

	test("only checkpoint-backed shutdown reasons preserve processes and browser sessions", () => {
		expect(preservesRecoveryOnShutdown("system_prepared_shutdown")).toBe(true);
		expect(preservesRecoveryOnShutdown("replacement_started")).toBe(true);
		expect(preservesRecoveryOnShutdown("operator_requested")).toBe(false);
		expect(preservesRecoveryOnShutdown("signal")).toBe(false);
	});
});
