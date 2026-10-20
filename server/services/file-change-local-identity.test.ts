import { expect, test } from "bun:test";
import type { BigIntStats } from "node:fs";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as identity from "./file-change-local-identity";
import * as io from "./file-change-local-io";

test("writer and read-only identity APIs share functions and error constructors", () => {
	expect(io.localDirectoryIdentity).toBe(identity.localDirectoryIdentity);
	expect(io.localObjectIdentity).toBe(identity.localObjectIdentity);
	expect(io.LocalFileValidationError).toBe(identity.LocalFileValidationError);
	expect(io.LocalObjectIdentityUnavailableError).toBe(identity.LocalObjectIdentityUnavailableError);
	const stat = { dev: 7n, ino: 23n, birthtimeNs: 101n } as BigIntStats;
	expect(identity.localObjectIdentity(stat)).toBe("7:23:101");
	for (const invalid of [
		{ ...stat, dev: 0n, ino: 0n },
		{ ...stat, birthtimeNs: 0n },
		{ ...stat, birthtimeNs: -1n },
	]) {
		try {
			identity.localObjectIdentity(invalid as BigIntStats);
			throw new Error("expected identity refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(io.LocalObjectIdentityUnavailableError);
			expect(error).toBeInstanceOf(io.LocalFileValidationError);
			expect((error as Error).name).toBe("LocalFileValidationError");
		}
	}
});

test("directory identity preserves real directory, file, symlink and missing-path checks", async () => {
	const root = await mkdtemp(join(tmpdir(), "nf-local-identity-"));
	try {
		expect(await identity.localDirectoryIdentity(root)).toBe(
			io.localObjectIdentity(await lstat(root, { bigint: true })),
		);
		const file = join(root, "file");
		await writeFile(file, "content");
		await expect(identity.localDirectoryIdentity(file)).rejects.toBeInstanceOf(
			io.LocalFileValidationError,
		);
		const link = join(root, "link");
		await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
		await expect(identity.localDirectoryIdentity(link)).rejects.toBeInstanceOf(
			io.LocalFileValidationError,
		);
		await expect(identity.localDirectoryIdentity(join(root, "missing"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
