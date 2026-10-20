import { constants } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getNarraforkHome } from "./narrafork-home";

/** One bounded asynchronous writer; diagnostics never backpressure a request. */
export class DiagnosticWriter {
	private queue: string[] = [];
	private bytes = 0;
	private running: Promise<void> | undefined;
	dropped = 0;
	constructor(private readonly writeBatch: (batch: string) => Promise<void>) {}

	write(line: string): void {
		const size = Buffer.byteLength(line);
		if (!size || size > 4096 || this.bytes + size > 256 * 1024 || this.queue.length >= 4096) {
			this.dropped++;
			return;
		}
		this.queue.push(line);
		this.bytes += size;
		this.running ??= Promise.resolve().then(() => this.drain());
	}
	private async drain(): Promise<void> {
		try {
			while (this.queue.length) {
				const batch = this.queue.splice(0, 16).join("");
				try {
					await this.writeBatch(batch);
				} catch {
					this.dropped += batch.split("\n").length - 1;
				} finally {
					this.bytes -= Buffer.byteLength(batch);
				}
			}
		} finally {
			this.running = undefined;
		}
	}
	async flush(): Promise<void> {
		await this.running;
	}
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
export function createDiagnosticFileWriter(home: string): DiagnosticWriter {
	let initialized = false;
	let fileBytes = 0;
	const path = join(home, "request-diagnostics.jsonl");
	return new DiagnosticWriter(async (batch) => {
		if (!initialized) {
			await mkdir(home, { recursive: true, mode: 0o700 });
			fileBytes = await stat(path).then(
				(s) => s.size,
				() => 0,
			);
			initialized = true;
		}
		if (fileBytes + Buffer.byteLength(batch) > MAX_FILE_BYTES) {
			await unlink(`${path}.2`).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
			await rename(`${path}.1`, `${path}.2`).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
			await rename(path, `${path}.1`).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
			fileBytes = 0;
		}
		const file = await open(
			path,
			constants.O_CREAT |
				constants.O_APPEND |
				constants.O_WRONLY |
				(constants.O_NOFOLLOW ?? 0) |
				(constants.O_NONBLOCK ?? 0),
			0o600,
		);
		try {
			const metadata = await file.stat();
			if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("unsafe diagnostic file");
			await file.chmod(0o600);
			await file.writeFile(batch);
			fileBytes += Buffer.byteLength(batch);
		} catch (error) {
			initialized = false;
			throw error;
		} finally {
			await file.close();
		}
	});
}
export const requestDiagnosticWriter = createDiagnosticFileWriter(getNarraforkHome());
