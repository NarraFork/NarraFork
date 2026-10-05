import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { NARRATOR_BACKUP_LIMITS } from "@shared/narrator-backup";
import * as fileDownload from "../file-download";
import {
	BACKUP_BUFFER_DOWNLOAD_BYTES,
	downloadNarratorBackup,
	narratorBackupsApi,
} from "./narrator-backups";

const originals = new Map<string, PropertyDescriptor | undefined>();
const calls: Array<{ url: string; init?: RequestInit }> = [];
let response: () => Response = () => Response.json({});
let saved: ReturnType<typeof spyOn<typeof fileDownload, "saveBlobAsFile">>;
function install(name: string, value: unknown) {
	if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
beforeEach(() => {
	calls.length = 0;
	response = () => Response.json({});
	install("localStorage", { getItem: () => "private-session-token" });
	install("showSaveFilePicker", undefined);
	install("fetch", async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		return response();
	});
	saved = spyOn(fileDownload, "saveBlobAsFile").mockImplementation(() => {});
});
afterEach(() => {
	saved.mockRestore();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

describe("private narrator backup API", () => {
	test("real namespace plan/export/job/cancel/preview/restore contracts do not use public shares", async () => {
		await narratorBackupsApi.plan({ narratorIds: ["n"], profile: "conversation-tree-v1" });
		await narratorBackupsApi.export({ narratorIds: ["n"], profile: "conversation-state-v1" });
		await narratorBackupsApi.job("job:1");
		await narratorBackupsApi.cancel("job:1");
		await narratorBackupsApi.preview({ artifactId: "owned", mapping: { devices: { old: "new" } } });
		await narratorBackupsApi.restore({ artifactId: "owned" });
		expect(calls.map((call) => call.url)).toEqual([
			"/api/narrator-backups/plan",
			"/api/narrator-backups/exports",
			"/api/narrator-backups/jobs/job%3A1",
			"/api/narrator-backups/jobs/job%3A1",
			"/api/narrator-backups/preview",
			"/api/narrator-backups/restore",
		]);
		expect(calls[3]?.init?.method).toBe("DELETE");
		expect(calls[4]?.init?.body).toBe('{"artifactId":"owned","mapping":{"devices":{"old":"new"}}}');
	});
	test("bounded download authenticates via header, never JWT URL", async () => {
		response = () => new Response("fixture-bytes");
		await downloadNarratorBackup("owned:id");
		expect(calls[0]?.url).toBe("/api/narrator-backups/artifacts/owned%3Aid/download");
		expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe(
			"Bearer private-session-token",
		);
		expect(calls[0]?.url).not.toContain("token");
		expect(saved).toHaveBeenCalledTimes(1);
		expect(saved.mock.calls[0]?.[0].size).toBe(13);
	});
	test("owner denial cancels body and never exposes download bytes", async () => {
		const cancelled = mock(() => {});
		response = () => new Response(new ReadableStream({ cancel: cancelled }), { status: 403 });
		await expect(downloadNarratorBackup("public-read")).rejects.toThrow("403");
		expect(cancelled).toHaveBeenCalled();
		expect(saved).not.toHaveBeenCalled();
	});
	test("oversized declared object refuses fallback before buffering", async () => {
		const cancelled = mock(() => {});
		response = () =>
			new Response(new ReadableStream({ cancel: cancelled }), {
				headers: { "Content-Length": String(BACKUP_BUFFER_DOWNLOAD_BYTES + 1) },
			});
		await expect(downloadNarratorBackup("large")).rejects.toThrow("streaming save");
		expect(cancelled).toHaveBeenCalled();
		expect(saved).not.toHaveBeenCalled();
	});
	test("missing Content-Length cannot bypass the hard buffer ceiling", async () => {
		const chunk = new Uint8Array(1024 * 1024);
		const cancelled = mock(() => {});
		response = () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.enqueue(chunk);
					},
					cancel: cancelled,
				}),
			);
		await expect(downloadNarratorBackup("large")).rejects.toThrow("byte budget");
		expect(cancelled).toHaveBeenCalled();
		expect(saved).not.toHaveBeenCalled();
	});
	test("large artifact streams to selected file and aborts partial writes on failure", async () => {
		const write = mock(async (_chunk: Uint8Array) => {
			throw new Error("disk fixture full");
		});
		const abort = mock(async () => {});
		install("showSaveFilePicker", async () => ({
			createWritable: async () => ({ write, abort, close: async () => {} }),
		}));
		response = () =>
			new Response("fixture-bytes", {
				headers: { "Content-Length": String(BACKUP_BUFFER_DOWNLOAD_BYTES + 1) },
			});
		await expect(downloadNarratorBackup("large")).rejects.toThrow("disk fixture full");
		expect(write).toHaveBeenCalled();
		expect(abort).toHaveBeenCalled();
		expect(saved).not.toHaveBeenCalled();
	});
	test("streaming path writes chunks instead of collecting blob", async () => {
		const write = mock(async (_chunk: Uint8Array) => {});
		const close = mock(async () => {});
		install("showSaveFilePicker", async () => ({
			createWritable: async () => ({ write, close, abort: async () => {} }),
		}));
		response = () => new Response("bytes");
		await downloadNarratorBackup("streamed");
		expect(write).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(saved).not.toHaveBeenCalled();
	});
	test("upload uses raw bounded SQLite body; oversized input never sends", async () => {
		response = () => Response.json({ artifactId: "foreign", verifiedSameInstance: false });
		const file = new File(["fixture"], "backup.sqlite");
		expect(await narratorBackupsApi.upload(file)).toEqual({
			artifactId: "foreign",
			verifiedSameInstance: false,
		});
		expect(calls[0]?.init?.body).toBe(file);
		expect(new Headers(calls[0]?.init?.headers).get("Content-Type")).toBe(
			"application/octet-stream",
		);
		Object.defineProperty(file, "size", {
			value: NARRATOR_BACKUP_LIMITS.totalObjectBytes + NARRATOR_BACKUP_LIMITS.stateBytes * 2 + 1,
		});
		await expect(narratorBackupsApi.upload(file)).rejects.toThrow("byte budget");
		expect(calls).toHaveLength(1);
	});
});
