import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeSpawn } from "../lib/spawn";
import {
	createLegacyMigrationArtifactIo,
	LEGACY_ARTIFACT_IO_LIMITS,
	type LegacyArtifactDescriptor,
	validateLegacyArtifactRelativePath,
} from "./legacy-migration-artifact-io";

const owner = { userId: "owner", isAdmin: false };
const shared = { userId: "reader", isAdmin: false };
let temp: string;
let root: string;
let descriptor: LegacyArtifactDescriptor;
let expectedIdentity: string;
let allowed: Set<string>;
let writes: Set<string>;
let calls: number;
let onAuthorize: (() => Promise<void>) | undefined;
let onSnapshotAuthorize: ((signal?: AbortSignal) => Promise<void>) | undefined;
let snapshotAllowed: Set<string>;
const inode = async (path: string) => {
	const stat = await lstat(path, { bigint: true });
	return `${stat.dev}:${stat.ino}`;
};
function service(spawn = safeSpawn) {
	return createLegacyMigrationArtifactIo({
		spawn,
		authorizeSnapshot: async (id, principal, sha, signal) => {
			await onSnapshotAuthorize?.(signal);
			return id === descriptor.id && allowed.has(principal.userId) && snapshotAllowed.has(sha);
		},
		authorize: async (id, principal) => {
			calls++;
			await onAuthorize?.();
			if (id !== descriptor.id || !allowed.has(principal.userId)) return null;
			if ((await inode(root).catch(() => "missing")) !== expectedIdentity) return null;
			return { ...descriptor };
		},
		authorizeWrite: async (_descriptor, principal) => {
			if (!writes.has(principal.userId)) throw new Error("Not allowed");
		},
	});
}
async function git(...args: string[]) {
	const result = await safeSpawn({
		cmd: ["git", ...args],
		timeout: 3000,
		maxOutputBytes: 4096,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	if (result.exitCode) throw new Error(result.stderr);
	return result.stdout.trim();
}
beforeEach(async () => {
	temp = await mkdtemp(join(tmpdir(), "nf-artifact-io-"));
	root = join(temp, "artifact");
	await mkdir(root);
	expectedIdentity = await inode(root);
	descriptor = {
		id: "artifact",
		sourceChapterId: "old",
		narratorId: "narrator",
		ownerUserId: "owner",
		kind: "ignored_archive",
		deviceId: "local",
		workspacePath: "/private/live",
		artifactPath: root,
		shadowKey: null,
		state: "claimed",
		manifestDigest: "digest",
		latestSnapshotCommitSha: null,
	};
	allowed = new Set([owner.userId, shared.userId]);
	writes = new Set([owner.userId]);
	calls = 0;
	onAuthorize = undefined;
	onSnapshotAuthorize = undefined;
	snapshotAllowed = new Set();
});
afterEach(async () => {
	await rm(temp, { recursive: true, force: true });
});

describe("bounded retained artifact IO", () => {
	test("cancelled IO returns no content", async () => {
		await writeFile(join(root, "file"), "never returned");
		const controller = new AbortController();
		controller.abort();
		await expect(
			service().file("artifact", owner, "file", controller.signal),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			service().entries("artifact", owner, "0", 50, controller.signal),
		).rejects.toMatchObject({ statusCode: 400 });
	});
	test("public descriptor redacts archival fields and follows current sharing", async () => {
		const result = await service().descriptor("artifact", shared);
		expect(result.narratorId).toBe("narrator");
		expect(JSON.stringify(result)).not.toContain(root);
		expect(result).not.toHaveProperty("ownerUserId");
		expect(result).not.toHaveProperty("manifestDigest");
		allowed.delete(shared.userId);
		await expect(service().descriptor("artifact", shared)).rejects.toMatchObject({
			statusCode: 404,
		});
	});
	test("empty or spoofed principal fails closed", async () => {
		await expect(
			service().descriptor("artifact", { userId: "", isAdmin: true }),
		).rejects.toMatchObject({ statusCode: 404 });
		await expect(
			service().descriptor("artifact", { userId: "intruder", isAdmin: false }),
		).rejects.toMatchObject({ statusCode: 404 });
	});
	test("relative paths exclude escape, revisions, backslashes and empty segments", () => {
		for (const path of [
			"../secret",
			"/etc/passwd",
			"a/../b",
			"a//b",
			"C:/secret",
			"a\\b",
			"a\0b",
			"a/./b",
			"x^{tree}:x",
		])
			expect(() => validateLegacyArtifactRelativePath(path)).toThrow();
		expect(validateLegacyArtifactRelativePath("folder/file")).toEqual(["folder", "file"]);
	});
	test("file reads are bounded bytes with explicit truncation", async () => {
		await writeFile(join(root, "large"), Buffer.alloc(1024 * 1024, 65));
		const result = await service().file("artifact", shared, "large");
		expect(result.bytesRead).toBe(LEGACY_ARTIFACT_IO_LIMITS.bytes);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512 * 1024);
		expect(Buffer.from(result.content, "base64").length).toBe(result.bytesRead);
		expect(calls).toBeGreaterThanOrEqual(4);
	});
	test("leaf and ancestor symlinks never read outside root", async () => {
		await writeFile(join(temp, "secret"), "private");
		await symlink(join(temp, "secret"), join(root, "leaf"));
		await symlink(temp, join(root, "ancestor"));
		await expect(service().file("artifact", owner, "leaf")).rejects.toMatchObject({
			statusCode: 404,
		});
		await expect(service().file("artifact", owner, "ancestor/secret")).rejects.toMatchObject({
			statusCode: 404,
		});
	});
	test("opened leaf replacement is detected before bytes are returned", async () => {
		await writeFile(join(root, "file"), "retained");
		onAuthorize = async () => {
			if (calls !== 3) return;
			await rename(join(root, "file"), join(root, "old-file"));
			await writeFile(join(root, "file"), "replacement");
		};
		await expect(service().file("artifact", owner, "file")).rejects.toMatchObject({
			statusCode: 404,
		});
	});
	test("opened ancestor replacement is detected without following new symlink", async () => {
		await mkdir(join(root, "folder"));
		await writeFile(join(root, "folder", "file"), "retained");
		onAuthorize = async () => {
			if (calls !== 3) return;
			await rename(join(root, "folder"), join(root, "old-folder"));
			await symlink(temp, join(root, "folder"));
		};
		await expect(service().file("artifact", owner, "folder/file")).rejects.toMatchObject({
			statusCode: 404,
		});
	});
	test("root replacement between authorization and open cannot reuse descriptor", async () => {
		await writeFile(join(root, "file"), "original");
		onAuthorize = async () => {
			if (calls !== 2) return;
			await rename(root, `${root}-old`);
			await mkdir(root);
			await writeFile(join(root, "file"), "replacement");
		};
		await expect(service().file("artifact", owner, "file")).rejects.toMatchObject({
			statusCode: 404,
		});
	});
	test("current ACL revocation and claim digest changes at IO boundary withhold bytes", async () => {
		await writeFile(join(root, "file"), "private");
		onAuthorize = async () => {
			if (calls === 3) allowed.delete(shared.userId);
		};
		await expect(service().file("artifact", shared, "file")).rejects.toMatchObject({
			statusCode: 404,
		});
		calls = 0;
		onAuthorize = async () => {
			if (calls === 3) descriptor.manifestDigest = "changed";
		};
		await expect(service().file("artifact", owner, "file")).rejects.toMatchObject({
			statusCode: 404,
		});
	});
	test("entries depth two, summary-only cursor pages and no symlink traversal", async () => {
		await mkdir(join(root, "folder", "deeper"), { recursive: true });
		await writeFile(join(root, "folder", "file"), "never in summaries");
		await writeFile(join(root, "folder", "deeper", "hidden"), "hidden");
		await symlink(temp, join(root, "link"));
		const first = await service().entries("artifact", shared, "0", 2);
		expect(first.entries.length).toBe(2);
		expect(first.hasMore).toBe(true);
		const next = await service().entries("artifact", shared, first.nextCursor ?? "", 100);
		expect([...first.entries, ...next.entries].map((entry) => entry.path)).toEqual([
			"folder",
			"folder/deeper",
			"folder/file",
			"link",
		]);
		expect(JSON.stringify(next)).not.toContain("never in summaries");
		await expect(service().entries("artifact", shared, "0", 101)).rejects.toMatchObject({
			statusCode: 400,
		});
	});
	test("entry scan budget exposes hasMore and explicit cap without claiming complete inventory", async () => {
		for (let i = 0; i < 1100; i++) await writeFile(join(root, `f${i}`), "");
		const result = await service().entries("artifact", owner, "1000", 100);
		expect(result.scanLimitReached).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.hasMore).toBe(true);
		expect(result.nextCursor).toBeNull();
		expect(result.entries.length).toBe(24);
	});
	test("preview requires write authorization and never changes source or arbitrary target", async () => {
		await writeFile(join(root, "file"), "preserved");
		await expect(service().restorePreview("artifact", shared)).rejects.toMatchObject({
			statusCode: 404,
		});
		expect(await service().restorePreview("artifact", owner)).toMatchObject({
			available: false,
			readOnly: true,
		});
		expect(await Bun.file(join(root, "file")).text()).toBe("preserved");
	});
});

