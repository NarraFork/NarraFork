import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createFixture, type FixtureSpec, MiB } from "./smoke-monaco-large-file-data";

// Deliberately a protocol fixture, not the production filesystem service. It never
// reads application credentials, a database, or an actual user's editable files.
export function createFullProtocolFixture(base = "/", keyboardCount = 100) {
	let current: FixtureSpec | undefined;
	let sequence = 0;
	let savedBytes = 0;
	let commits = 0;
	let savedRevision = 0;
	let forceConflict = false;
	let source: Buffer | undefined;
	let expectedSavedDigest = "";
	let savedDigest = "";
	const requests: { method: string; path: string; bytes: number }[] = [];
	const uploads = new Map<
		string,
		{ revision: number; bytes: number; digest: string; sealed: boolean }
	>();
	const json = (response: ServerResponse, value: unknown, status = 200) => {
		response.statusCode = status;
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify(value));
	};
	const readMetadata = async (request: IncomingMessage) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		for await (const chunk of request) {
			bytes += chunk.length;
			if (bytes > 32 * 1024) throw new Error("Fixture metadata too large");
			chunks.push(Buffer.from(chunk));
		}
		return JSON.parse(Buffer.concat(chunks).toString() || "{}");
	};
	return {
		reset(spec: FixtureSpec) {
			current = spec;
			source = undefined;
			expectedSavedDigest = "";
			savedDigest = "";
			uploads.clear();
			requests.length = 0;
			sequence = 0;
			commits = 0;
			savedBytes = 0;
			savedRevision = 0;
			forceConflict = false;
		},
		async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (base !== "/" && url.pathname.startsWith(base))
				url.pathname = `/${url.pathname.slice(base.length)}`;
			if (url.pathname === "/bench/state") {
				json(response, {
					commits,
					savedBytes,
					savedRevision,
					savedDigest,
					expectedSavedDigest,
					exactScriptedBytes: !!savedDigest && savedDigest === expectedSavedDigest,
					requests,
					sourceBytes: source?.byteLength ?? 0,
				});
				return true;
			}
			if (url.pathname === "/bench/conflict") {
				forceConflict = true;
				json(response, { armed: true });
				return true;
			}
			if (!url.pathname.startsWith("/api/")) return false;
			if (!url.pathname.includes("/editor-documents")) {
				json(response, { error: "Unexpected application API in isolated fixture" }, 404);
				return true;
			}
			if (!current) throw new Error("Fixture was not initialized");
			if (requests.length >= 100) throw new Error("Fixture request cap exceeded");
			const entry = { method: request.method ?? "GET", path: url.pathname, bytes: 0 };
			requests.push(entry);
			const parts = url.pathname.split("/");
			const docAt = parts.indexOf("editor-documents");
			const rest = parts.slice(docAt + 1);
			if (!rest.length && request.method === "POST") {
				const input = await readMetadata(request);
				if (!source) {
					const original = createFixture(current).content;
					source = Buffer.from(original);
					// Independent oracle for this benchmark's fixed edits: 100 x keys,
					// committed Chinese IME at line 3, then explicit 1024-unit suffix deletion.
					const firstNewline = original.indexOf("\n");
					const secondNewline = firstNewline < 0 ? -1 : original.indexOf("\n", firstNewline + 1);
					const at = secondNewline < 0 ? 0 : secondNewline + 1;
					const expected =
						`${original.slice(0, at)}中文输入${"x".repeat(keyboardCount)}${original.slice(at)}`.slice(
							0,
							-1024,
						);
					expectedSavedDigest = createHash("sha256").update(expected, "utf8").digest("hex");
				}
				json(response, {
					docId: `doc-${++sequence}`,
					target: { deviceId: "local", path: input.path },
					versionHandle: "source-1",
					baseHash: "base-1",
					encoding: "utf-8",
					eol: "LF",
					sourceBytes: source.length,
					utf8Bytes: source.length,
				});
				return true;
			}
			if (rest[1] === "content" && request.method === "GET") {
				if (!source) throw new Error("Missing fixture source");
				response.setHeader("Content-Type", "text/plain; charset=utf-8");
				response.setHeader("Content-Length", source.length);
				response.end(source);
				return true;
			}
			if (request.method === "DELETE") {
				if (rest[2]) uploads.delete(rest[2]);
				response.statusCode = 204;
				response.end();
				return true;
			}
			if (rest[1] === "uploads" && !rest[2] && request.method === "POST") {
				if (uploads.size >= 8) throw new Error("Fixture upload cap exceeded");
				const input = await readMetadata(request);
				const uploadId = `upload-${++sequence}`;
				uploads.set(uploadId, {
					revision: input.snapshotRevision,
					bytes: 0,
					digest: "",
					sealed: false,
				});
				json(response, { uploadId, state: "uploading" });
				return true;
			}
			const upload = uploads.get(rest[2] ?? "");
			if (rest[1] === "uploads" && rest.length === 3 && request.method === "PUT") {
				if (!upload || upload.sealed) throw new Error("Invalid fixture upload state");
				request.setTimeout(10_000, () => request.destroy(new Error("Fixture upload idle timeout")));
				const hash = createHash("sha256");
				for await (const chunk of request) {
					upload.bytes += chunk.length;
					if (upload.bytes > 64 * MiB) throw new Error("Fixture upload exceeded 64MiB");
					hash.update(chunk);
				}
				upload.digest = hash.digest("hex");
				upload.sealed = true;
				entry.bytes = upload.bytes;
				json(response, {
					uploadId: rest[2],
					state: "sealed",
					bytes: upload.bytes,
					digest: upload.digest,
				});
				return true;
			}
			if (rest[3] === "commit" && request.method === "POST") {
				await readMetadata(request);
				if (!upload?.sealed) throw new Error("Unsealed fixture commit");
				if (forceConflict) {
					forceConflict = false;
					json(
						response,
						{
							error: "Fixture concurrent write",
							code: "STALE_WRITE",
							currentHash: "conflict-1",
							conflictVersionHandle: "source-1",
							encoding: "utf-8",
							size: source?.length ?? 0,
						},
						409,
					);
					return true;
				}
				if (upload.bytes > 20 * MiB) {
					json(response, { error: "Fixture final file exceeds 20MiB" }, 413);
					return true;
				}
				commits++;
				savedBytes = upload.bytes;
				savedRevision = upload.revision;
				savedDigest = upload.digest;
				json(response, {
					status: "saved",
					operationId: `operation-${commits}`,
					hash: upload.digest,
					bytes: upload.bytes,
					snapshotRevision: upload.revision,
				});
				return true;
			}
			json(response, { error: "Unhandled isolated editor protocol request" }, 404);
			return true;
		},
	};
}
