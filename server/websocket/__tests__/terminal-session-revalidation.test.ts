import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { SessionPayload } from "../../lib/auth";
import type { AuthReadOptions } from "../../lib/auth-read-admission";

// Keep the real WS/session/terminal coordination, with no database, PTY or server runtime.
const live: SessionPayload = { sub: "user", role: "user", iat: 1, exp: 9_999_999_999 };
const read = mock(
	async (_id: string, _options?: AuthReadOptions): Promise<SessionPayload | null> => live,
);
const access = mock(
	async (_id: string, principal: { userId: string; isAdmin: boolean }) => principal.isAdmin,
);
mock.module("../../lib/auth", () => ({ resolveLiveSession: read }));
mock.module("../../services/terminal-access", () => ({
	terminalAccessAllowed: access,
	narratorTerminalAccessAllowed: async () => false,
	rememberStandaloneTerminalCreator: () => {},
}));
mock.module("../../services/terminal-service", () => ({ terminalService: {} }));
mock.module("../../lib/validators", () => ({ terminalWsMessageSchema: {} }));
mock.module("../../lib/logger", () => ({ logger: { debug() {}, warn() {}, error() {} } }));
mock.module("../../lib/agent/execution/rpc-types", () => ({ isChunkFrame: () => false }));
mock.module("../../lib/read-fanout-diagnostics", () => ({
	runReadFanoutWebSocketScope: (_channel: unknown, _type: unknown, work: () => unknown) => work(),
}));
mock.module("../../lib/sql-trace", () => ({
	currentSqlTraceSpan: () => undefined,
	runInSqlTraceSpan: (_span: unknown, work: () => unknown) => work(),
	startSqlTraceSpan: () => undefined,
}));
mock.module("../../services/device-connection-service", () => ({
	getDeviceConnections: () => new Set(),
	handleDeviceWS: {},
}));
mock.module("../narrator-ws", () => ({
	getNarratorConnections: () => new Set(),
	handleNarratorWS: { close() {} },
}));
mock.module("../external-narrator-ws", () => ({
	handleExternalNarratorWS: {},
	rejectOversizedExternalNarratorFrame: () => false,
}));
mock.module("../oauth-connection-registry", () => ({
	closeAllExternalNarratorConnections() {},
	closeExternalNarratorConnectionForAuthLoss() {},
	getExternalNarratorConnections: () => new Set(),
	sendExternalNarratorFrame: () => true,
}));
mock.module("../outline-live-ws", () => ({ drainOutlineLive() {}, handleOutlineLiveBinary() {} }));
mock.module("../vnet-ws", () => ({ getVNetConnections: () => new Set(), handleVNetWS: {} }));

const { eventBus } = await import("../../lib/event-bus");
const { revalidateSessionSockets, startHeartbeat, stopHeartbeat } = await import("../ws-handler");
const {
	dropUnauthorizedTerminalSubscriptions,
	handleTerminalWS,
	sendToTerminal,
	settleTerminalAccessSweep,
} = await import("../terminal-ws");
type Socket = Parameters<typeof handleTerminalWS.open>[0];

function gate<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const sockets: Socket[] = [];
function socket() {
	const ws = {
		readyState: 1,
		data: {
			channel: "terminal" as const,
			connectedAt: 1,
			lastPongAt: Date.now(),
			userId: "user",
			userRole: "admin",
			sessionUserId: "user",
			sessionId: "session",
			sessionExp: 1,
			subscribedTerminals: new Set(["shell"]),
		},
		send: mock((_payload: string) => 0),
		close: mock((_code: number, _reason: string) => {}),
	};
	const connection = ws as unknown as Socket;
	sockets.push(connection);
	return { ws, connection };
}

beforeEach(() => {
	read.mockReset();
	read.mockResolvedValue(live);
	access.mockReset();
	access.mockImplementation(async (_id, principal) => principal.isAdmin);
	startHeartbeat();
});
afterEach(async () => {
	stopHeartbeat();
	for (const ws of sockets.splice(0)) handleTerminalWS.close(ws);
	await settleTerminalAccessSweep();
	await revalidateSessionSockets([]);
});
afterAll(() => mock.restore());

