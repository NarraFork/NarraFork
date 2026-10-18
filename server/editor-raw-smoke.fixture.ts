import { createHash } from "node:crypto";
import type { EditorRawEncoding } from "../shared/editor-document";
import { EditorStreamCodec } from "../shared/editor-stream-codec";
import { isCompiledRuntime } from "./lib/runtime-target";
import { EditorDocumentJobs } from "./services/editor-document-jobs";
import { EditorDocumentStreams } from "./services/editor-document-streams";

if (!isCompiledRuntime()) throw new Error("This fixture must run as a compiled binary");
const path = process.argv[2];
if (!path) throw new Error("Fixture source required");
const streams = new EditorDocumentStreams();
const jobs = new EditorDocumentJobs();
try {
	const metadata = await streams.metadata(
		"smoke",
		path,
		process.argv[3] as EditorRawEncoding | undefined,
	);
	const source = await streams.open("smoke", "document", path, undefined, metadata);
	let bytes = 0;
	const codec = new EditorStreamCodec(metadata.encoding),
		format = createHash("sha256");
	for (;;) {
		const chunk = await streams.chunk("document", source.readId, bytes, 65536);
		bytes += chunk.bytes?.length ?? 0;
		format.update(codec.push(chunk.bytes ?? new Uint8Array(), chunk.eof).tags);
		if (chunk.eof) break;
	}
	if (bytes !== metadata.sourceBytes) throw new Error("Compiled stream byte mismatch");
	await streams.close("document", source.readId);
	codec.finish();
	const sealed = await jobs.run("smoke", {
		action: "raw-seal",
		path,
		encoding: metadata.encoding,
		bom: metadata.bom,
		expected: {
			protocol: "raw-v2",
			hashKind: "raw-sha256",
			bytes,
			rawDigest: metadata.baseHash,
			textDigest: metadata.textDigest,
			formatDigest: format.digest("hex"),
			textLength: metadata.textLength,
			newlines: metadata.lineCount - 1,
		},
	});
	if (sealed.kind !== "sealed" || sealed.bytes !== bytes || sealed.digest !== metadata.baseHash)
		throw new Error("Compiled raw seal mismatch");
	const counters = await streams.workers.counters();
	if (counters.some((value) => value?.fds)) throw new Error("Compiled source FD leak");
	console.info(
		JSON.stringify({
			compiled: true,
			sealed,
			bytes,
			hashKind: metadata.hashKind,
			encoding: metadata.encoding,
			counters,
			admission: streams.diagnostics,
		}),
	);
} finally {
	await streams.dispose();
}
