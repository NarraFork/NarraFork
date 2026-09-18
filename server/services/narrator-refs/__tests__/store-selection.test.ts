import { afterEach, expect, test } from "bun:test";
import type { NarratorMessageRefsPort } from "../port";
import { bindNarratorMessageRefs, getNarratorMessageRefsPort } from "../store";

const previous = { write: process.env.NF_WRITE_BACKEND, read: process.env.NF_READ_BACKEND };
afterEach(() => {
	bindNarratorMessageRefs(undefined);
	if (previous.write === undefined) delete process.env.NF_WRITE_BACKEND;
	else process.env.NF_WRITE_BACKEND = previous.write;
	if (previous.read === undefined) delete process.env.NF_READ_BACKEND;
	else process.env.NF_READ_BACKEND = previous.read;
});

test("SQLite default has no network port and does not open a client", () => {
	delete process.env.NF_WRITE_BACKEND;
	delete process.env.NF_READ_BACKEND;
	expect(getNarratorMessageRefsPort()).toBeUndefined();
});

test("explicit PostgreSQL without a binding fails closed", () => {
	process.env.NF_WRITE_BACKEND = "postgres";
	process.env.NF_READ_BACKEND = "postgres";
	expect(() => getNarratorMessageRefsPort()).toThrow("unavailable");
});

test("mismatched read/write configuration cannot silently select SQLite", () => {
	process.env.NF_WRITE_BACKEND = "sqlite";
	process.env.NF_READ_BACKEND = "postgres";
	expect(() => getNarratorMessageRefsPort()).toThrow("does not match");
});

test("composition injects exactly its Promise port and disposal restores fail-closed", () => {
	process.env.NF_WRITE_BACKEND = "postgres";
	process.env.NF_READ_BACKEND = "postgres";
	const unavailable = async (): Promise<never> => {
		throw new Error("unused fixture");
	};
	const port: NarratorMessageRefsPort = {
		append: unavailable,
		insertBefore: unavailable,
		copyRefs: unavailable,
		page: unavailable,
		creator: unavailable,
	};
	bindNarratorMessageRefs({ backend: "postgres", port });
	expect(getNarratorMessageRefsPort()).toBe(port);
	bindNarratorMessageRefs(undefined);
	expect(() => getNarratorMessageRefsPort()).toThrow("unavailable");
});
