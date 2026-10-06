import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	inspectApplicationDataDirectory,
	publicDataDirectoryStatus,
	repairApplicationDataDirectory,
	requireApplicationDataDirectory,
} from "./data-directory-security";

let root: string;
let data: string;
const restorers: (() => void)[] = [];
const posix = process.platform !== "win32";

beforeEach(async () => {
	root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "nf-directory-security-"));
	await fs.chmod(root, 0o755);
	data = join(root, "data");
	await fs.mkdir(data, { mode: 0o700 });
});
afterEach(async () => {
	for (const restore of restorers.splice(0).reverse()) restore();
	await fs.rm(root, { recursive: true, force: true });
});
async function mode(path: string) {
	return (await fs.lstat(path)).mode & 0o777;
}

describe("application data directory permissions", () => {
	test.skipIf(!posix)(
		"new settings installations create private directories and files",
		async () => {
			const firstRun = join(root, "first-run");
			const modulePath = new URL("./settings/index.ts", import.meta.url).pathname;
			execFileSync(process.execPath, ["-e", `await import(${JSON.stringify(modulePath)});`], {
				env: { ...process.env, NARRAFORK_HOME: firstRun },
				maxBuffer: 64 * 1024,
				timeout: 10_000,
			});
			expect(await mode(firstRun)).toBe(0o700);
			expect(await mode(join(firstRun, "settings.json"))).toBe(0o600);
		},
	);

	test("healthy inspection and repair leave the directory identity untouched", async () => {
		const before = await requireApplicationDataDirectory(data);
		expect(await inspectApplicationDataDirectory(data)).toEqual({ status: "ok", canRepair: false });
		expect(await repairApplicationDataDirectory(data)).toEqual({ status: "ok", canRepair: false });
		expect(await requireApplicationDataDirectory(data)).toBe(before);
	});

	test.skipIf(!posix)(
		"repairs only the app directory, preserving contents, children and parent",
		async () => {
			await fs.chmod(data, 0o775);
			await fs.writeFile(join(data, "content.txt"), "keep this content", { mode: 0o640 });
			await fs.mkdir(join(data, "child"), { mode: 0o750 });
			expect(await inspectApplicationDataDirectory(data)).toMatchObject({
				status: "restricted",
				canRepair: true,
				details: {
					code: "leaf_permissions",
					path: data,
					mode: "0775",
					ownerUid: process.geteuid?.(),
				},
			});
			await expect(requireApplicationDataDirectory(data)).rejects.toThrow("Settings > Storage");
			expect(await repairApplicationDataDirectory(data)).toEqual({
				status: "ok",
				canRepair: false,
			});
			expect(await mode(data)).toBe(0o700);
			expect(await mode(root)).toBe(0o755);
			expect(await mode(join(data, "child"))).toBe(0o750);
			expect(await mode(join(data, "content.txt"))).toBe(0o640);
			expect(await fs.readFile(join(data, "content.txt"), "utf8")).toBe("keep this content");
			await expect(requireApplicationDataDirectory(data)).resolves.toBeString();
		},
	);

	test.skipIf(!posix)("a private ancestor makes group-write safe without chmod", async () => {
		await fs.chmod(root, 0o700);
		await fs.chmod(data, 0o775);
		expect(await inspectApplicationDataDirectory(data)).toEqual({ status: "ok", canRepair: false });
		expect(await repairApplicationDataDirectory(data)).toEqual({ status: "ok", canRepair: false });
		expect(await mode(data)).toBe(0o775);
	});

	test.skipIf(!posix)("never repairs an untrusted writable ancestor", async () => {
		await fs.chmod(root, 0o777);
		await fs.chmod(data, 0o777);
		expect(await inspectApplicationDataDirectory(data)).toMatchObject({
			status: "restricted",
			canRepair: false,
			details: { code: "ancestor_permissions", path: root },
		});
		expect((await repairApplicationDataDirectory(data)).canRepair).toBe(false);
		expect(await mode(root)).toBe(0o777);
		expect(await mode(data)).toBe(0o777);
	});

	test.skipIf(!posix)("refuses another user's directory even when running as root", async () => {
		const realUid = process.geteuid?.() ?? 0;
		const spy = spyOn(process, "geteuid").mockReturnValue(realUid === 0 ? 42 : 0);
		restorers.push(() => spy.mockRestore());
		expect(await inspectApplicationDataDirectory(data)).toMatchObject({
			status: "restricted",
			canRepair: false,
			details: { code: "owner" },
		});
		expect((await repairApplicationDataDirectory(data)).status).toBe("restricted");
		expect(await mode(data)).toBe(0o700);
	});

	test.skipIf(!posix)("refuses symlink paths without touching their targets", async () => {
		await fs.chmod(data, 0o777);
		const alias = join(root, "alias");
		await fs.symlink(data, alias);
		expect(await repairApplicationDataDirectory(alias)).toMatchObject({
			status: "restricted",
			canRepair: false,
			details: { code: "canonical_path" },
		});
		expect(await mode(data)).toBe(0o777);
	});

	test("a timed-out check is unknown, never reported as a permission fault", async () => {
		// A slow filesystem says nothing about permissions. Reporting it as "restricted"
		// sent admins to inspect a directory that was fine.
		const real = Date.now;
		let calls = 0;
		const spy = spyOn(Date, "now").mockImplementation(() => real() + (calls++ > 1 ? 60_000 : 0));
		restorers.push(() => spy.mockRestore());
		const status = await inspectApplicationDataDirectory(data);
		spy.mockRestore();
		expect(status).toMatchObject({
			status: "unknown",
			canRepair: false,
			details: { code: "check_incomplete" },
		});
		expect(await mode(data)).toBe(0o700);
	});

	test("missing directory is unavailable, never healthy or automatically created", async () => {
		const missing = join(root, "missing");
		expect(await inspectApplicationDataDirectory(missing)).toMatchObject({
			status: "unavailable",
			canRepair: false,
		});
		expect(await repairApplicationDataDirectory(missing)).toMatchObject({
			status: "unavailable",
			canRepair: false,
		});
		await expect(fs.lstat(missing)).rejects.toThrow();
	});

	test.skipIf(!posix)(
		"concurrent repairs are coalesced and later repair is idempotent",
		async () => {
			await fs.chmod(data, 0o777);
			const first = repairApplicationDataDirectory(data);
			const second = repairApplicationDataDirectory(data);
			expect(first).toBe(second);
			expect(await first).toMatchObject({ status: "ok" });
			expect(await repairApplicationDataDirectory(data)).toMatchObject({ status: "ok" });
		},
	);

	test.skipIf(!posix)(
		"directory replacement between inspection and chmod is rejected",
		async () => {
			await fs.chmod(data, 0o777);
			const originalOpen = fs.open;
			const old = join(root, "old");
			const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await originalOpen(...args);
				if (args[0] === data) {
					await fs.rename(data, old);
					await fs.mkdir(data);
					await fs.chmod(data, 0o777);
				}
				return handle;
			});
			restorers.push(() => spy.mockRestore());
			expect(await repairApplicationDataDirectory(data)).toMatchObject({
				status: "unavailable",
				canRepair: false,
			});
			expect(await mode(data)).toBe(0o777);
			expect(await mode(old)).toBe(0o777);
		},
	);

	test.skipIf(!posix)("failed chmod can be checked and retried without restarting", async () => {
		await fs.chmod(data, 0o777);
		const originalOpen = fs.open;
		const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await originalOpen(...args);
			spyOn(handle, "chmod").mockRejectedValueOnce(new Error("EPERM"));
			return handle;
		});
		restorers.push(() => spy.mockRestore());
		expect(await repairApplicationDataDirectory(data)).toMatchObject({
			status: "unavailable",
			canRepair: false,
		});
		expect(await mode(data)).toBe(0o777);
		spy.mockRestore();
		expect(await inspectApplicationDataDirectory(data)).toMatchObject({ canRepair: true });
		expect(await repairApplicationDataDirectory(data)).toMatchObject({ status: "ok" });
	});

	test.skipIf(!posix)("Windows does not apply POSIX permission changes", async () => {
		await fs.chmod(data, 0o777);
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		restorers.push(() => {
			if (descriptor) Object.defineProperty(process, "platform", descriptor);
		});
		expect(await repairApplicationDataDirectory(data)).toEqual({ status: "ok", canRepair: false });
		expect(await mode(data)).toBe(0o777);
	});

	test.skipIf(!posix)(
		"Windows accepts a healthy directory reached through a junction-like alias",
		async () => {
			// Windows user profiles, OneDrive and subst drives routinely name the same
			// directory through a reparse point. POSIX refuses the alias; Windows must
			// secure the real target instead of reporting a false permission fault.
			const alias = join(root, "alias");
			await fs.symlink(data, alias);
			const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			restorers.push(() => {
				if (descriptor) Object.defineProperty(process, "platform", descriptor);
			});
			expect(await inspectApplicationDataDirectory(alias)).toEqual({
				status: "ok",
				canRepair: false,
			});
			expect(await requireApplicationDataDirectory(alias)).toBeString();
			expect(await requireApplicationDataDirectory(alias)).toBe(
				await requireApplicationDataDirectory(data),
			);
		},
	);

	test.skipIf(!posix)(
		"Windows missing path is unavailable, not a false permission fault",
		async () => {
			const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			restorers.push(() => {
				if (descriptor) Object.defineProperty(process, "platform", descriptor);
			});
			const missing = join(root, "missing");
			expect(await inspectApplicationDataDirectory(missing)).toMatchObject({
				status: "unavailable",
				canRepair: false,
			});
		},
	);

	test.skipIf(!posix)(
		"rechecks authorization immediately before changing permissions",
		async () => {
			await fs.chmod(data, 0o777);
			let checks = 0;
			const status = await repairApplicationDataDirectory(data, () => {
				checks++;
				throw new Error("Administrator authorization was revoked");
			});
			expect(checks).toBe(1);
			expect(status.status).toBe("unavailable");
			expect(await mode(data)).toBe(0o777);
		},
	);

	test("ordinary users receive no OS identity or path details", () => {
		expect(
			publicDataDirectoryStatus({
				status: "restricted",
				canRepair: true,
				details: {
					code: "owner",
					path: "/home/private-name/.narrafork",
					message: "sensitive",
					ownerUid: 42,
					serviceUid: 43,
				},
			}),
		).toEqual({ status: "restricted", canRepair: false });
	});
});
