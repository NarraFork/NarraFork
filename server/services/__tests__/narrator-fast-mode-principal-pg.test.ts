import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { eventBus } from "../../lib/event-bus";

const realDatabase = { ...(await import("../../db")) };
const realReads = { ...(await import("../../db/worker-read")) };
let stored: { runtimeRegistrationJson: unknown } | undefined;
let casMatches = true;
let failWrite = false;
let writes = 0;
let invalidations = 0;
let principalAtEvent: unknown;

const database = {
	select: () => ({
		from: () => ({
			where: () => ({ limit: () => ({ fixture: "narrow narrator registration read" }) }),
		}),
	}),
	transaction() {
		throw new Error("PostgreSQL principal updates must not use SQLite transactions");
	},
	update() {
		return {
			set(values: { runtimeRegistrationJson: unknown }) {
				return {
					where() {
						return {
							async returning() {
								if (failWrite) throw new Error("PG commit failed");
								if (!casMatches) return [];
								stored = { runtimeRegistrationJson: values.runtimeRegistrationJson };
								writes++;
								return [{ id: "root" }];
							},
						};
					},
				};
			},
		};
	},
};
mock.module("../../db", () => ({
	...realDatabase,
	activeDatabaseBackend: "postgres",
	db: database,
}));
mock.module("../../db/worker-read", () => ({
	...realReads,
	readQuery: async () => (stored ? [structuredClone(stored)] : []),
}));
const { registerRunPrincipal, setRuntimeRegistration } = await import(
	"../narrator-runtime-registration"
);

function registration(userId: string) {
	return { version: 1 as const, run: { logicalRunId: "run", principal: { userId } } };
}
const onChange = () => {
	invalidations++;
	principalAtEvent = stored?.runtimeRegistrationJson;
};

beforeEach(() => {
	stored = { runtimeRegistrationJson: registration("alice") };
	casMatches = true;
	failWrite = false;
	writes = 0;
	invalidations = 0;
	principalAtEvent = undefined;
	eventBus.on("narrator:execution_principal_changed", onChange);
});
afterEach(() => eventBus.off("narrator:execution_principal_changed", onChange));
afterAll(() => {
	mock.module("../../db", () => realDatabase);
	mock.module("../../db/worker-read", () => realReads);
	mock.restore();
});

test("PG principal invalidation follows confirmed returning rows and committed identity", async () => {
	await registerRunPrincipal("root", "run", "bob");
	expect(writes).toBe(1);
	expect(invalidations).toBe(1);
	expect(principalAtEvent).toEqual(registration("bob"));
});

test("PG CAS misses, stale runs, and unchanged principals do not emit", async () => {
	await registerRunPrincipal("root", "older-run", "bob");
	await registerRunPrincipal("root", "run", "alice");
	casMatches = false;
	await registerRunPrincipal("root", "run", "bob");
	expect(writes).toBe(0);
	expect(invalidations).toBe(0);
});

test("PG commit failure preserves cached identity until a successful retry", async () => {
	failWrite = true;
	await expect(registerRunPrincipal("root", "run", "bob")).rejects.toThrow("PG commit failed");
	expect(invalidations).toBe(0);
	failWrite = false;
	await registerRunPrincipal("root", "run", "bob");
	expect(invalidations).toBe(1);
});

test("PG full registration replacement invalidates after commit", async () => {
	await setRuntimeRegistration("root", registration("bob"));
	expect(invalidations).toBe(1);
	expect(principalAtEvent).toEqual(registration("bob"));
});
