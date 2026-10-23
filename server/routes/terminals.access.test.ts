import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../lib/errors";

let role: "admin" | "user" = "user";
let allowedRead = true;
let allowedWrite = true;
let attached = true;
let hold: Promise<void> | undefined;
const record = {
	id: "old",
	narratorId: "n",
	deviceId: "original-device",
	cwd: "/original/selected",
	status: "running",
	name: "Old terminal",
};
const authorize = mock(
	async (_id: string, principal: { userId: string; isAdmin: boolean }, need: string) => {
		await hold;
		if (principal.userId !== "actor" || (need === "read" ? !allowedRead : !allowedWrite))
			throw new AppError("denied original endpoint", 403, "TERMINAL_PATH_DENIED");
		return record;
	},
);
const ensureAttached = mock(async (_id: string) => {});
const scrollback = mock(async (_id: string) => ({ data: "original-output", cols: 80, rows: 24 }));
const write = mock((_id: string, _data: string) => {});
const resize = mock((_id: string, _cols: number, _rows: number) => {});
const kill = mock(async (_id: string) => {});
const rename = mock(async (_id: string, _name: string) => {});
const processes = mock(async (_id: string) => []);
const list = mock(async (_id: string) => [record]);
mock.module("../db", () => ({ db: { query: { users: { findFirst: async () => ({ role }) } } } }));
mock.module("../lib/narrator-access", () => ({
	narratorPrincipalOf: (c: { get: (key: string) => { sub: string } }) => ({
		userId: c.get("user").sub,
		isAdmin: true,
	}),
}));
mock.module("../services/narrator-acl", () => ({
	loadNarratorForAccess: async () => ({ id: "n" }),
}));
mock.module("../services/project-acl", () => ({ assertChapterProjectAccess: async () => {} }));
mock.module("../services/terminal-service", () => ({
	terminalService: {
		authorizeTargetAccess: authorize,
		ensureAttached,
		getScrollback: scrollback,
		isAttached: () => attached,
		getBufferState: () => ({ mouseTracking: false, cursorVisible: true }),
		write,
		resize,
		kill,
		rename,
		getProcesses: processes,
		getById: async () => record,
		listByNarrator: list,
		listByChapter: list,
		create: async (opts: Record<string, unknown>) => ({ ...record, ...opts }),
	},
}));
mock.module("../services/terminal-view-service", () => ({
	terminalViewService: { get: async () => null, upsert: async () => ({}) },
}));
const { terminalRoutes } = await import("./terminals");
const { handleTerminalWS, sendToTerminal } = await import("../websocket/terminal-ws");
function app() {
	const value = new Hono();
	value.use("*", async (c, next) => {
		c.set("user", { sub: "actor", role: "admin", iat: 0, exp: 9999999999 });
		await next();
	});
	value.onError(
		(error) =>
			new Response(JSON.stringify({ code: error instanceof AppError ? error.code : "ERROR" }), {
				status: error instanceof AppError ? error.statusCode : 500,
			}),
	);
	value.route("/terminals", terminalRoutes);
	return value;
}
function socket() {
	const frames: Array<{ type: string; terminalId?: string; data?: string }> = [];
	const ws = {
		data: {
			sessionUserId: "actor",
			userRole: "admin",
			subscribedTerminals: new Set<string>(),
			lastPongAt: 0,
		},
		send: (payload: string) => frames.push(JSON.parse(payload)),
		getBufferedAmount: () => 0,
		close: () => {},
	} as unknown as Parameters<typeof handleTerminalWS.message>[0];
	handleTerminalWS.open(ws);
	return { ws, frames };
}
const sockets: Array<ReturnType<typeof socket>> = [];
beforeEach(() => {
	role = "user";
	allowedRead = true;
	allowedWrite = true;
	attached = true;
	record.deviceId = "original-device";
	hold = undefined;
	for (const fn of [
		authorize,
		ensureAttached,
		scrollback,
		write,
		resize,
		kill,
		rename,
		processes,
		list,
	])
		fn.mockClear();
});
afterEach(() => {
	for (const { ws } of sockets.splice(0)) handleTerminalWS.close(ws);
});
describe("production Terminal HTTP authorization", () => {
	for (const [suffix, method, need] of [
		["", "GET", "read"],
		["/processes", "GET", "read"],
		["", "PATCH", "write"],
		["", "DELETE", "write"],
	] as const) {
		test(`${method} by-id${suffix} denies before the operation and refreshes role`, async () => {
			allowedRead = false;
			allowedWrite = false;
			const response = await app().request(`/terminals/old${suffix}`, {
				method,
				...(method === "PATCH"
					? {
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ name: "new" }),
						}
					: {}),
			});
			expect(response.status).toBe(403);
			expect(authorize).toHaveBeenCalledWith("old", { userId: "actor", isAdmin: false }, need);
			expect(processes).not.toHaveBeenCalled();
			expect(kill).not.toHaveBeenCalled();
			expect(rename).not.toHaveBeenCalled();
		});
	}
	test("authorized detail preserves original device/cwd and list omits denied old endpoints", async () => {
		const detail = await app().request("/terminals/old");
		expect(await detail.json()).toMatchObject(record);
		allowedRead = false;
		const response = await app().request("/terminals?narratorId=n");
		expect(await response.json()).toEqual([]);
		expect(scrollback).not.toHaveBeenCalled();
	});
});
describe("production Terminal WS authorization", () => {
	test("denied subscribe sends no scrollback, attach or membership", async () => {
		const s = socket();
		sockets.push(s);
		allowedRead = false;
		await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: ["old"] });
		expect(s.ws.data.subscribedTerminals.has("old")).toBe(false);
		expect(scrollback).not.toHaveBeenCalled();
		expect(ensureAttached).not.toHaveBeenCalled();
		expect(s.frames[0]?.type).toBe("error");
	});
	test("a read-only observer cannot start a detached shell through subscribe", async () => {
		const s = socket();
		sockets.push(s);
		attached = false;
		record.deviceId = "local"; // This branch can start a shell through local reattachment.
		allowedWrite = false;
		await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: ["old"] });
		expect(ensureAttached).not.toHaveBeenCalled();
		expect(scrollback).not.toHaveBeenCalled();
	});
	test("unsubscribe during authorization prevents late replay or subscription", async () => {
		const s = socket();
		sockets.push(s);
		let release = () => {};
		hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: ["old"] });
		await Promise.resolve();
		await handleTerminalWS.message(s.ws, { type: "unsubscribe", terminalIds: ["old"] });
		release();
		await pending;
		expect(scrollback).not.toHaveBeenCalled();
		expect(s.ws.data.subscribedTerminals.has("old")).toBe(false);
	});
	test("input/resize/rename/kill require original endpoint write authority with live DB role", async () => {
		const s = socket();
		sockets.push(s);
		await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: ["old"] });
		for (const message of [
			{ type: "input", terminalId: "old", data: "command" },
			{ type: "resize", terminalId: "old", cols: 90, rows: 25 },
			{ type: "rename", terminalId: "old", name: "new" },
			{ type: "kill", terminalId: "old" },
		]) {
			allowedWrite = false;
			s.ws.data.subscribedTerminals.add("old");
			await handleTerminalWS.message(s.ws, message);
		}
		expect(write).not.toHaveBeenCalled();
		expect(resize).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect(rename).not.toHaveBeenCalled();
		expect(
			authorize.mock.calls
				.filter((call) => call[2] === "write")
				.every((call) => call[1].isAdmin === false),
		).toBe(true);
	});
	test("revocation between chunks removes the subscriber before output delivery", async () => {
		const s = socket();
		sockets.push(s);
		await handleTerminalWS.message(s.ws, { type: "subscribe", terminalIds: ["old"] });
		s.frames.length = 0;
		allowedRead = false;
		sendToTerminal("old", { type: "output", terminalId: "old", data: "must-not-leak" });
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(s.frames.some((frame) => frame.type === "output")).toBe(false);
		expect(s.ws.data.subscribedTerminals.has("old")).toBe(false);
	});
});
