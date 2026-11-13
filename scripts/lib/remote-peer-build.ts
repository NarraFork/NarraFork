import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	isRemotePeerPlatform,
	type RemotePeerPlatform,
	remotePeerPublishedFilename,
} from "../../shared/remote-peer";
import { updateServerChildEnvironment } from "../../shared/update-server-child-env";
import { runPublicationProcess } from "./ci-publication-runtime";

export const REMOTE_PEER_GO_VERSION = "1.26.1";
export const REMOTE_PEER_BUILD_TIME = "1970-01-01T00:00:00Z";
export interface RemotePeerBuildIdentity {
	version: string;
	commit: string;
	protocolVersion: number;
}
function assertIdentity(identity: RemotePeerBuildIdentity): void {
	if (
		!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/.test(identity.version) ||
		!/^[a-f0-9]{40}$/.test(identity.commit) ||
		!Number.isSafeInteger(identity.protocolVersion) ||
		identity.protocolVersion < 1
	)
		throw new Error("Invalid remote-peer build identity");
}
export function remotePeerBuildRecipe(
	root: string,
	platform: RemotePeerPlatform,
	output: string,
	identity: RemotePeerBuildIdentity,
): { args: string[]; environment: NodeJS.ProcessEnv } {
	assertIdentity(identity);
	if (!isRemotePeerPlatform(platform)) throw new Error("Unsupported remote-peer build platform");
	const [goos, goarch] = platform.split("-");
	return {
		args: [
			"-C",
			resolve(root, "remote-peer"),
			"build",
			"-mod=readonly",
			"-trimpath",
			"-buildvcs=false",
			"-ldflags",
			`-s -w -X narrafork/remote-peer/internal/buildinfo.Version=${identity.version} -X narrafork/remote-peer/internal/buildinfo.Commit=${identity.commit} -X narrafork/remote-peer/internal/buildinfo.BuildTime=${REMOTE_PEER_BUILD_TIME}`,
			"-o",
			resolve(output, remotePeerPublishedFilename(identity.version, platform)),
			"./cmd/remote-peer",
		],
		environment: {
			...updateServerChildEnvironment(),
			CGO_ENABLED: "0",
			GOOS: goos,
			GOARCH: goarch,
			GOAMD64: "v1",
			GOARM64: "v8.0",
			GOFLAGS: "",
			GOEXPERIMENT: "",
			GOTOOLCHAIN: "local",
			GOWORK: "off",
		},
	};
}
export async function buildRemotePeerPlatform(
	root: string,
	platform: RemotePeerPlatform,
	output: string,
	identity: RemotePeerBuildIdentity,
	signal?: AbortSignal,
): Promise<void> {
	const recipe = remotePeerBuildRecipe(root, platform, output, identity);
	const version = await runPublicationProcess("go", ["version"], {
		signal,
		environment: recipe.environment,
		timeoutMs: 10_000,
		maximumOutputBytes: 8192,
	});
	if (!version.startsWith(`go version go${REMOTE_PEER_GO_VERSION} `))
		throw new Error("remote-peer requires the exact pinned Go toolchain");
	await mkdir(output, { recursive: true });
	await runPublicationProcess("go", recipe.args, {
		signal,
		environment: recipe.environment,
		timeoutMs: 5 * 60_000,
		maximumOutputBytes: 64 * 1024,
	});
	const file = await lstat(join(output, remotePeerPublishedFilename(identity.version, platform)));
	if (!file.isFile() || file.size < 1 || file.size > 32 * 1024 * 1024)
		throw new Error("Invalid remote-peer build output size/type");
}
export function assertRemotePeerVersion(raw: string, identity: RemotePeerBuildIdentity): void {
	assertIdentity(identity);
	const value = JSON.parse(raw);
	if (
		!value ||
		value.version !== identity.version ||
		value.commit !== identity.commit ||
		value.buildTime !== REMOTE_PEER_BUILD_TIME ||
		value.protocolVersion !== identity.protocolVersion ||
		value.goVersion !== `go${REMOTE_PEER_GO_VERSION}`
	)
		throw new Error("Remote-peer native version/protocol/toolchain mismatch");
}
/** Only local fixtures; no real NF, public coordinator, STUN or persistent user state. */
export async function smokeRemotePeerPlatform(
	platform: RemotePeerPlatform,
	output: string,
	identity: RemotePeerBuildIdentity,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
	if (host !== platform) throw new Error("Remote-peer smoke must be native");
	const binary = resolve(output, remotePeerPublishedFilename(identity.version, platform));
	await chmod(binary, 0o755);
	// Resolve the temp root first: on macOS it lives under /var, a symlink to /private/var,
	// and the production state store deliberately rejects any symlinked ancestor.
	const home = await mkdtemp(join(await realpath(tmpdir()), "nf-peer-smoke-"));
	const env = { ...updateServerChildEnvironment(), HOME: home, USERPROFILE: home, APPDATA: home };
	const execute = async (args: string[], input?: string, closeInput = false): Promise<string> => {
		const proc = Bun.spawn([binary, ...args], {
			cwd: home,
			env,
			// Version queries must terminate even when stdin stays open without a byte.
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const cancel = () => proc.kill();
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, 15_000);
		const consume = async (stream: ReadableStream<Uint8Array>) => {
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const chunk of stream) {
				size += chunk.length;
				if (size > 64 * 1024) {
					proc.kill();
					throw new Error("Remote-peer smoke output exceeds limit");
				}
				chunks.push(chunk);
			}
			return Buffer.concat(chunks, size).toString("utf8");
		};
		try {
			if (input !== undefined) {
				proc.stdin.write(input);
				await proc.stdin.flush();
			}
			if (closeInput) proc.stdin.end();
			const [stdout, stderr, exit] = await Promise.all([
				consume(proc.stdout),
				consume(proc.stderr),
				proc.exited,
			]);
			signal?.throwIfAborted();
			if (timedOut || exit !== 0 || stderr.trim())
				throw new Error("Remote-peer smoke did not exit cleanly");
			return stdout;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			if (proc.exitCode === null) proc.kill();
			proc.stdin.end();
			await proc.exited;
		}
	};
	let stopServer = () => {};
	try {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("Local release smoke only", { status: 503 }),
		});
		stopServer = () => {
			server.stop(true);
		};
		assertRemotePeerVersion(await execute(["--version", "--json"]), identity);
		if (!(await execute(["--version"])).includes(identity.version))
			throw new Error("Missing remote-peer human-readable version");
		if ((await readdir(home)).length !== 0)
			throw new Error("Remote-peer version query created state");
		const config = {
			mode: "prototype",
			signalUrl: `ws://127.0.0.1:${server.port}/signal/instance`,
			bridgeUrl: `http://127.0.0.1:${server.port}`,
			bridgeSecret: "release-smoke-local-only-secret-00000000",
			statePath: join(home, "state.json"),
			allowLocalhost: true,
			stunUrls: [],
		};
		const stdout = await execute(
			[],
			`${JSON.stringify(config)}\n${JSON.stringify({ type: "shutdown" })}\n`,
		);
		const events = stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		if (
			!events.some((event) => event.type === "ready") ||
			events.some((event) => event.type === "error")
		)
			throw new Error("Remote-peer control smoke did not become ready and shut down");
		// Legacy v1 diagnostics retain their isolated EOF case. New peers must reopen the
		// SAME state on every native runner, including Windows; never hide an ACL failure.
		const eofConfig =
			identity.protocolVersion >= 2
				? config
				: { ...config, statePath: join(home, "state-eof.json") };
		const eof = await execute([], `${JSON.stringify(eofConfig)}\n`, true);
		if (
			!eof
				.trim()
				.split("\n")
				.some((line) => JSON.parse(line).type === "ready")
		)
			throw new Error("Remote-peer EOF smoke did not become ready and terminate");
		if (identity.protocolVersion >= 2) {
			const first = events.find((event) => event.type === "ready");
			const reopened = eof
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.find((event) => event.type === "ready");
			if (!first?.instanceId || first.instanceId !== reopened?.instanceId)
				throw new Error("Remote-peer state identity changed after reopening");
			// Exercise the production private-directory/ACL path as well, not just the
			// prototype protocol. This is an isolated identity fixture, not an NF release.
			const epoch = "native_state_smoke";
			const init = {
				ipcVersion: 2,
				epoch,
				requestId: "initialize",
				type: "init",
				payload: {
					config: {
						...config,
						mode: "narrafork",
						statePath: join(home, "production", "state.json"),
						leaseSeconds: 300,
						backendIdentity: {
							nfVersion: "1.0.0",
							sourceCommit: identity.commit,
							repository: "smoke/fixture",
							bootstrapAbi: 1,
							apiEpoch: 1,
							wireVersion: 2,
							capabilities: [],
						},
						requestPolicy: [
							{
								id: "smoke-health",
								methods: ["GET"],
								path: "^/api/health$",
								phase: "ready",
								profile: "request",
								requestBytes: 1048576,
								responseBytes: 1048576,
							},
						],
					},
				},
			};
			const shutdown = { ipcVersion: 2, epoch, requestId: "stop", type: "shutdown", payload: {} };
			const input = `${JSON.stringify(init)}\n${JSON.stringify(shutdown)}\n`;
			let previous: string | undefined;
			for (let attempt = 0; attempt < 2; attempt++) {
				const output = await execute([], input);
				const messages = output
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				const ready = messages.find((message) => message.type === "ready");
				if (
					!ready ||
					ready.ipcVersion !== 2 ||
					ready.epoch !== epoch ||
					typeof ready.payload?.instanceId !== "string" ||
					messages.some(
						(message) => message.type === "command.error" || message.payload?.pairingSecret,
					)
				)
					throw new Error("Production remote-peer native state smoke failed");
				if (previous && previous !== ready.payload.instanceId)
					throw new Error("Production remote-peer identity changed after reopening");
				previous = ready.payload.instanceId;
			}
		}
	} finally {
		stopServer();
		await rm(home, { recursive: true, force: true });
	}
}
