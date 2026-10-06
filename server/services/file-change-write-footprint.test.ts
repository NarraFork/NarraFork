import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertLocalWriteFootprint,
	captureLocalWriteFootprint,
} from "./file-change-write-footprint";

const roots: string[] = [];
async function temporaryRoot() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "write-footprint-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local write admission footprint", () => {
	test("existing parent reserves the file, not its directory", async () => {
		const root = await temporaryRoot();
		const file = join(root, "file.txt");
		const footprint = await captureLocalWriteFootprint(file, new AbortController().signal);
		expect(footprint.ranges).toEqual([{ kind: "file", canonicalPath: file }]);
		expect(footprint.anchor).toBe(root);
		await assertLocalWriteFootprint(footprint);
	});

	test("missing parents reserve their first missing subtree, not the existing ancestor", async () => {
		const root = await temporaryRoot();
		const footprint = await captureLocalWriteFootprint(
			join(root, "missing", "nested", "file.txt"),
			new AbortController().signal,
		);
		expect(footprint.ranges).toEqual([{ kind: "subtree", canonicalPath: join(root, "missing") }]);
		expect(footprint.anchor).toBe(root);
		await mkdir(join(root, "missing", "nested"), { recursive: true });
		await assertLocalWriteFootprint(footprint);
	});

	test("replacing an existing anchor does not broaden a file grant to parent creation", async () => {
		const root = await temporaryRoot();
		const parent = join(root, "parent");
		await mkdir(parent);
		const footprint = await captureLocalWriteFootprint(
			join(parent, "file.txt"),
			new AbortController().signal,
		);
		await rename(parent, join(root, "moved"));
		await mkdir(parent);
		await expect(assertLocalWriteFootprint(footprint)).rejects.toThrow("identity changed");
	});

	test("symlink anchors fail closed instead of inventing a physical range", async () => {
		const root = await temporaryRoot();
		await mkdir(join(root, "actual"));
		await symlink(join(root, "actual"), join(root, "alias"));
		await expect(
			captureLocalWriteFootprint(join(root, "alias", "file.txt"), new AbortController().signal),
		).rejects.toThrow();
	});

	test("cancelled range discovery never returns admission evidence", async () => {
		const root = await temporaryRoot();
		const controller = new AbortController();
		controller.abort(new Error("cancelled discovery"));
		await expect(captureLocalWriteFootprint(join(root, "file"), controller.signal)).rejects.toThrow(
			"cancelled discovery",
		);
	});
});
