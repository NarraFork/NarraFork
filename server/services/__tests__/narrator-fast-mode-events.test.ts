import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { narrators, userPreferences, users } from "../../db/schema";
import * as workerReads from "../../db/worker-read";
import { eventBus, type NarraForkEvent } from "../../lib/event-bus";
import { userPreferencesRoutes } from "../../routes/user-preferences";
import {
	getRunControl,
	type RunControl,
	setRunControl,
	tryClaimExecution,
} from "../agent-runtime/ownership";
import { getRuntimePublicationService, runtimePublication } from "../agent-runtime/publication";
import { resolveNarratorFastMode } from "../narrator-fast-mode";
import { registerRunPrincipal, setRuntimeRegistration } from "../narrator-runtime-registration";
import { type ActiveNarrator, activeNarrators } from "../narrator-session-state";

// Use the preload-isolated file DB, which the real readQuery Worker can open.
// The persistence/service module cycle requires loading the service first.
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
runtimePublication.stop();

const NOW = "2026-11-04T00:00:00.000Z";
const events: NarraForkEvent[] = [];
const capture = (event: NarraForkEvent) => {
	if (
		event.type === "narrator:fast_mode_changed" ||
		event.type === "user:fast_mode_default_changed" ||
		event.type === "narrator:execution_principal_changed"
	)
		events.push(event);
};
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "alice", role: "user", iat: 0, exp: 0 });
	await next();
});
app.route("/preferences", userPreferencesRoutes);
app.onError((error, c) => c.json({ error: error.message }, 500));

beforeEach(() => {
	cleanDb(sqlite);
	db.insert(users)
		.values(["alice", "bob"].map((id) => ({ id, username: id, passwordHash: "x", createdAt: NOW })))
		.run();
	db.insert(narrators)
		.values({ id: "root", ownerUserId: "alice", createdAt: NOW, updatedAt: NOW })
		.run();
	events.length = 0;
	eventBus.onAny(capture);
});

afterEach(() => {
	eventBus.offAny(capture);
	mock.restore();
	cleanDb(sqlite);
});

