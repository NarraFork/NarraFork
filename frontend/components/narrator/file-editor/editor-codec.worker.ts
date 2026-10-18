import type { EditorRawEncoding } from "@shared/editor-document";
import { EditorStreamCodec } from "@shared/editor-stream-codec";

let codec: EditorStreamCodec | undefined;
self.onmessage = (
	event: MessageEvent<{ encoding?: EditorRawEncoding; bytes?: Uint8Array; eof?: boolean }>,
) => {
	try {
		const request = event.data;
		if (request.encoding) {
			codec = new EditorStreamCodec(request.encoding);
			self.postMessage({ ready: true });
			return;
		}
		if (!codec || !request.bytes) throw new Error("EDITOR_CODEC_NOT_READY");
		const output = codec.push(request.bytes, request.eof);
		const metadata = request.eof ? codec.finish() : undefined;
		self.postMessage({ ...output, metadata }, [output.tags.buffer]);
		if (request.eof) codec = undefined;
	} catch (error) {
		codec = undefined;
		self.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
};