async function shadow() {
	const work = join(temp, "work");
	await mkdir(work);
	await git("init", work);
	await writeFile(join(work, "file"), "snapshot bytes");
	await writeFile(join(work, "large"), Buffer.alloc(1024 * 1024, 65));
	await symlink("/etc/passwd", join(work, "link"));
	await git("-C", work, "add", ".");
	await git(
		"-C",
		work,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@local",
		"commit",
		"-m",
		"snapshot",
	);
	const sha = await git("-C", work, "rev-parse", "HEAD");
	await rm(root, { recursive: true });
	await git("clone", "--bare", work, root);
	await git("--git-dir", root, "update-ref", "refs/nf/head", sha);
	expectedIdentity = await inode(root);
	descriptor = { ...descriptor, kind: "shadow", latestSnapshotCommitSha: sha };
	return { sha, work };
}
describe("shadow namespace reads", () => {
	test("initial claim without live SHA pointer can read retained head namespace", async () => {
		const { sha } = await shadow();
		descriptor.latestSnapshotCommitSha = null;
		expect((await service().tree("artifact", shared, sha, "file")).content).toBe("snapshot bytes");
	});
	test("results completing after overall deadline are withheld", async () => {
		const { sha } = await shadow();
		const clock = spyOn(performance, "now").mockReturnValue(0);
		try {
			await expect(
				service(async () => {
					clock.mockReturnValue(3001);
					return { stdout: sha, stderr: "", exitCode: 0 };
				}).tree("artifact", owner, sha),
			).rejects.toMatchObject({ statusCode: 400 });
		} finally {
			clock.mockRestore();
		}
	});
	test("retained head content and symlink blobs are inert; tree output stays bounded", async () => {
		const { sha } = await shadow();
		expect((await service().tree("artifact", shared, sha, "file")).content).toBe("snapshot bytes");
		expect((await service().tree("artifact", shared, sha, "link")).content).toBe("/etc/passwd");
		expect((await service().tree("artifact", shared, sha)).kind).toBe("tree");
		const large = await service().tree("artifact", shared, sha, "large");
		expect(large.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(512 * 1024);
	});
	test("unreachable loose commit cannot be requested by SHA", async () => {
		const { sha, work } = await shadow();
		await writeFile(join(work, "other"), "not retained");
		await git("-C", work, "add", ".");
		await git(
			"-C",
			work,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@local",
			"commit",
			"-m",
			"other",
		);
		const other = await git("-C", work, "rev-parse", "HEAD");
		await git("--git-dir", root, "fetch", work, `${other}:refs/other/unclaimed`);
		await expect(service().tree("artifact", owner, other, "other")).rejects.toMatchObject({
			statusCode: 404,
		});
		expect((await service().tree("artifact", owner, sha, "file")).content).toBe("snapshot bytes");
	});
	test("durable manifest authorizes a historical branch but repeated claim checks withhold changed evidence", async () => {
		const { work } = await shadow();
		await writeFile(join(work, "other"), "retained historical branch");
		await git("-C", work, "add", ".");
		await git(
			"-C",
			work,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@local",
			"commit",
			"-m",
			"historical branch",
		);
		const other = await git("-C", work, "rev-parse", "HEAD");
		await git("--git-dir", root, "fetch", work, `${other}:refs/other/historical`);
		snapshotAllowed.add(other);
		expect((await service().tree("artifact", shared, other, "other")).content).toBe(
			"retained historical branch",
		);
		const cancelled = new AbortController();
		onSnapshotAuthorize = async (signal) => {
			expect(signal).toBe(cancelled.signal);
			cancelled.abort();
		};
		await expect(
			service().tree("artifact", shared, other, "other", cancelled.signal),
		).rejects.toMatchObject({ statusCode: 400 });
		onSnapshotAuthorize = async () => {
			descriptor.manifestDigest = "changed";
		};
		await expect(service().tree("artifact", shared, other, "other")).rejects.toMatchObject({
			statusCode: 404,
		});
		onSnapshotAuthorize = async () => {
			allowed.delete(shared.userId);
		};
		await expect(service().tree("artifact", shared, other, "other")).rejects.toMatchObject({
			statusCode: 404,
		});
	});
	test("alternates and internal metadata symlinks fail closed", async () => {
		const { sha } = await shadow();
		await writeFile(join(root, "objects", "info", "alternates"), "/unclaimed/objects");
		await expect(service().tree("artifact", owner, sha)).rejects.toMatchObject({ statusCode: 404 });
		await rm(join(root, "objects", "info", "alternates"));
		await symlink(temp, join(root, "objects", "external"));
		await expect(service().tree("artifact", owner, sha)).rejects.toMatchObject({ statusCode: 404 });
	});
	test("subprocesses receive remaining deadline and source-bounded capture", async () => {
		const { sha } = await shadow();
		const seen: Array<{ timeout?: number; maxOutputBytes?: number }> = [];
		const result = await service(async (options) => {
			seen.push(options);
			return safeSpawn(options);
		}).tree("artifact", owner, sha, "file");
		expect(result.content).toBe("snapshot bytes");
		expect(seen.length).toBe(4);
		for (const options of seen) {
			expect(options.timeout).toBeLessThanOrEqual(3000);
			expect(options.maxOutputBytes).toBe(LEGACY_ARTIFACT_IO_LIMITS.textBytes);
		}
	});
	test("late subprocess results and revoked sharing are never returned", async () => {
		const { sha } = await shadow();
		await expect(
			service(async () => {
				allowed.delete(shared.userId);
				return { stdout: sha, stderr: "", exitCode: 0 };
			}).tree("artifact", shared, sha),
		).rejects.toMatchObject({ statusCode: 404 });
	});
});
