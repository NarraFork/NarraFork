import { afterEach, expect, mock, test } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ExecutionBackend, ListBoundedOptions } from "../lib/agent/execution/backend";
import { posixPathSemantics, windowsPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import type { WorkspaceFileAccess } from "../lib/plan-file-path";

mock.module("./workspace-file-access", () => ({
	createNarratorWorkspaceFileAccess: () => {
		throw new Error("must use injected authority");
	},
}));
const { browseWorkspaceDirectory, WORKSPACE_BROWSER_LIMITS } = await import(
	"./workspace-browser-service"
);
afterEach(() => mock.restore());
const context: WorkspaceContext = {
	revision: 4,
	contextKey: "remote:selected:4",
	deviceId: "device",
	cwd: "/selected",
	pathFlavor: "posix",
	capabilities: { switchDirectory: true },
};
const input = { expectedRevision: 4, contextKey: context.contextKey, showHidden: true };
function fixture(ctx = context) {
	const listBounded = mock(async (_path: string, _options?: ListBoundedOptions) => ({
		entries: [
			{ name: "visible", isDirectory: true },
			{ name: "secret", isDirectory: true },
			{ name: "escape", isDirectory: true, isSymlink: true },
		],
		truncated: true,
		scanned: 10_000,
		reason: "scan_limit",
	}));
	const backend = {
		kind: "remote",
		deviceId: ctx.deviceId,
		runtimeGeneration: 1,
		pathFlavor: ctx.pathFlavor,
		paths: ctx.pathFlavor === "windows" ? windowsPathSemantics : posixPathSemantics,
		supportsFsListBounded: true,
		listBounded,
		resolvePathIdentity: mock(async (path: string) => ({
			lexicalPath: path,
			canonicalPath: path.endsWith("/escape") ? "/outside" : path,
			exists: true,
			runtimeGeneration: 1,
		})),
		statFile: mock(async () => ({ isDirectory: true, isFile: false, size: 0 })),
		listDir: mock(async () => {
			throw new Error("unbounded fallback forbidden");
		}),
	} as unknown as ExecutionBackend;
	const authorizeRead = mock(async (path: string) => {
		if (path.endsWith("secret")) throw new AppError("denied", 403, "WORKSPACE_READ_DENIED");
		return true;
	});
	const access: WorkspaceFileAccess = { backend, workspaceContext: ctx, authorizeRead };
	return { backend, access, listBounded, authorizeRead };
}
test("selected remote directory uses bounded backend and hides denied/escaping names", async () => {
	const f = fixture();
	const result = await browseWorkspaceDirectory("n", context, input, { access: f.access });
	expect(f.listBounded.mock.calls[0]?.[0]).toBe("/selected");
	expect(result.entries.map((e) => e.name)).toEqual(["visible"]);
	expect(result.truncated).toBe(true);
	expect(result.reason).toBe("scan_limit");
	expect(result.parent).toBeNull();
	expect(f.backend.listDir).not.toHaveBeenCalled();
});
test("denied root cannot be treated as a permission-browser anchor", async () => {
	const f = fixture();
	f.authorizeRead.mockRejectedValue(new AppError("denyRead", 403));
	await expect(browseWorkspaceDirectory("n", context, input, { access: f.access })).rejects.toThrow(
		"denyRead",
	);
	expect(f.listBounded).not.toHaveBeenCalled();
});
test("stale identity, outside paths, and old executor fail closed", async () => {
	const f = fixture();
	await expect(
		browseWorkspaceDirectory("n", context, { ...input, expectedRevision: 3 }, { access: f.access }),
	).rejects.toThrow("identity changed");
	await expect(
		browseWorkspaceDirectory("n", context, { ...input, path: "../host" }, { access: f.access }),
	).rejects.toThrow("outside");
	Object.assign(f.backend, { supportsFsListBounded: false });
	await expect(browseWorkspaceDirectory("n", context, input, { access: f.access })).rejects.toThrow(
		"upgrade required",
	);
	expect(f.listBounded).not.toHaveBeenCalled();
	expect(f.backend.listDir).not.toHaveBeenCalled();
});
test("UNC and Windows grammar remain on the target device", async () => {
	const ctx = { ...context, cwd: "\\\\host\\share\\repo", pathFlavor: "windows" as const };
	const f = fixture(ctx);
	const result = await browseWorkspaceDirectory(
		"n",
		ctx,
		{ ...input, path: "folder" },
		{ access: f.access },
	);
	expect(f.listBounded.mock.calls[0]?.[0]).toBe("\\\\host\\share\\repo\\folder");
	expect(result.entries[0]?.path).toBe("\\\\host\\share\\repo\\folder\\escape");
});
test("caller cancellation prevents directory IO", async () => {
	const f = fixture();
	const controller = new AbortController();
	controller.abort(new Error("cancelled"));
	await expect(
		browseWorkspaceDirectory("n", context, input, { access: f.access, signal: controller.signal }),
	).rejects.toThrow("cancelled");
	expect(f.listBounded).not.toHaveBeenCalled();
});
test("path amplification is capped at the final response boundary", async () => {
	const ctx = { ...context, cwd: `/${"x".repeat(8000)}` };
	const f = fixture(ctx);
	f.listBounded.mockResolvedValue({
		entries: Array.from({ length: 500 }, (_, i) => ({ name: `entry-${i}`, isDirectory: true })),
		truncated: false,
		scanned: 500,
		reason: "",
	});
	const result = await browseWorkspaceDirectory("n", ctx, input, { access: f.access });
	expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
		WORKSPACE_BROWSER_LIMITS.maxBytes,
	);
	expect(result.truncated).toBe(true);
	expect(result.reason).toBe("byte_limit");
});
