import { createHash } from "node:crypto";
import { posix } from "node:path";
import { REMOTE_PEER_PLATFORMS } from "../../shared/remote-peer";
import { updateServerChildEnvironment } from "../../shared/update-server-child-env";

/** Shared main/diagnostic native acceptance contract; included in committed recipe inputs. */
export const REMOTE_PEER_NATIVE_CONTRACT = REMOTE_PEER_PLATFORMS.map((platform) => ({
	platform,
	runner: {
		"linux-amd64": "ubuntu-24.04",
		"linux-arm64": "ubuntu-24.04-arm",
		"darwin-amd64": "macos-26-intel",
		"darwin-arm64": "macos-26",
		"windows-amd64": "windows-2025",
		"windows-arm64": "windows-11-arm",
	}[platform],
}));

import { runPublicationProcess } from "./ci-publication-runtime";

export interface RemotePeerSource {
	list(commit: string, directory: string): Promise<string[]>;
	read(commit: string, path: string): Promise<string>;
	readBytes?(commit: string, path: string): Promise<Uint8Array>;
}

async function committedPeerBytes(
	root: string,
	commit: string,
	path: string,
	parent?: AbortSignal,
): Promise<Uint8Array> {
	const signal = AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(30_000)]);
	signal.throwIfAborted();
	const proc = Bun.spawn(["git", "-C", root, "show", `${commit}:${path}`], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: updateServerChildEnvironment(),
	});
	const cancel = () => proc.kill();
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	const consume = async (stream: ReadableStream<Uint8Array>, limit: number) => {
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of stream) {
			size += chunk.length;
			if (size > limit) {
				proc.kill();
				throw new Error("Committed peer source exceeds byte limit");
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks, size);
	};
	const output = consume(proc.stdout, 2 * 1024 * 1024);
	const diagnostic = consume(proc.stderr, 8192);
	try {
		const [bytes, , exit] = await Promise.all([output, diagnostic, proc.exited]);
		signal.throwIfAborted();
		if (exit !== 0) throw new Error(`Cannot read exact committed peer input: ${path}`);
		return bytes;
	} finally {
		signal.removeEventListener("abort", cancel);
		if (proc.exitCode === null) proc.kill();
		await Promise.allSettled([output, diagnostic, proc.exited]);
	}
}