test("the common session apply refreshes terminal roles and awaits subscription authorization", async () => {
	const entered = gate<void>();
	const verdict = gate<boolean>();
	access.mockImplementationOnce(async () => {
		entered.resolve();
		return verdict.promise;
	});
	const { ws, connection } = socket();
	const first = revalidateSessionSockets([connection]);
	await entered.promise;
	expect(ws.data.userRole).toBe("user");
	expect(revalidateSessionSockets([connection])).toBe(first);
	expect(read).toHaveBeenCalledTimes(1);
	verdict.resolve(false);
	await first;
	expect(ws.data.subscribedTerminals.size).toBe(0);
	expect(ws.close).not.toHaveBeenCalled();
});

test("auth changed directly invalidates terminal roles and subscriptions without an outer socket call", async () => {
	const { ws, connection } = socket();
	handleTerminalWS.open(connection);
	eventBus.emit({ type: "auth:changed", userId: "user" });
	await revalidateSessionSockets([]);
	await settleTerminalAccessSweep();
	expect(read).toHaveBeenCalledTimes(1);
	expect(ws.data.userRole).toBe("user");
	expect(access.mock.calls.some(([, principal]) => !principal.isAdmin)).toBe(true);
	expect(ws.data.subscribedTerminals.size).toBe(0);
	expect(ws.close).not.toHaveBeenCalled();
});

for (const fails of [false, true]) {
	test(`an old ${fails ? "failed" : "denied"} terminal verdict cannot cross an auth epoch or reach a new socket`, async () => {
		const entered = gate<void>();
		const verdict = gate<boolean>();
		access.mockImplementationOnce(async () => {
			entered.resolve();
			return verdict.promise;
		});
		access.mockResolvedValue(true);
		const a = socket();
		const first = revalidateSessionSockets([a.connection]);
		await entered.promise;
		eventBus.emit({ type: "auth:changed", userId: "user" });
		const b = socket();
		b.ws.data.userRole = "user";
		expect(revalidateSessionSockets([b.connection])).toBe(first);
		if (fails) verdict.reject(new Error("old query failed"));
		else verdict.resolve(false);
		await first;
		expect(read).toHaveBeenCalledTimes(2);
		expect(access).toHaveBeenCalledTimes(3);
		for (const { ws } of [a, b]) {
			expect(ws.data.userRole).toBe("user");
			expect(ws.data.subscribedTerminals.has("shell")).toBe(true);
			expect(ws.send).not.toHaveBeenCalled();
			expect(ws.close).not.toHaveBeenCalled();
		}
	});
}

for (const change of [
	"session",
	"user",
	"principal",
	"role",
	"data",
	"subscriptions",
	"closed",
	"stop",
	"restart",
]) {
	test(`a slow terminal denial cannot affect a changed ${change} target`, async () => {
		const entered = gate<void>();
		const verdict = gate<boolean>();
		access.mockImplementationOnce(async () => {
			entered.resolve();
			return verdict.promise;
		});
		const { ws, connection } = socket();
		const first = revalidateSessionSockets([connection]);
		await entered.promise;
		if (change === "session") ws.data.sessionId = "replacement";
		if (change === "user") ws.data.sessionUserId = "replacement";
		if (change === "principal") ws.data.userId = "replacement";
		if (change === "role") ws.data.userRole = "admin";
		if (change === "data") ws.data = { ...ws.data };
		if (change === "subscriptions") ws.data.subscribedTerminals = new Set(["shell"]);
		if (change === "closed") ws.readyState = 3;
		if (change === "stop" || change === "restart") stopHeartbeat();
		if (change === "restart") startHeartbeat();
		verdict.resolve(false);
		await first;
		expect(ws.data.subscribedTerminals.has("shell")).toBe(true);
		expect(ws.send).not.toHaveBeenCalled();
		expect(ws.close).not.toHaveBeenCalled();
	});
}

test("invalidation during terminal authorization suppresses the shared old role for the next socket", async () => {
	const entered = gate<void>();
	const verdict = gate<boolean>();
	read.mockResolvedValueOnce({ ...live, role: "admin" });
	access.mockImplementationOnce(async () => {
		entered.resolve();
		return verdict.promise;
	});
	access.mockResolvedValue(true);
	const a = socket();
	const b = socket();
	b.ws.data.userRole = "user";
	const first = revalidateSessionSockets([a.connection, b.connection]);
	await entered.promise;
	eventBus.emit({ type: "auth:changed", userId: "user" });
	verdict.resolve(false);
	await first;
	expect(read).toHaveBeenCalledTimes(2);
	expect(access.mock.calls.map(([, principal]) => principal.isAdmin)).toEqual([true, false, false]);
	expect([a.ws.data.userRole, b.ws.data.userRole]).toEqual(["user", "user"]);
	expect([a.ws.data.subscribedTerminals.size, b.ws.data.subscribedTerminals.size]).toEqual([1, 1]);
});

