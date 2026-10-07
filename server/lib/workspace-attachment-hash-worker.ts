import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { WORKSPACE_ATTACHMENT_MAX_BYTES } from "@shared/workspace-attachment-protocol";

self.onmessage = async (event: MessageEvent<{ path: string; sizeBytes: number }>) => {
	try {
		const { path, sizeBytes } = event.data;
		if (
			!Number.isSafeInteger(sizeBytes) ||
			sizeBytes < 0 ||
			sizeBytes > WORKSPACE_ATTACHMENT_MAX_BYTES
		)
			throw new Error("Attachment hash byte limit exceeded");
		const file = await open(path, "r");
		try {
			const before = await file.stat({ bigint: true });
			if (!before.isFile() || before.size !== BigInt(sizeBytes))
				throw new Error("Staged attachment size changed");
			const hash = createHash("sha256");
			const buffer = Buffer.allocUnsafe(64 * 1024);
			let offset = 0;
			while (offset < sizeBytes) {
				const read = await file.read(
					buffer,
					0,
					Math.min(buffer.length, sizeBytes - offset),
					offset,
				);
				if (read.bytesRead < 1) throw new Error("Staged attachment ended early");
				hash.update(buffer.subarray(0, read.bytesRead));
				offset += read.bytesRead;
			}
			const after = await file.stat({ bigint: true });
			if (
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				before.size !== after.size ||
				before.mtimeNs !== after.mtimeNs ||
				before.ctimeNs !== after.ctimeNs
			)
				throw new Error("Staged attachment changed during hashing");
			self.postMessage({ digest: hash.digest("hex") });
		} finally {
			await file.close();
		}
	} catch (error) {
		self.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
};
