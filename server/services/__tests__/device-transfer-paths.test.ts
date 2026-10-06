import { describe, expect, test } from "bun:test";
import { resolve, win32 } from "node:path";
import {
	joinRemotePath,
	resolveDownloadManifestPath,
	validateLocalAbsolutePath,
	validateRemoteAbsolutePath,
} from "../device-transfer-service";

describe("device transfer path semantics", () => {
	test("joins Windows drive paths with Windows separators", () => {
		expect(joinRemotePath("C:\\Users\\agent\\out", "nested/file.txt", "windows")).toBe(
			"C:\\Users\\agent\\out\\nested\\file.txt",
		);
	});

	test("joins Windows UNC paths without losing the share root", () => {
		expect(joinRemotePath("\\\\server\\share\\out", "nested/file.txt", "windows")).toBe(
			"\\\\server\\share\\out\\nested\\file.txt",
		);
	});

	test("joins POSIX paths with POSIX separators", () => {
		expect(joinRemotePath("/var/lib/narrafork/out", "nested/file.txt", "linux")).toBe(
			"/var/lib/narrafork/out/nested/file.txt",
		);
	});

	test("validates paths against the target and server path semantics", () => {
		expect(validateRemoteAbsolutePath("C:\\data\\file.txt", "windows")).toBe("C:\\data\\file.txt");
		expect(validateRemoteAbsolutePath("\\\\server\\share\\file.txt", "windows")).toBe(
			"\\\\server\\share\\file.txt",
		);
		expect(validateRemoteAbsolutePath("/srv/data/file.txt", "linux")).toBe("/srv/data/file.txt");
		expect(() => validateRemoteAbsolutePath("relative/file.txt", "windows")).toThrow(
			"must be an absolute Windows drive or UNC path",
		);
		expect(() => validateRemoteAbsolutePath("\\rooted\\file.txt", "windows")).toThrow(
			"must be an absolute Windows drive or UNC path",
		);
		expect(() => validateRemoteAbsolutePath("C:\\data\\file.txt", "linux")).toThrow(
			"must be an absolute POSIX path",
		);
		expect(() => validateLocalAbsolutePath("relative/file.txt")).toThrow(
			"must be absolute on the NarraFork server",
		);
	});
});

describe("download directory manifest paths", () => {
	const localRoot = resolve("/tmp", "narrafork-download-root");

	test("resolves a safe manifest relPath inside the local root", () => {
		expect(resolveDownloadManifestPath(localRoot, "nested/file.txt")).toBe(
			resolve(localRoot, "nested/file.txt"),
		);
	});

	test("rejects POSIX, Windows drive, and UNC absolute manifest paths", () => {
		for (const relPath of [
			"/tmp/outside.txt",
			"C:\\outside\\file.txt",
			"\\\\server\\share\\file.txt",
		]) {
			expect(() => resolveDownloadManifestPath(localRoot, relPath)).toThrow(
				"Remote manifest relPath must be relative",
			);
		}
	});

	test("rejects slash and backslash traversal components", () => {
		for (const relPath of ["../outside.txt", "nested/../../outside.txt", "nested\\..\\file.txt"]) {
			expect(() => resolveDownloadManifestPath(localRoot, relPath)).toThrow(
				"Remote manifest relPath contains path traversal",
			);
		}
	});

	test("rejects a manifest destination that would resolve outside the local root", () => {
		const escaping = `nested/${Array.from({ length: 8 }, () => "..").join("/")}/outside.txt`;
		expect(() => resolveDownloadManifestPath(localRoot, escaping)).toThrow(
			/path traversal|outside/,
		);
	});

	test("does not treat a Windows drive-relative path as a safe manifest relPath", () => {
		expect(win32.isAbsolute("C:outside.txt")).toBe(false);
		expect(() => resolveDownloadManifestPath(localRoot, "C:outside.txt")).toThrow(
			"Remote manifest relPath must be relative",
		);
	});
});
