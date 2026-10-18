import { expect, spyOn } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Page } from "puppeteer-core";
import type {} from "../../scripts/smoke-editor-real-io-fixture";
import { MAX_FILE_REFERENCE_SOURCE_BYTES } from "../../shared/file-reference";
import * as connection from "../services/device-connection-service";
import { RemoteBackend } from "../services/device-remote-backend";
import { createFileReferenceService } from "../services/file-reference-service";

/** Real service + RemoteBackend request/base64 handling; controlled RPC transport, not a user device. */
export function remoteEditorFixture(input: {
	path: string;
	cwd: string;
	hostCwd: string;
	narratorId: string;
	userId: string;
}) {
	const deviceId = "EditorBrowserPeer";
	const text = "// REMOTE_ONLY 中文🙂\nexport const peer = true;\n";
	const bytes = Buffer.from(text);
	let mode: "online" | "offline" | "low-capability" | "truncated" = "online";
	const calls: { method: string; path: unknown }[] = [];
	const contexts: { deviceId: string; cwd: string; canonicalPath?: string }[] = [];
	const feature = spyOn(connection, "hasDeviceProtocolFeature").mockImplementation(
		(id, name) => id === deviceId && name === "fs.read.bounded.v1" && mode !== "low-capability",
	);
	const rpc = spyOn(connection, "sendRpc").mockImplementation(async (id, method, params, opts) => {
		expect(id).toBe(deviceId);
		expect(opts?.expectedConnectionGeneration).toBe(7);
		expect(opts?.timeoutMs).toBeGreaterThan(0);
		expect(opts?.signal).toBeInstanceOf(AbortSignal);
		calls.push({ method, path: params.path });
		if (method === "fs.stat") {
			expect(opts?.requiredFeatures).toEqual(["fs.stat.resolved-path.v1"]);
			expect([input.cwd, input.path]).toContain(String(params.path));
			return {
				exists: true,
				isFile: params.path === input.path,
				isDirectory: params.path === input.cwd,
				size: params.path === input.path ? bytes.length : 0,
				resolvedPath: params.path,
			};
		}
		if (method === "fs.read") {
			expect(params.path).toBe(input.path);
			expect(params.expectedResolvedPath).toBe(input.path);
			expect(params.maxBytes).toBe(MAX_FILE_REFERENCE_SOURCE_BYTES);
			expect(params.timeoutMs).toBe(opts?.timeoutMs);
			expect(opts?.requiredFeatures).toEqual([
				"fs.read.atomic-resolved-path.v1",
				"fs.read.bounded.v1",
			]);
			return {
				dataB64: bytes.toString("base64"),
				totalSize: bytes.length,
				truncated: mode === "truncated",
				resolvedPath: input.path,
			};
		}
		throw new Error(`Unexpected editor RPC: ${method}`);
	});
	const backend = new RemoteBackend(deviceId, {
		connectionGeneration: 7,
		defaultCwd: input.cwd,
		platform: { os: "linux", arch: "x64" },
		supportsFsStatResolvedPath: true,
		supportsFsReadAtomicResolvedPath: true,
	});
	const service = createFileReferenceService({
		async loadScope(narratorId, userId, need) {
			expect({ narratorId, userId, need }).toEqual({
				narratorId: input.narratorId,
				userId: input.userId,
				need: "read",
			});
			return {
				narratorId,
				userId,
				cwd: input.hostCwd,
				defaultDeviceId: deviceId,
				devices: [
					{ id: deviceId, name: "peer", slug: "peer", online: mode !== "offline", scope: "global" },
				],
				permissionMode: "default",
			};
		},
		getBackend(id) {
			expect(id).toBe(deviceId);
			return backend;
		},
		async readDecision(_scope, context) {
			expect(context.target.deviceId).toBe(deviceId);
			expect(context.target.cwd).toBe(input.cwd);
			contexts.push({
				deviceId,
				cwd: context.target.cwd,
				canonicalPath: context.target.canonicalPath,
			});
			return "allow";
		},
		isSecretPath: () => false,
		async decode(body) {
			return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
		},
	});
	return {
		service,
		deviceId,
		async accept(page: Page, origin: string) {
			await page.waitForFunction(() => window.__editorRealIo?.state().ready);
			expect(await page.evaluate(() => window.__editorRealIo.state())).toMatchObject({
				ready: true,
				dirty: false,
				readOnly: true,
				length: text.length,
				firstLine: text.split("\n")[0],
			});
			const hostSentinel = await readFile(input.path, "utf8");
			expect(hostSentinel).not.toBe(text);
			expect(contexts.length).toBeGreaterThan(0);
			expect(contexts.every((context) => context.canonicalPath === input.path)).toBe(true);
			expect(calls.some((call) => call.method === "fs.read" && call.path === input.path)).toBe(
				true,
			);
			// Actual UI save control and keyboard paths must stay inert.
			expect(await page.$$eval('button[aria-label="Save"]', (buttons) => buttons.length)).toBe(0);
			await page.evaluate(() => window.__editorRealIo.focus());
			await page.keyboard.type("MUST_NOT_EDIT");
			await page.keyboard.down("Control");
			await page.keyboard.press("s");
			await page.keyboard.up("Control");
			expect(await page.evaluate(() => window.__editorRealIo.state())).toMatchObject({
				dirty: false,
				length: text.length,
			});
			const failures: { mode: string; code: string }[] = [];
			for (const [next, code] of [
				["offline", "FILE_REFERENCE_DEVICE_OFFLINE"],
				["low-capability", "FILE_REFERENCE_UNSUPPORTED"],
				["truncated", "FILE_REFERENCE_SOURCE_TOO_LARGE"],
			] as const) {
				mode = next;
				const before = calls.filter((call) => call.method === "fs.read").length;
				const failed = page.waitForResponse(
					(response) => response.url().includes("/file-references/") && response.status() >= 400,
				);
				await page.reload({ waitUntil: "domcontentloaded" });
				const response = await failed;
				expect(await response.json()).toHaveProperty("code", code);
				await page.waitForFunction(
					() => !!document.querySelector("button") && !document.querySelector(".monaco-editor"),
				);
				expect(await page.evaluate(() => window.__editorRealIo?.state().ready ?? false)).toBe(
					false,
				);
				expect(await readFile(input.path, "utf8")).toBe(hostSentinel);
				expect(calls.filter((call) => call.method === "fs.read").length - before).toBe(
					next === "truncated" ? 1 : 0,
				);
				failures.push({ mode: next, code });
			}
			expect(new URL(page.url()).origin).toBe(origin);
			console.info(
				"EDITOR_REMOTE_READONLY_CHROMIUM",
				JSON.stringify({
					remoteCwd: input.cwd,
					remotePath: input.path,
					backend: "RemoteBackend",
					readOnly: true,
					saveControl: "absent (read-only)",
					hostFallback: false,
					failures,
				}),
			);
		},
		restore() {
			rpc.mockRestore();
			feature.mockRestore();
		},
	};
}
