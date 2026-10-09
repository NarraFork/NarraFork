import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isValidGitHubRepository } from "../../shared/github-repository";
import {
	type BinaryMetadata,
	type ComputeMetadataInput,
	formatChecksumsReport,
	formatSha256Sums,
} from "./binary-metadata";

export function writeBuildAggregates(
	dist: string,
	version: string,
	entries: BinaryMetadata[],
): string[] {
	if (entries.length === 0) throw new Error("Cannot aggregate missing binary metadata");
	const sumsName = `narrafork-${version}-SHA256SUMS`;
	const reportName = `narrafork-${version}-checksums.txt`;
	writeFileSync(join(dist, sumsName), formatSha256Sums(entries));
	writeFileSync(join(dist, reportName), formatChecksumsReport(version, entries));
	return [sumsName, reportName];
}

export function validateCiBuildIdentity(
	packageManager: unknown,
	bunVersion: string,
	commit: string,
): void {
	if (
		typeof packageManager !== "string" ||
		!/^bun@\d+\.\d+\.\d+$/.test(packageManager) ||
		packageManager !== `bun@${bunVersion}`
	) {
		throw new Error(
			`Release CI requires exact packageManager Bun version (${String(packageManager)}); running ${bunVersion}`,
		);
	}
	if (!/^[0-9a-f]{40}$/.test(commit))
		throw new Error("Release CI requires a full 40-character HEAD commit");
}

export type SigningRunner = (command: string[]) => Promise<void>;

/** Native system codesign only; verify before any metadata/hashing is allowed. */
export async function signCiBinary(
	target: string,
	host: string,
	path: string,
	run: SigningRunner,
): Promise<void> {
	if (!target.startsWith("bun-darwin-")) return;
	if (host !== "darwin") throw new Error("Release CI macOS signing requires a native macOS runner");
	await run(["codesign", "--force", "--sign", "-", path]);
	await run(["codesign", "--verify", "--strict", "--verbose=2", path]);
}

/** Bounded subprocess output, hard timeout and cancellation; never buffer whole logs. */
export async function runCiBuildCommand(
	command: string[],
	timeoutMs = 60_000,
	cwd?: string,
): Promise<void> {
	const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let bytes = 0;
	let diagnostic = "";
	let failure: Error | undefined;
	const stop = (error: Error) => {
		failure ??= error;
		child.kill("SIGKILL");
	};
	const timer = setTimeout(() => stop(new Error(`Command timed out: ${command[0]}`)), timeoutMs);
	const abort = () => stop(new Error(`Command cancelled: ${command[0]}`));
	process.once("SIGTERM", abort);
	process.once("SIGINT", abort);
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				bytes += value.byteLength;
				diagnostic = (diagnostic + new TextDecoder().decode(value.subarray(-8192))).slice(-8192);
				if (bytes > 64 * 1024 * 1024) {
					stop(new Error(`Command output exceeded 64 MiB: ${command[0]}`));
					return;
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	};
	try {
		const [code] = await Promise.all([child.exited, drain(child.stdout), drain(child.stderr)]);
		if (failure) throw failure;
		if (code !== 0)
			throw new Error(`Command failed (${code}): ${command.join(" ")}\n${diagnostic}`);
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGTERM", abort);
		process.removeListener("SIGINT", abort);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
}

export async function computeCiBinaryMetadata(
	path: string,
	input: ComputeMetadataInput,
): Promise<BinaryMetadata> {
	if (!/^[0-9a-f]{40}$/.test(input.commit)) throw new Error("Missing full build commit");
	if (!isValidGitHubRepository(input.repository)) throw new Error("Missing build repository");
	const before = lstatSync(path);
	if (!before.isFile() || before.size <= 0 || before.size > 1024 * 1024 * 1024) {
		throw new Error(`Invalid release binary: ${path}`);
	}
	const sha256 = createHash("sha256");
	const sha512 = createHash("sha512");
	let size = 0;
	const stream = createReadStream(path, { highWaterMark: 256 * 1024 });
	const timer = setTimeout(
		() => stream.destroy(new Error("Release binary hash timed out")),
		60_000,
	);
	try {
		for await (const chunk of stream) {
			size += chunk.length;
			if (size > 1024 * 1024 * 1024) throw new Error("Release binary exceeded 1 GiB");
			sha256.update(chunk);
			sha512.update(chunk);
		}
	} finally {
		clearTimeout(timer);
		stream.destroy();
	}
	const after = lstatSync(path);
	if (
		!after.isFile() ||
		before.ino !== after.ino ||
		before.mtimeMs !== after.mtimeMs ||
		before.size !== after.size ||
		size !== before.size
	)
		throw new Error("Release binary changed during hashing");
	return {
		name: basename(path),
		platform: input.platformId,
		target: input.target,
		version: input.version,
		commit: input.commit,
		repository: input.repository,
		buildDate: input.buildDate,
		size,
		sha256: sha256.digest("hex"),
		sha512: sha512.digest("base64"),
	};
}

export function validateCiMetadata(
	metadata: BinaryMetadata | undefined,
	expected: {
		name: string;
		platformId: string;
		target: string;
		version: string;
		commit: string;
		repository: string;
	},
): asserts metadata is BinaryMetadata {
	if (
		!metadata ||
		metadata.name !== expected.name ||
		metadata.platform !== expected.platformId ||
		metadata.target !== expected.target ||
		metadata.version !== expected.version ||
		metadata.commit !== expected.commit ||
		!isValidGitHubRepository(expected.repository) ||
		metadata.repository !== expected.repository ||
		!/^[0-9a-f]{40}$/.test(metadata.commit) ||
		!Number.isSafeInteger(metadata.size) ||
		metadata.size <= 0 ||
		metadata.size > 1024 * 1024 * 1024 ||
		!/^[0-9a-f]{64}$/.test(metadata.sha256) ||
		!/^[A-Za-z0-9+/]{86}==$/.test(metadata.sha512) ||
		!Number.isFinite(Date.parse(metadata.buildDate))
	) {
		throw new Error(`Invalid or missing Release CI metadata: ${expected.name}`);
	}
}

export async function verifyCiSidecar(
	path: string,
	expected: {
		name: string;
		platformId: string;
		target: string;
		version: string;
		commit: string;
		repository: string;
	},
): Promise<BinaryMetadata> {
	const sidecar = `${path}.metadata.json`;
	const stat = lstatSync(sidecar);
	if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Invalid release sidecar");
	const metadata: BinaryMetadata = JSON.parse(readFileSync(sidecar, "utf8"));
	validateCiMetadata(metadata, expected);
	const actual = await computeCiBinaryMetadata(path, {
		...expected,
		buildDate: metadata.buildDate,
	});
	if (
		actual.size !== metadata.size ||
		actual.sha256 !== metadata.sha256 ||
		actual.sha512 !== metadata.sha512
	) {
		throw new Error(`Release sidecar hash/size mismatch: ${expected.name}`);
	}
	return metadata;
}
