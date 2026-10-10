/** Bounded, hash-pinned local helper acquisition; never publishes assets. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, renameSync, unlinkSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export async function sha256(path: string): Promise<string> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.size < 1 || stat.size > MAX_DOWNLOAD_BYTES)
		throw new Error("Invalid cached helper size/type");
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of createReadStream(path)) {
		size += chunk.length;
		if (size > MAX_DOWNLOAD_BYTES) throw new Error("Cached helper exceeds size limit");
		hash.update(chunk);
	}
	if (size !== stat.size) throw new Error("Cached helper changed while reading");
	return hash.digest("hex");
}

export async function downloadHelperAsset(
	out: string,
	name: string,
	url: string,
	expected: string,
	sshHost?: string,
	env?: NodeJS.ProcessEnv,
) {
	const source = new URL(url);
	if (
		source.protocol !== "https:" ||
		source.hostname !== "github.com" ||
		!/^[\w/.-]+$/.test(source.pathname) ||
		source.search
	)
		throw new Error("Expected an official GitHub release URL");
	if (!/^[\w.-]+$/.test(name) || name === "." || name === "..")
		throw new Error("Invalid asset filename");
	if (sshHost && !/^[A-Za-z0-9][A-Za-z0-9@._-]*$/.test(sshHost))
		throw new Error("Invalid SSH host");
	const target = join(out, name);
	if (existsSync(target) && (await sha256(target)) === expected) return target;
	const temp = `${target}.${randomUUID()}.part`;
	const curl = [
		"curl",
		"-fsSL",
		"--max-time",
		"240",
		"--max-filesize",
		String(MAX_DOWNLOAD_BYTES),
		url,
	];
	const proc = Bun.spawn(
		sshHost
			? ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", sshHost, curl.join(" ")]
			: curl,
		{
			stdout: "pipe",
			stderr: "inherit",
			stdin: "ignore",
			env,
		},
	);
	const timer = setTimeout(() => proc.kill(), DOWNLOAD_TIMEOUT_MS);
	let bytes = 0;
	const limiter = new Transform({
		transform(chunk, _encoding, callback) {
			bytes += chunk.length;
			callback(
				bytes > MAX_DOWNLOAD_BYTES ? new Error("Download size limit exceeded") : null,
				chunk,
			);
		},
	});
	try {
		await pipeline(proc.stdout, limiter, createWriteStream(temp));
		if ((await proc.exited) !== 0) throw new Error(`Download failed: ${name}`);
		if ((await sha256(temp)) !== expected) throw new Error(`SHA-256 mismatch: ${name}`);
		renameSync(temp, target);
		return target;
	} finally {
		clearTimeout(timer);
		if (proc.exitCode === null) proc.kill();
		if (existsSync(temp)) unlinkSync(temp);
	}
}

export async function runHelperCommand(cwd: string, cmd: string[], timeoutMs = 10 * 60_000) {
	const proc = Bun.spawn(cmd, { cwd, stdio: ["ignore", "inherit", "inherit"] });
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	try {
		if ((await proc.exited) !== 0) throw new Error(`Command failed: ${cmd[0]}`);
	} finally {
		clearTimeout(timer);
	}
}