test("an invalid completion guard dispatches no terminal access queries", async () => {
	const { ws, connection } = socket();
	expect(await dropUnauthorizedTerminalSubscriptions([connection], () => false)).toBe(0);
	expect(access).not.toHaveBeenCalled();
	expect(ws.data.subscribedTerminals.has("shell")).toBe(true);
});

test("global sweeps also discard a late denial under an old terminal role", async () => {
	const verdict = gate<boolean>();
	access.mockImplementationOnce(() => verdict.promise);
	const { ws, connection } = socket();
	ws.data.userRole = "user";
	const first = dropUnauthorizedTerminalSubscriptions([connection]);
	ws.data.userRole = "admin";
	verdict.resolve(false);
	expect(await first).toBe(0);
	expect(ws.data.subscribedTerminals.has("shell")).toBe(true);
	expect(ws.send).not.toHaveBeenCalled();
});

test("a current subscription query failure stops that terminal output and preserves the socket", async () => {
	access.mockRejectedValue(new Error("query unavailable"));
	const { ws, connection } = socket();
	handleTerminalWS.open(connection);
	await revalidateSessionSockets([connection]);
	expect(ws.data.subscribedTerminals.size).toBe(0);
	expect(ws.send).toHaveBeenCalledTimes(1);
	expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({ code: "TERMINAL_NOT_FOUND" });
	ws.send.mockClear();
	sendToTerminal("shell", { type: "output", terminalId: "shell", data: "private output" });
	expect(ws.send).not.toHaveBeenCalled();
	expect(ws.close).not.toHaveBeenCalled();
});

for (const terminalVerdict of ["allowed", "denied", "failed"]) {
	test(`a session storage failure still checks every terminal subscription when its query ${terminalVerdict}`, async () => {
		read.mockRejectedValue(new Error("session store unavailable"));
		if (terminalVerdict === "failed") access.mockRejectedValue(new Error("terminal query failed"));
		else access.mockResolvedValue(terminalVerdict === "allowed");
		const a = socket();
		const b = socket();
		await revalidateSessionSockets([a.connection, b.connection]);
		expect(read).toHaveBeenCalledTimes(1);
		expect(access).toHaveBeenCalledTimes(2);
		for (const { ws } of [a, b]) {
			expect(ws.data.userRole).toBe("admin");
			expect(ws.data.sessionExp).toBe(1);
			expect(ws.data.subscribedTerminals.has("shell")).toBe(terminalVerdict === "allowed");
			expect(ws.close).not.toHaveBeenCalled();
		}
	});
}

for (const change of ["epoch", "session", "user", "closed", "stop", "restart"]) {
	test(`independent terminal checks after a session read failure discard a stale ${change} completion`, async () => {
		read.mockRejectedValueOnce(new Error("session store unavailable"));
		const entered = gate<void>();
		const verdict = gate<boolean>();
		access.mockImplementationOnce(async () => {
			entered.resolve();
			return verdict.promise;
		});
		access.mockResolvedValue(true);
		const { ws, connection } = socket();
		const first = revalidateSessionSockets([connection]);
		await entered.promise;
		if (change === "epoch") eventBus.emit({ type: "auth:changed", userId: "user" });
		if (change === "session") ws.data.sessionId = "replacement";
		if (change === "user") ws.data.sessionUserId = "replacement";
		if (change === "closed") ws.readyState = 3;
		if (change === "stop" || change === "restart") stopHeartbeat();
		if (change === "restart") startHeartbeat();
		verdict.resolve(false);
		await first;
		expect(read).toHaveBeenCalledTimes(change === "epoch" ? 2 : 1);
		expect(ws.data.subscribedTerminals.has("shell")).toBe(true);
		expect(ws.send).not.toHaveBeenCalled();
		expect(ws.close).not.toHaveBeenCalled();
	});
}
