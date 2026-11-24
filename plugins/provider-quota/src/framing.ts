export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_FRAME_BYTES = 512 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** Incremental parser allocates once, only after validating Content-Length. */
export class ContentLengthDecoder {
	private header = new Uint8Array(MAX_HEADER_BYTES + 4);
	private headerLength = 0;
	private body: Uint8Array | undefined;
	private received = 0;
	constructor(
		private onMessage: (value: unknown) => void,
		private maxFrameBytes = MAX_FRAME_BYTES,
	) {}
	feed(chunk: Uint8Array): void {
		let offset = 0;
		while (offset < chunk.byteLength) {
			if (this.body === undefined) {
				this.header[this.headerLength++] = chunk[offset++];
				const end = this.headerLength - 4;
				if (
					end < 0 ||
					this.header[end] !== 13 ||
					this.header[end + 1] !== 10 ||
					this.header[end + 2] !== 13 ||
					this.header[end + 3] !== 10
				) {
					if (this.headerLength === this.header.byteLength)
						throw new Error("RPC header budget exceeded");
					continue;
				}
				let length: number | undefined;
				for (const line of decoder.decode(this.header.subarray(0, end)).split("\r\n")) {
					const colon = line.indexOf(":");
					if (colon <= 0) throw new Error("Invalid RPC header");
					if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
					const raw = line.slice(colon + 1).trim();
					if (length !== undefined || !/^\d+$/.test(raw)) throw new Error("Invalid Content-Length");
					length = Number(raw);
				}
				if (
					length === undefined ||
					!Number.isSafeInteger(length) ||
					length <= 0 ||
					length > this.maxFrameBytes
				)
					throw new Error("RPC frame budget exceeded");
				this.body = new Uint8Array(length);
				this.headerLength = 0;
			}
			const count = Math.min(this.body.byteLength - this.received, chunk.byteLength - offset);
			this.body.set(chunk.subarray(offset, offset + count), this.received);
			this.received += count;
			offset += count;
			if (this.received !== this.body.byteLength) continue;
			const json = decoder.decode(this.body);
			this.body = undefined;
			this.received = 0;
			this.onMessage(JSON.parse(json));
		}
	}
	finish(): void {
		if (this.headerLength || this.body !== undefined) throw new Error("Incomplete RPC frame");
	}
}
export function encodeFrame(value: unknown, maxBytes = 24 * 1024): Uint8Array {
	const json = JSON.stringify(value);
	if (json.length > maxBytes) throw new Error("RPC output budget exceeded");
	const body = encoder.encode(json);
	if (body.byteLength > maxBytes) throw new Error("RPC output budget exceeded");
	const header = encoder.encode(
		`Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
	);
	const frame = new Uint8Array(header.byteLength + body.byteLength);
	frame.set(header);
	frame.set(body, header.byteLength);
	return frame;
}
