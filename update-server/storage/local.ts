/**
 * Local filesystem storage backend.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import type { StorageBackend } from "./types";

/** Thrown when a storage path would escape the configured base directory. */
export class UnsafeStoragePathError extends Error {
	constructor(path: string) {
		super(`Unsafe storage path: ${path}`);
		this.name = "UnsafeStoragePathError";
	}
}

export class LocalStorage implements StorageBackend {
	private readonly resolvedBaseDir: string;

	constructor(private readonly baseDir: string) {
		if (!existsSync(baseDir)) {
			mkdirSync(baseDir, { recursive: true });
		}
		this.resolvedBaseDir = resolvePath(baseDir);
	}

	/**
	 * Join a storage-relative path against the base directory, refusing anything
	 * that escapes it. Route handlers interpolate request parameters into storage
	 * paths, so containment is enforced here rather than trusting every caller.
	 */
	private resolve(path: string): string {
		if (!path || isAbsolute(path)) throw new UnsafeStoragePathError(path);
		if (path.includes("\0")) throw new UnsafeStoragePathError(path);
		const full = resolvePath(join(this.resolvedBaseDir, path));
		const rel = relative(this.resolvedBaseDir, full);
		if (rel === "" || rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel)) {
			throw new UnsafeStoragePathError(path);
		}
		// On Windows, relative() may use backslashes for the traversal prefix.
		if (rel.startsWith("..\\")) throw new UnsafeStoragePathError(path);
		return full;
	}

	async saveFile(path: string, data: Buffer | ReadableStream): Promise<void> {
		const fullPath = this.resolve(path);
		const dir = dirname(fullPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		if (Buffer.isBuffer(data)) {
			writeFileSync(fullPath, data);
		} else {
			// ReadableStream → collect into Buffer
			const chunks: Uint8Array[] = [];
			const reader = (data as ReadableStream).getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
			}
			const buf = Buffer.concat(chunks);
			writeFileSync(fullPath, buf);
		}
	}

	async getFile(path: string): Promise<Buffer | null> {
		const fullPath = this.resolve(path);
		if (!existsSync(fullPath)) return null;
		try {
			return readFileSync(fullPath);
		} catch {
			return null;
		}
	}

	async getFileStream(path: string): Promise<ReadableStream | null> {
		const fullPath = this.resolve(path);
		if (!existsSync(fullPath)) return null;
		try {
			const file = Bun.file(fullPath);
			return file.stream();
		} catch {
			return null;
		}
	}

	async getFileSize(path: string): Promise<number | null> {
		const fullPath = this.resolve(path);
		if (!existsSync(fullPath)) return null;
		try {
			return statSync(fullPath).size;
		} catch {
			return null;
		}
	}

	async deleteFile(path: string): Promise<void> {
		const fullPath = this.resolve(path);
		if (existsSync(fullPath)) {
			try {
				unlinkSync(fullPath);
			} catch {
				// ignore
			}
		}
	}

	async deleteDirectory(path: string): Promise<void> {
		const fullPath = this.resolve(path);
		if (existsSync(fullPath)) {
			try {
				rmSync(fullPath, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	}

	async listFiles(prefix: string): Promise<string[]> {
		const fullPath = this.resolve(prefix);
		if (!existsSync(fullPath)) return [];

		const results: string[] = [];
		const walk = (dir: string) => {
			try {
				const entries = readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					const entryPath = join(dir, entry.name);
					if (entry.isDirectory()) {
						walk(entryPath);
					} else {
						results.push(relative(this.baseDir, entryPath));
					}
				}
			} catch {
				// ignore
			}
		};

		try {
			const stat = statSync(fullPath);
			if (stat.isDirectory()) {
				walk(fullPath);
			} else {
				results.push(relative(this.baseDir, fullPath));
			}
		} catch {
			// ignore
		}

		return results;
	}

	async fileExists(path: string): Promise<boolean> {
		return existsSync(this.resolve(path));
	}

	async getFileSliceStream(
		path: string,
		start: number,
		end: number,
	): Promise<ReadableStream | null> {
		const fullPath = this.resolve(path);
		if (!existsSync(fullPath)) return null;
		try {
			return Bun.file(fullPath)
				.slice(start, end + 1)
				.stream();
		} catch {
			return null;
		}
	}
}
