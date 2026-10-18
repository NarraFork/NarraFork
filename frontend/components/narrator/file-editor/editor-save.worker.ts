import { type EditorRawSaveFormat, EditorSaveCodec } from "./editor-save-codec";

let codec: EditorSaveCodec | undefined;
self.onmessage = async (
	event: MessageEvent<{ format?: EditorRawSaveFormat; text?: string; eof?: boolean }>,
) => {
	try {
		if (event.data.format) {
			codec = await EditorSaveCodec.create(event.data.format);
			self.postMessage({ ready: true });
			return;
		}
		if (!codec) throw new Error("EDITOR_ENCODER_NOT_READY");
		const bytes = codec.push(event.data.text ?? "", event.data.eof);
		const seal = event.data.eof ? codec.finish() : undefined;
		self.postMessage({ bytes, seal }, { transfer: [bytes.buffer] });
	} catch (error) {
		self.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
};
