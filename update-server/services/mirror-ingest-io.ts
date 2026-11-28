import { createHash } from "node:crypto";
import {
	MIRROR_MAIN_TRANSFER_TIMEOUT_MS,
	type MirrorAssetDescriptor,
	type MirrorSnapshot,
} from "../../shared/independent-update-mirror";
import { validateReleasePatchMetadata } from "../../shared/release-patch";
import { parseUpdateNotes } from "../../shared/update-index";
import type { StorageBackend } from "../storage/types";

export const objectPath = (sha256: string) => `mirror-objects/${sha256}`;

/** Small metadata only; streamed byte cap, cancellation and deadline apply even to stalled readers. */
export async function readMirrorBounded(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
	signal: AbortSignal,
): Promise<Buffer> {
	if (!body) throw new Error("Missing metadata body");
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let reject: (error: Error) => void = () => {};
	const cancelled = new Promise<never>((_, r) => {
		reject = r;
	});
	const abort = () => reject(new Error("Mirror request aborted"));
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => reject(new Error("Mirror metadata deadline exceeded")), 15_000);
	try {
		if (signal.aborted) throw new Error("Mirror request aborted");
		while (true) {
			const { done, value } = await Promise.race([reader.read(), cancelled]);
			if (done) break;
			total += value.byteLength;
			if (total > limit) throw new Error("Mirror metadata byte limit exceeded");
			chunks.push(value);
		}
		return Buffer.concat(chunks, total);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
	}
}

export async function verifyMirrorAsset(
	storage: StorageBackend,
	asset: MirrorAssetDescriptor,
	signal: AbortSignal,
): Promise<Buffer | undefined> {
	const path = objectPath(asset.sha256);
	if ((await storage.getFileSize(path)) !== asset.size)
		throw new Error("Required mirror asset missing or truncated");
	const stream = await storage.getFileStream(path);
	if (!stream) throw new Error("Required mirror asset missing");
	if (
		asset.kind !== "main-binary" &&
		asset.kind !== "patch" &&
		asset.kind !== "helpers-binary" &&
		asset.kind !== "executor-binary" &&
		asset.kind !== "remote-peer-binary"
	) {
		const bytes = await readMirrorBounded(stream, asset.size, signal);
		if (
			bytes.length !== asset.size ||
			createHash("sha256").update(bytes).digest("hex") !== asset.sha256
		)
			throw new Error("Mirror metadata SHA256 mismatch");
		return bytes;
	}
	const reader = stream.getReader();
	const hash = createHash("sha256");
	let count = 0;
	let reject: (reason: Error) => void = () => {};
	const interrupted = new Promise<never>((_, r) => {
		reject = r;
	});
	const abort = () => reject(new Error("Mirror verification aborted"));
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(
		() => reject(new Error("Mirror verification deadline exceeded")),
		asset.kind === "main-binary" ? MIRROR_MAIN_TRANSFER_TIMEOUT_MS : 120_000,
	);
	try {
		if (signal.aborted) throw new Error("Mirror verification aborted");
		while (true) {
			const { done, value } = await Promise.race([reader.read(), interrupted]);
			if (done) break;
			count += value.byteLength;
			if (count > asset.size) throw new Error("Mirror asset size mismatch");
			hash.update(value);
		}
		if (count !== asset.size || hash.digest("hex") !== asset.sha256)
			throw new Error("Mirror asset SHA256 mismatch");
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
	}
}

export function validateMirrorMetadata(
	snapshot: MirrorSnapshot,
	asset: MirrorAssetDescriptor,
	bytes: Buffer,
) {
	const value = JSON.parse(bytes.toString("utf8"));
	const release = snapshot.index.releases.find((r) => r.version === snapshot.targetVersion);
	if (!release) throw new Error("Missing canonical target");
	if (asset.kind === "notes")
		return parseUpdateNotes(value, snapshot.repository, snapshot.targetVersion);
	const file = release.files.find((f) => f.platform === asset.platform);
	if (!file) throw new Error("Metadata platform mismatch");
	if (asset.kind === "patch-meta") {
		const patch = file.patches.find((p) => p.metadata.name === asset.name);
		if (!patch) throw new Error("Metadata patch missing");
		return validateReleasePatchMetadata(value, {
			fromVersion: patch.fromVersion,
			toVersion: release.version,
			patchSize: patch.size,
			newFileSize: file.size,
			newFileSha512: file.sha512,
		});
	}
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value.name !== file.name ||
		value.version !== release.version ||
		value.platform !== file.platform ||
		value.target !== `bun-${file.platform.replace(/^win-/, "windows-")}` ||
		typeof value.commit !== "string" ||
		!/^[a-f0-9]{7,40}$/.test(value.commit) ||
		!release.commit.startsWith(value.commit) ||
		value.size !== file.size ||
		value.sha256 !== file.sha256 ||
		value.sha512 !== file.sha512 ||
		(value.repository !== undefined &&
			String(value.repository).toLowerCase() !== snapshot.repository)
	)
		throw new Error("Binary sidecar canonical identity mismatch");
}
