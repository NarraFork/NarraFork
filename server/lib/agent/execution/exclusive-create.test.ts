import { afterEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createExclusiveLocalIo,
	EXCLUSIVE_CREATE_MAX_BYTES,
	exclusiveCreateOptions,
	validateExclusiveCreateInput,
} from "./exclusive-create";
import { LocalBackend } from "./local-backend";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "nf-exclusive-")));
	roots.push(root);
	const work = join(root, "workspace");
	const outside = join(root, "outside");
	const parent = join(work, "parent");
	const saved = join(work, "saved");
	await mkdir(parent, { recursive: true });
	await mkdir(outside);
	return {
		work,
		outside,
		parent,
		saved,
		path: join(parent, "entry"),
		async swap() {
			await rename(parent, saved);
			await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
		},
	};
}
const linux = process.platform === "linux";

describe("exclusive creation binds a canonical directory handle", () => {
	for (const operation of ["mkdir", "write"] as const) {
		test.skipIf(!linux)(
			`${operation}: regression control reproduces the checked-full-path escape`,
			async () => {
				const f = await fixture();
				const backend = new LocalBackend();
				expect((await backend.resolvePathIdentity(f.path)).canonicalPath).toBe(f.path);
				await f.swap();
				// The pre-fix code used precisely these full-path syscalls after its check.
				// O_EXCL protects the leaf only. Both directories are disposable fixtures.
				if (operation === "mkdir") await mkdir(f.path);
				else {
					const file = await open(f.path, "wx");
					await file.writeFile("escaped");
					await file.close();
				}
				expect(await readdir(f.outside)).toEqual(["entry"]);
			},
		);

		test.skipIf(!linux)(
			`${operation}: a swap after canonical validation is rejected before mutation`,
			async () => {
				const f = await fixture();
				class SwappingBackend extends LocalBackend {
					override async resolvePathIdentity(path: string) {
						const identity = await super.resolvePathIdentity(path);
						await f.swap();
						return identity;
					}
				}
				const backend = new SwappingBackend();
				const opts = { expectedResolvedPath: f.path, exclusive: true };
				await expect(
					operation === "mkdir"
						? backend.mkdirExclusive(f.path, opts)
						: backend.writeFileBytes(f.path, Buffer.from("safe"), opts),
				).rejects.toThrow();
				expect(await readdir(f.outside)).toEqual([]);
				expect(await readdir(f.saved)).toEqual([]);
			},
		);

		test.skipIf(!linux)(
			`${operation}: a swap after parent binding cannot redirect creation`,
			async () => {
				const f = await fixture();
				let swapped = false;
				const io = createExclusiveLocalIo({
					async open(path, flags, mode) {
						if (flags & constants.O_CREAT) {
							await f.swap();
							swapped = true;
						}
						return open(path, flags, mode);
					},
					async mkdir(path, opts) {
						await f.swap();
						swapped = true;
						return mkdir(path, opts);
					},
				});
				const signal = exclusiveCreateOptions().signal;
				if (operation === "mkdir") expect(await io.mkdir(f.path, signal)).toBe(true);
				else await io.write(f.path, Buffer.from("safe"), signal);
				expect(swapped).toBe(true);
				expect(await readdir(f.outside)).toEqual([]);
				expect(await readdir(f.saved)).toEqual(["entry"]);
				if (operation === "write")
					expect(await readFile(join(f.saved, "entry"), "utf8")).toBe("safe");
			},
		);
	}

	test.skipIf(!linux)(
		"unreplaced paths work, concurrent creates have one winner, existing files survive",
		async () => {
			const f = await fixture();
			const backend = new LocalBackend();
			const opts = { expectedResolvedPath: f.path };
			const results = await Promise.all(
				Array.from({ length: 8 }, () => backend.mkdirExclusive(f.path, opts)),
			);
			expect(results.filter(Boolean)).toHaveLength(1);
			const path = join(f.path, "App.tsx");
			await backend.writeFileBytes(path, Buffer.from("original"), {
				expectedResolvedPath: path,
				exclusive: true,
			});
			await expect(
				backend.writeFileBytes(path, Buffer.from("replace"), {
					expectedResolvedPath: path,
					exclusive: true,
				}),
			).rejects.toThrow();
			expect(await readFile(path, "utf8")).toBe("original");
		},
	);

	test.skipIf(!linux)(
		"missing ancestors and a final symlink never cause implicit creation or overwrite",
		async () => {
			const f = await fixture();
			const io = createExclusiveLocalIo();
			const signal = exclusiveCreateOptions().signal;
			await expect(io.write(join(f.path, "nested"), Buffer.from("x"), signal)).rejects.toThrow();
			expect(await readdir(f.parent)).toEqual([]);
			await writeFile(join(f.outside, "victim"), "untouched");
			await symlink(join(f.outside, "victim"), f.path);
			await expect(io.write(f.path, Buffer.from("replace"), signal)).rejects.toThrow();
			expect(await readFile(join(f.outside, "victim"), "utf8")).toBe("untouched");
		},
	);

	test("rejects unsupported platforms instead of a full-path fallback", async () => {
		for (const platform of ["win32", "darwin", "freebsd"] as const) {
			let calls = 0;
			const io = createExclusiveLocalIo(
				{
					async open() {
						calls++;
						throw new Error("must not open");
					},
					async mkdir() {
						calls++;
						throw new Error("must not create");
					},
				},
				platform,
			);
			await expect(io.mkdir("/work/new", exclusiveCreateOptions().signal)).rejects.toThrow(
				"remote executor",
			);
			await expect(
				io.write("/work/new", Buffer.from("x"), exclusiveCreateOptions().signal),
			).rejects.toThrow("remote executor");
			expect(calls).toBe(0);
		}
	});

	test("input and total-budget guards fail before filesystem access", async () => {
		for (const path of [undefined, "", "a\0b", "x".repeat(32769), `/${"x/".repeat(129)}entry`])
			expect(() => validateExclusiveCreateInput(path)).toThrow();
		expect(() =>
			validateExclusiveCreateInput("/x", new Uint8Array(EXCLUSIVE_CREATE_MAX_BYTES + 1)),
		).toThrow();
		for (const timeoutMs of [0, -1, 30001, 0.5, Number.NaN])
			expect(() => exclusiveCreateOptions({ timeoutMs })).toThrow();
		const controller = new AbortController();
		controller.abort();
		expect(() => exclusiveCreateOptions({ signal: controller.signal })).toThrow();
		const f = await fixture();
		const backend = new LocalBackend();
		await expect(
			backend.mkdirExclusive(f.path, { expectedResolvedPath: f.path, signal: controller.signal }),
		).rejects.toThrow();
		await expect(
			backend.writeFileBytes(f.path, Buffer.from("x"), { exclusive: true }),
		).rejects.toThrow();
		expect(await readdir(f.parent)).toEqual([]);
	});

	test.skipIf(!linux)("absence of procfs fails closed and releases bound handles", async () => {
		const f = await fixture();
		const handles: Awaited<ReturnType<typeof open>>[] = [];
		const io = createExclusiveLocalIo({
			async open(path, flags, mode) {
				if (path.startsWith("/proc/")) throw new Error("procfs unavailable");
				const file = await open(path, flags, mode);
				handles.push(file);
				return file;
			},
			mkdir,
		});
		await expect(io.mkdir(f.path, exclusiveCreateOptions().signal)).rejects.toThrow(
			"procfs unavailable",
		);
		expect(handles.length).toBe(1);
		for (const handle of handles) expect(handle.fd).toBe(-1);
		expect(await readdir(f.parent)).toEqual([]);
	});

	test("ordinary non-exclusive writes retain replacement and implicit parent creation", async () => {
		const f = await fixture();
		const path = join(f.path, "nested", "file");
		const backend = new LocalBackend();
		await backend.writeFileBytes(path, Buffer.from("one"));
		await backend.writeFileBytes(path, Buffer.from("two"), { expectedResolvedPath: path });
		expect(await readFile(path, "utf8")).toBe("two");
	});
});