/** Reads committed objects only: uncommitted files and the current checkout never affect a plan. */
export function createGitRemotePeerSource(root: string, signal?: AbortSignal): RemotePeerSource {
	const git = (args: string[]) =>
		runPublicationProcess("git", ["-C", root, ...args], {
			signal,
			environment: updateServerChildEnvironment(),
			timeoutMs: 30_000,
			maximumOutputBytes: 1024 * 1024,
		});
	const exact = (commit: string, path: string) => {
		if (
			!/^[a-f0-9]{40}$/.test(commit) ||
			!/^[A-Za-z0-9_./*-]+$/.test(path) ||
			path.split("/").includes("..")
		)
			throw new Error("Invalid committed peer source address");
	};
	return {
		async list(commit, directory) {
			exact(commit, directory);
			const raw = await git(["ls-tree", "-rz", "--full-tree", commit, "--", directory]);
			return raw
				.split("\0")
				.filter(Boolean)
				.map((entry) => {
					const match = /^100(?:644|755) blob [a-f0-9]{40}\t([^\0]+)$/.exec(entry);
					if (!match?.[1]) throw new Error("Peer source must contain regular files only");
					return match[1];
				});
		},
		async read(commit, path) {
			exact(commit, path);
			return new TextDecoder("utf-8", { fatal: true }).decode(
				await committedPeerBytes(root, commit, path, signal),
			);
		},
		async readBytes(commit, path) {
			exact(commit, path);
			return committedPeerBytes(root, commit, path, signal);
		},
	};
}

/** Separate from executor inputs; deliberately excludes NF version and component pin version. */
export const REMOTE_PEER_INPUT_RECIPE_PATHS = [
	"scripts/lib/remote-peer-build.ts",
	"scripts/lib/remote-peer-release-inputs.ts",
	"scripts/lib/ci-publication-runtime.ts",
	"shared/update-server-child-env.ts",
	"shared/remote-peer.ts",
] as const;

export async function fingerprintRemotePeerInputs(options: {
	commit: string;
	source: RemotePeerSource;
	protocolVersion: number;
	signal?: AbortSignal;
}): Promise<string> {
	if (
		!/^[a-f0-9]{40}$/.test(options.commit) ||
		!Number.isSafeInteger(options.protocolVersion) ||
		options.protocolVersion < 1
	)
		throw new Error("Invalid peer fingerprint identity");
	const { commit, source } = options;
	const files = await source.list(commit, "remote-peer");
	if (files.length > 4096 || new Set(files).size !== files.length)
		throw new Error("Peer source exceeds bounded file budget");
	const inputs = new Map<string, Uint8Array>();
	let bytes = 0;
	const raw = async (path: string) => {
		options.signal?.throwIfAborted();
		const cached = inputs.get(path);
		if (cached !== undefined) return cached;
		const data = source.readBytes
			? await source.readBytes(commit, path)
			: Buffer.from(await source.read(commit, path));
		bytes += data.byteLength;
		if (data.byteLength > 2 * 1024 * 1024 || bytes > 16 * 1024 * 1024)
			throw new Error("Peer production inputs exceed bounded byte budget");
		inputs.set(path, data);
		return data;
	};
	const read = async (path: string) =>
		new TextDecoder("utf-8", { fatal: true }).decode(await raw(path));
	const mod = await read("remote-peer/go.mod");
	await read("remote-peer/go.sum");
	const moduleName = /^module\s+([^\s]+)\s*$/m.exec(mod)?.[1];
	if (!moduleName || /^\s*(?:replace|use)\b/m.test(mod))
		throw new Error(
			"Peer module replacements/workspaces require an explicit fingerprint implementation",
		);
	const pending = ["remote-peer/cmd/remote-peer"];
	const visited = new Set<string>();
	while (pending.length) {
		const dir = pending.pop() as string;
		if (visited.has(dir)) continue;
		visited.add(dir);
		const go = files.filter(
			(path) => posix.dirname(path) === dir && path.endsWith(".go") && !path.endsWith("_test.go"),
		);
		if (!go.length) throw new Error(`Missing peer production package: ${dir}`);
		for (const path of files.filter(
			(file) => posix.dirname(file) === dir && /\.(?:s|S|h|syso)$/.test(file),
		))
			await raw(path);
		for (const path of go) {
			const text = await read(path);
			// Build tags are conservatively unioned across the six target platforms.
			for (const block of text.matchAll(
				/\bimport\s*(?:\(([\s\S]*?)\)|((?:[\w.]+\s+)?(?:"[^"\r\n]+"|`[^`]+`)))/g,
			)) {
				for (const quoted of (block[1] ?? block[2] ?? "").matchAll(/["`]([^"`]+)["`]/g)) {
					const name = quoted[1] as string;
					if (name === moduleName || name.startsWith(`${moduleName}/`)) {
						const suffix = name.slice(moduleName.length);
						if (suffix.split("/").includes("..")) throw new Error("Unsafe peer local import");
						pending.push(`remote-peer${suffix}`);
					}
				}
			}
			for (const directive of text.matchAll(/^\s*\/\/go:embed\s+(.+)$/gm)) {
				for (const token of (directive[1] as string).match(/"[^"]+"|`[^`]+`|\S+/g) ?? []) {
					const pattern = token.replace(/^["`]|["`]$/g, "").replace(/^all:/, "");
					if (
						pattern.startsWith("/") ||
						pattern.split("/").some((part) => part === ".." || part === ".")
					)
						throw new Error("Unsafe peer embed pattern");
					const glob = new Bun.Glob(`${dir}/${pattern}`);
					const embedded = files.filter((file) => {
						if (!file.startsWith(`${dir}/`)) return false;
						// A glob matching a directory embeds its descendants, not just direct files.
						const parts = file.split("/");
						return parts.some((_, index) => glob.match(parts.slice(0, index + 1).join("/")));
					});
					if (!embedded.length) throw new Error("Unresolved peer embed input");
					for (const file of embedded) await raw(file);
				}
			}
		}
	}
	const wire = await read("remote-peer/protocol.go");
	if (Number(/\bconst\s+ProtocolVersion\s*=\s*(\d+)/.exec(wire)?.[1]) !== options.protocolVersion)
		throw new Error("Remote-peer pin/wire protocol mismatch");
	for (const path of REMOTE_PEER_INPUT_RECIPE_PATHS) await read(path);
	await read("licenses/extra/remote-peer-LICENSES.txt");
	const hash = createHash("sha256");
	hash.update(`remote-peer-production-v1\0protocol=${options.protocolVersion}\0`);
	for (const [path, text] of [...inputs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
		hash.update(`${path}\0${Buffer.byteLength(text)}\0`).update(text);
	return hash.digest("hex");
}

/** Independent recipe proof: never change or broaden the executor recipe fingerprint. */
export const REMOTE_PEER_RECIPE_PATHS = [
	"scripts/lib/remote-peer-build.ts",
	"scripts/lib/remote-peer-release-inputs.ts",
	"scripts/lib/ci-publication-runtime.ts",
	"shared/update-server-child-env.ts",
	"shared/remote-peer.ts",
	".github/workflows/remote-peer-release.yml",
] as const;
export async function compareRemotePeerRecipeIdentity(options: {
	commit: string;
	controlCommit: string;
	readSource: (commit: string, path: string) => string | Promise<string>;
	signal?: AbortSignal;
	deadline?: number;
}): Promise<void> {
	if (![options.commit, options.controlCommit].every((commit) => /^[a-f0-9]{40}$/.test(commit)))
		throw new Error("Expected exact remote-peer recipe source commits");
	const deadline = options.deadline ?? Date.now() + 180_000;
	if (!Number.isFinite(deadline) || deadline <= Date.now())
		throw new Error("Remote-peer recipe deadline exceeded");
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		AbortSignal.timeout(Math.max(0, deadline - Date.now())),
	]);
	signal.throwIfAborted();
	if (options.commit === options.controlCommit) return;
	let total = 0;
	const fingerprint = async (commit: string) => {
		const hash = createHash("sha256");
		for (const path of REMOTE_PEER_RECIPE_PATHS) {
			signal.throwIfAborted();
			let cancel: (() => void) | undefined;
			try {
				const text = await Promise.race([
					Promise.resolve(options.readSource(commit, path)),
					new Promise<never>((_, reject) => {
						cancel = () => reject(signal.reason);
						signal.addEventListener("abort", cancel, { once: true });
						if (signal.aborted) cancel();
					}),
				]);
				signal.throwIfAborted();
				const size = Buffer.byteLength(text);
				total += size;
				if (size > 2 * 1024 * 1024 || total > 16 * 1024 * 1024 || text.includes("\0"))
					throw new Error("Remote-peer recipe input exceeds bounded text budget");
				hash.update(`${path}\0${size}\0`).update(text);
			} finally {
				if (cancel) signal.removeEventListener("abort", cancel);
			}
		}
		return hash.digest("hex");
	};
	if ((await fingerprint(options.commit)) !== (await fingerprint(options.controlCommit)))
		throw new Error(
			"Trusted control remote-peer recipe/toolchain differs from component tag source",
		);
}
