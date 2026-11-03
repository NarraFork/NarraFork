import { readFileSync } from "node:fs";

/** A complete PCM WAV with eight silent samples (not just a signature). */
export function wavBytes(): Buffer<ArrayBuffer> {
	const bytes = Buffer.alloc(60);
	bytes.write("RIFF", 0);
	bytes.writeUInt32LE(bytes.length - 8, 4);
	bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(8000, 24);
	bytes.writeUInt32LE(16000, 28);
	bytes.writeUInt16LE(2, 32);
	bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36);
	bytes.writeUInt32LE(16, 40);
	return bytes;
}

/** Complete two-sample AAC MP4, from mathiasbynens/small's mp4-with-audio.mp4. */
export const AUDIO_MP4 = readFileSync(new URL("./native-media-aac.mp4", import.meta.url));

/** Bounded EBML fixture with DocType / Tracks / TrackEntry elements. */
export function webmBytes(trackTypes: number[]): Buffer {
	const entries = Buffer.concat(
		trackTypes.map((type) => Buffer.from([0xae, 0x83, 0x83, 0x81, type])),
	);
	return Buffer.concat([
		Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84]),
		Buffer.from("webm"),
		Buffer.from([
			0x18,
			0x53,
			0x80,
			0x67,
			0x80 + entries.length + 5,
			0x16,
			0x54,
			0xae,
			0x6b,
			0x80 + entries.length,
		]),
		entries,
	]);
}

export const wavFile = (name = "voice.wav") =>
	new File([new Uint8Array(wavBytes())], name, { type: "audio/wav" });
