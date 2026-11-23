import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { logger } from "../../lib/logger";
import {
	beginReadFanoutSpan,
	finishReadFanoutSpan,
	resetReadFanoutDiagnosticsForTest,
	startReadFanoutCapture,
	stopReadFanoutCapture,
} from "../../lib/read-fanout-diagnostics";
import { handleNarratorWS } from "../narrator-ws";
import { type WSData, waitForWebSocketActivityDrain, wsHandlers } from "../ws-handler";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(resetReadFanoutDiagnosticsForTest);

describe("WS message boundary read scope", () => {
	test("actual handler Promise keeps scope alive after the synchronous message boundary returns", async () => {
		const gate = deferred();
		const sent: string[] = [];
		const socket = {
			data: { channel: "narrator", userId: "private-user" },
			send: (message: string) => sent.push(message),
		} as unknown as ServerWebSocket<WSData>;
		const handler = spyOn(handleNarratorWS, "message").mockImplementation(async () => {
			await gate.promise;
			const span = beginReadFanoutSpan("logical");
			finishReadFanoutSpan(span);
		});
		const capture = startReadFanoutCapture();
		try {
			expect(
				wsHandlers.message(
					socket,
					JSON.stringify({
						type: "subscribe",
						narratorId: "private-narrator",
						token: "private-token",
					}),
				),
			).toBeUndefined();
			expect(handler).toHaveBeenCalledTimes(1);
			gate.resolve();
			await waitForWebSocketActivityDrain();
			const report = stopReadFanoutCapture(capture.captureId);
			expect(
				report.sources.find((row) => row.source === "WS narrator subscribe")?.counts.logicalReads,
			).toBe(1);
			expect(report.totals).toMatchObject({
				scopesStarted: 1,
				scopesCompleted: 1,
				scopesUnfinished: 0,
			});
			expect(report.sources.find((row) => row.source === "detached")).toBeUndefined();
			for (const secret of ["private-user", "private-narrator", "private-token"])
				expect(JSON.stringify(report)).not.toContain(secret);
			expect(sent).toHaveLength(0);
		} finally {
			gate.resolve();
			await waitForWebSocketActivityDrain();
			handler.mockRestore();
		}
	});

	test("unrecognized types have one fixed bucket and existing rejection handling is preserved", async () => {
		const gate = deferred();
		const sent: string[] = [];
		const socket = {
			data: { channel: "narrator" },
			send: (message: string) => sent.push(message),
		} as unknown as ServerWebSocket<WSData>;
		const failure = new Error("fixture handler failed");
		const handler = spyOn(handleNarratorWS, "message").mockImplementation(async () => {
			await gate.promise;
			const span = beginReadFanoutSpan("logical");
			finishReadFanoutSpan(span);
			throw failure;
		});
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		const capture = startReadFanoutCapture();
		try {
			wsHandlers.message(
				socket,
				JSON.stringify({ type: "private-type", content: "private-content" }),
			);
			gate.resolve();
			await waitForWebSocketActivityDrain();
			expect(sent.map((value) => JSON.parse(value))).toEqual([
				{ type: "error", message: "Internal error" },
			]);
			expect(warning).toHaveBeenCalledTimes(1);
			const report = stopReadFanoutCapture(capture.captureId);
			expect(
				report.sources.find((row) => row.source === "WS narrator unknown")?.counts.logicalReads,
			).toBe(1);
			expect(report.totals.scopesCompleted).toBe(1);
			expect(JSON.stringify(report)).not.toContain("private-type");
			expect(JSON.stringify(report)).not.toContain("private-content");
		} finally {
			gate.resolve();
			await waitForWebSocketActivityDrain();
			handler.mockRestore();
			warning.mockRestore();
		}
	});
});
