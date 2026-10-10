import { open, rm } from "node:fs/promises";
import type { ReleasePatchMetadata } from "../../shared/release-patch";
import { updateServerChildEnvironment } from "../../shared/update-server-child-env";
import { hashReleaseFile } from "./ci-release-io";

/** Bridge-only generator: stdout/disk, stderr, wall time and parent cancellation are bounded. */
export async function generateBridgePatch(options: {
	oldFilePath: string;
	newFilePath: string;
	patchOutputPath: string;
	fromVersion: string;
	toVersion: string;
	maxPatchBytes: number;
	signal: AbortSignal;
}): Promise<ReleasePatchMetadata> {
	if (!Number.isSafeInteger(options.maxPatchBytes) || options.maxPatchBytes <= 0)
		throw new Error("Invalid bridge patch output budget");
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(15 * 60 * 1000)]);
	signal.throwIfAborted();
	const handle = await open(options.patchOutputPath, "wx", 0o600);
	let success = false;
	let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const abort = () => child?.kill("SIGKILL");
	try {
		child = Bun.spawn(
			[
				"zstd",
				`--patch-from=${options.oldFilePath}`,
				options.newFilePath,
				"--stdout",
				"-19",
				"--long=31",
			],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: updateServerChildEnvironment(),
			},
		);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		const diagnostic = (async () => {
			let bytes = 0;
			for await (const chunk of child.stderr) {
				bytes += chunk.byteLength;
				if (bytes > 64 * 1024) {
					abort();
					throw new Error("Bridge zstd diagnostic cap exceeded");
				}
			}
		})();
		// Attach immediately, so a diagnostic failure cannot become an unhandled rejection.
		const diagnosticsDone = diagnostic.then(
			() => true,
			() => false,
		);
		reader = child.stdout.getReader();
		let size = 0;
		while (true) {
			signal.throwIfAborted();
			const chunk = await reader.read(); // abort kills the child and closes its pipe
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > options.maxPatchBytes)
				throw new Error("Bridge patch exceeds multipart/output budget");
			let offset = 0;
			while (offset < chunk.value.length) {
				signal.throwIfAborted();
				const { bytesWritten } = await handle.write(
					chunk.value,
					offset,
					chunk.value.length - offset,
				);
				if (!bytesWritten) throw new Error("Bridge patch disk write failed");
				offset += bytesWritten;
			}
		}
		const [code, diagnosticOk] = await Promise.all([child.exited, diagnosticsDone]);
		signal.throwIfAborted();
		if (code !== 0 || !diagnosticOk || !size) throw new Error("Bridge zstd generation failed");
		const [oldFile, newFile] = await Promise.all([
			hashReleaseFile(options.oldFilePath, 1024 ** 3, signal),
			hashReleaseFile(options.newFilePath, 1024 ** 3, signal),
		]);
		success = true;
		return {
			fromVersion: options.fromVersion,
			toVersion: options.toVersion,
			oldFileSize: oldFile.size,
			oldFileSha512: oldFile.sha512,
			newFileSize: newFile.size,
			newFileSha512: newFile.sha512,
			stableEnd: 0,
			newTailSize: newFile.size,
			patchSize: size,
			mode: "patch-from",
		};
	} finally {
		signal.removeEventListener("abort", abort);
		child?.kill("SIGKILL");
		void reader?.cancel().catch(() => {});
		if (child) await child.exited;
		await handle.close();
		if (!success) await rm(options.patchOutputPath, { force: true });
	}
}