function patchPreferences(body: Record<string, unknown>) {
	return app.request("/preferences", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function registration(userId: string) {
	return { version: 1 as const, run: { logicalRunId: "run", principal: { userId } } };
}

test("override commit invalidates synchronously and only after an actual row update", async () => {
	const observed: unknown[] = [];
	const onChange = () => {
		observed.push(
			db.query.narrators.findFirst({ where: eq(narrators.id, "root") }).sync()?.fastModeOverride,
		);
	};
	eventBus.on("narrator:fast_mode_changed", onChange);
	try {
		const saving = narratorPersistence.updateFastModeOverride("root", "on");
		expect(observed).toEqual(["on"]);
		await saving;
		expect(events).toEqual([{ type: "narrator:fast_mode_changed", narratorId: "root" }]);
		await narratorPersistence.updateFastModeOverride("missing", "off");
		expect(events).toHaveLength(1);
		const failed = spyOn(db, "update").mockImplementationOnce(() => {
			throw new Error("write failed");
		});
		await expect(narratorPersistence.updateFastModeOverride("root", "off")).rejects.toThrow(
			"write failed",
		);
		failed.mockRestore();
		expect(events).toHaveLength(1);
	} finally {
		eventBus.off("narrator:fast_mode_changed", onChange);
	}
});

test("tool replay resolves its active session identity and falls back after owner release", async () => {
	db.insert(userPreferences)
		.values([
			{ id: "pref-alice", userId: "alice", fastModeDefault: false, createdAt: NOW, updatedAt: NOW },
			{ id: "pref-bob", userId: "bob", fastModeDefault: true, createdAt: NOW, updatedAt: NOW },
		])
		.run();
	await setRuntimeRegistration("root", registration("alice"));
	eventBus.emit({ type: "auth:changed", userId: "bob" });
	const active = { _currentUserId: "bob" } as ActiveNarrator;
	activeNarrators.set("root", active);
	const owner = tryClaimExecution("root", "tool-replay");
	expect(owner).not.toBeNull();
	try {
		expect(getRunControl("root")).toBeUndefined();
		expect((await resolveNarratorFastMode("root")).effectiveFastMode).toBe(true);
		active._currentUserId = null;
		expect((await resolveNarratorFastMode("root")).effectiveFastMode).toBe(false);
		active._currentUserId = undefined;
		expect((await resolveNarratorFastMode("root")).effectiveFastMode).toBe(false);
		active._currentUserId = "bob";
		owner?.release();
		expect((await resolveNarratorFastMode("root")).effectiveFastMode).toBe(false);
		const ordinary = tryClaimExecution("root", "run");
		expect(ordinary).not.toBeNull();
		if (ordinary) {
			try {
				setRunControl(ordinary, { principal: "alice" } as RunControl);
				expect((await resolveNarratorFastMode("root")).effectiveFastMode).toBe(false);
				setRunControl(ordinary, { principal: "bob" } as RunControl);
				expect((await resolveNarratorFastMode("root")).effectiveFastMode).toBe(true);
			} finally {
				ordinary.release();
			}
		}
	} finally {
		owner?.release();
		activeNarrators.delete("root");
		eventBus.emit({ type: "narrator:deleted", narratorId: "root", title: null });
	}
});

test("SQLite startRun facade commits and invalidates before returning its Promise", async () => {
	const facade = getRuntimePublicationService();
	let committed: unknown;
	const onChange = () => {
		committed = db.query.narrators
			.findFirst({ where: eq(narrators.id, "root") })
			.sync()?.runtimeRegistrationJson;
	};
	eventBus.on("narrator:execution_principal_changed", onChange);
	try {
		const started = facade.startRun({
			narratorId: "root",
			binding: { principal: { userId: "bob" } },
		});
		expect(started).toBeInstanceOf(Promise);
		expect(events).toEqual([{ type: "narrator:execution_principal_changed", narratorId: "root" }]);
		expect(committed).toMatchObject({ run: { principal: { userId: "bob" } } });
		expect((await started).binding.principal).toEqual({ userId: "bob" });
	} finally {
		eventBus.off("narrator:execution_principal_changed", onChange);
	}
});

test("SQLite startRun facade preserves failure and spy seams without emitting", async () => {
	const facade = getRuntimePublicationService();
	const legacy = spyOn(runtimePublication, "startRun").mockImplementationOnce(() => {
		throw new Error("registration commit failed");
	});
	const result = facade.startRun({
		narratorId: "root",
		binding: { principal: { userId: "alice" } },
	});
	expect(result).toBeInstanceOf(Promise);
	await expect(result).rejects.toThrow("registration commit failed");
	legacy.mockRestore();
	expect(events).toHaveLength(0);
	const intercepted = spyOn(facade, "startRun").mockRejectedValueOnce(
		new Error("facade intercepted"),
	);
	await expect(
		getRuntimePublicationService().startRun({ narratorId: "root", binding: {} }),
	).rejects.toThrow("facade intercepted");
	expect(intercepted).toHaveBeenCalledTimes(1);
	intercepted.mockRestore();
	expect(events).toHaveLength(0);
});

test("preference events require a submitted field and an actual default change", async () => {
	expect((await patchPreferences({ language: "en" })).status).toBe(200);
	expect((await patchPreferences({ fastModeDefault: false })).status).toBe(200);
	expect(events).toHaveLength(0);
	expect((await patchPreferences({ fastModeDefault: true })).status).toBe(200);
	expect(events).toEqual([{ type: "user:fast_mode_default_changed", userId: "alice" }]);
	expect((await patchPreferences({ fastModeDefault: true })).status).toBe(200);
	expect((await patchPreferences({ wordWrapCode: false })).status).toBe(200);
	expect(events).toHaveLength(1);
	expect((await patchPreferences({ fastModeDefault: false })).status).toBe(200);
	expect(events).toHaveLength(2);
});

test("preference invalidation precedes response readback even when readback fails", async () => {
	let committed: boolean | undefined;
	const onChange = () => {
		committed = db.query.userPreferences
			.findFirst({ where: eq(userPreferences.userId, "alice") })
			.sync()?.fastModeDefault;
		spyOn(workerReads, "readQuery").mockRejectedValueOnce(new Error("readback failed"));
	};
	eventBus.on("user:fast_mode_default_changed", onChange);
	try {
		expect((await patchPreferences({ fastModeDefault: true })).status).toBe(500);
		expect(committed).toBe(true);
		expect(events).toEqual([{ type: "user:fast_mode_default_changed", userId: "alice" }]);
	} finally {
		eventBus.off("user:fast_mode_default_changed", onChange);
	}
});

test("preference write failures and validation failures publish no invalidation", async () => {
	const write = spyOn(sqlite, "run").mockImplementationOnce(() => {
		throw new Error("write failed");
	});
	expect((await patchPreferences({ fastModeDefault: true })).status).toBe(500);
	write.mockRestore();
	expect(events).toHaveLength(0);
	expect((await patchPreferences({ fastModeDefault: "invalid" })).status).toBe(500);
	expect(events).toHaveLength(0);
});

test("durable principal events follow the committed registration and skip stale runs", async () => {
	await setRuntimeRegistration("root", registration("alice"));
	events.length = 0;
	await registerRunPrincipal("root", "stale", "bob");
	await registerRunPrincipal("root", "run", "alice");
	expect(events).toHaveLength(0);
	let committed: unknown;
	const onChange = () => {
		committed = db.query.narrators
			.findFirst({ where: eq(narrators.id, "root") })
			.sync()?.runtimeRegistrationJson;
	};
	eventBus.on("narrator:execution_principal_changed", onChange);
	try {
		await registerRunPrincipal("root", "run", "bob");
		expect(committed).toEqual(registration("bob"));
		expect(events).toEqual([{ type: "narrator:execution_principal_changed", narratorId: "root" }]);
	} finally {
		eventBus.off("narrator:execution_principal_changed", onChange);
	}
});
