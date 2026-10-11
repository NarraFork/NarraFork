import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@server/lib/agent/execution/local-backend";
import type { IntelligentUiFileReference } from "@shared/intelligent-ui-files";
import type { WorkspaceContext } from "@shared/workspace-context";
import { buildIntelligentUiPreview, type PreviewDependencies } from "./preview";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "nf-ui-preview-"));
	roots.push(root);
	const directory = join(root, ".narrafork/intelligent_ui/demo-id");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "App.tsx"), "export default ()=>null");
	const workspace: WorkspaceContext = {
		revision: 1,
		deviceId: "local",
		cwd: root,
		pathFlavor: "posix",
		contextKey: "workspace",
		capabilities: { switchDirectory: true },
	};
	const reference: IntelligentUiFileReference = {
		version: 1,
		toolUseId: "use",
		toolCallId: "call",
		deviceId: "local",
		cwd: root,
		workspaceKey: "workspace",
		directory,
		entry: "App.tsx",
		title: "demo",
	};
	const backend = new LocalBackend();
	const deps: PreviewDependencies = {
		workspace: async () => workspace,
		backend: () => backend,
		authorize: async (_n, _u, _d, path) => path,
		compile: async (files) => ({ js: new TextDecoder().decode(files[0].bytes), css: "" }),
		kit: async () => null,
	};
	return { root, directory, workspace, reference, backend, deps };
}
const signal = () => new AbortController().signal;

describe("current-file UI previews", () => {
	test("reads changed ordinary files on every request without a revision store", async () => {
		const f = await fixture();
		const first = await buildIntelligentUiPreview("n", "actor", f.reference, signal(), f.deps);
		await writeFile(join(f.directory, "App.tsx"), "export default ()=>42");
		const second = await buildIntelligentUiPreview("n", "actor", f.reference, signal(), f.deps);
		expect(first.js).toContain("null");
		expect(second.js).toContain("42");
		expect(second.files).toEqual(["App.tsx"]);
	});
	test("authorizes every dependency before it reaches the compiler", async () => {
		const f = await fixture();
		await writeFile(join(f.directory, "secret.ts"), "secret");
		let compiled = false;
		f.deps.authorize = async (_n, _u, _d, path) => {
			if (path.endsWith("secret.ts")) throw new Error("Read denied");
			return path;
		};
		f.deps.compile = async () => {
			compiled = true;
			return { js: "", css: "" };
		};
		await expect(
			buildIntelligentUiPreview("n", "actor", f.reference, signal(), f.deps),
		).rejects.toThrow("Read denied");
		expect(compiled).toBe(false);
	});
	test("workspace changes or permission revocations during compile reject the result", async () => {
		const f = await fixture();
		f.deps.compile = async () => {
			f.workspace.revision++;
			return { js: "private", css: "" };
		};
		await expect(
			buildIntelligentUiPreview("n", "actor", f.reference, signal(), f.deps),
		).rejects.toThrow("changed while compiling");
		let revoked = false;
		f.deps.authorize = async (_n, _u, _d, path) => {
			if (revoked) throw new Error("revoked");
			return path;
		};
		f.deps.compile = async () => {
			revoked = true;
			return { js: "private", css: "" };
		};
		await expect(
			buildIntelligentUiPreview("n", "actor", f.reference, signal(), f.deps),
		).rejects.toThrow("revoked");
	});
	test("bounds concurrent requests and cancellation frees both slots", async () => {
		const f = await fixture();
		let entered = 0;
		let ready: () => void = () => {};
		const bothReady = new Promise<void>((resolve) => {
			ready = resolve;
		});
		f.deps.compile = async (_files, abort) =>
			new Promise((_resolve, reject) => {
				if (++entered === 2) ready();
				abort.addEventListener("abort", () => reject(abort.reason), { once: true });
			});
		const one = new AbortController(),
			two = new AbortController();
		const a = buildIntelligentUiPreview("n", "actor", f.reference, one.signal, f.deps);
		const b = buildIntelligentUiPreview("n", "actor", f.reference, two.signal, f.deps);
		const outcomes = Promise.allSettled([a, b]);
		await bothReady;
		await expect(
			buildIntelligentUiPreview("n", "actor", f.reference, signal(), f.deps),
		).rejects.toThrow("busy");
		one.abort();
		two.abort();
		expect((await outcomes).every((result) => result.status === "rejected")).toBe(true);
		f.deps.compile = async () => ({ js: "ok", css: "" });
		expect((await buildIntelligentUiPreview("n", "actor", f.reference, signal(), f.deps)).js).toBe(
			"ok",
		);
	});
	test("production Read policy blocks an owner's blacklisted dependency", async () => {
		const f = await fixture();
		const { db } = await import("@server/db");
		const { users, narrators, narratorBlacklistDirs } = await import("@server/db/schema");
		const now = new Date().toISOString();
		await db.insert(users).values({
			id: "ui-policy-owner",
			username: "ui-policy-owner",
			role: "user",
			passwordHash: "x",
			createdAt: now,
		});
		await db.insert(narrators).values({
			id: "ui-policy-narrator",
			ownerUserId: "ui-policy-owner",
			title: "policy test",
			cwd: f.root,
			permissionMode: "bypassPermissions",
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		});
		const blocked = join(f.directory, "private.ts");
		await writeFile(blocked, "private source");
		await db.insert(narratorBlacklistDirs).values({
			id: "ui-read-deny",
			narratorId: "ui-policy-narrator",
			path: blocked,
			pathFlavor: "posix",
			pathKey: blocked,
			denyLevel: "denyAll",
			enabled: true,
			targetKind: "host",
			createdAt: now,
		});
		let compiled = false;
		await expect(
			buildIntelligentUiPreview("ui-policy-narrator", "ui-policy-owner", f.reference, signal(), {
				workspace: f.deps.workspace,
				backend: f.deps.backend,
				compile: async () => {
					compiled = true;
					return { js: "private", css: "" };
				},
			}),
		).rejects.toThrow("Read policy denies");
		expect(compiled).toBe(false);
	});
});
