import { describe, expect, test } from "bun:test";
import { type AtomicWriteSection, WriteConflictError } from "./write-port";

describe("WriteConflictError", () => {
	test("carries the constraint and the driver error as cause", () => {
		const driverError = Object.assign(new Error("duplicate key"), { code: "23505" });
		const error = new WriteConflictError("account already exists", {
			constraint: "users_username_key",
			cause: driverError,
		});
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("WriteConflictError");
		expect(error.message).toBe("account already exists");
		expect(error.constraint).toBe("users_username_key");
		expect(error.cause).toBe(driverError);
	});

	test("tolerates a backend that reported no constraint", () => {
		const error = new WriteConflictError("conflict");
		expect(error.constraint).toBeNull();
		expect(error.cause).toBeUndefined();
	});
});

describe("AtomicWriteSection", () => {
	// The type is neutral about synchrony — these tests pin that both backend shapes compose
	// with it, because batch A builds one implementation of each against this vocabulary.

	test("a strictly synchronous (SQLite-shaped) section composes", () => {
		interface FakeTx {
			insert(value: string): void;
		}
		const written: string[] = [];
		const tx: FakeTx = { insert: (value) => written.push(value) };
		const section: AtomicWriteSection<FakeTx, number> = (t) => {
			t.insert("a");
			t.insert("b");
			return written.length;
		};
		// The SQLite implementation wraps the already-committed result — the Promise on the
		// boundary is created AFTER the atomic section closed, never around an open one.
		const asBoundaryPromise = Promise.resolve(section(tx));
		expect(written).toEqual(["a", "b"]);
		return expect(asBoundaryPromise).resolves.toBe(2);
	});

	test("a genuinely async (PostgreSQL-shaped) section composes", async () => {
		interface FakeTx {
			insert(value: string): Promise<void>;
		}
		const written: string[] = [];
		const tx: FakeTx = {
			insert: (value) => {
				written.push(value);
				return Promise.resolve();
			},
		};
		const section: AtomicWriteSection<FakeTx, Promise<number>> = async (t) => {
			await t.insert("a");
			await t.insert("b");
			return written.length;
		};
		await expect(section(tx)).resolves.toBe(2);
		expect(written).toEqual(["a", "b"]);
	});
});
