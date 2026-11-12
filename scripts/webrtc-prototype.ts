import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { startCoordinator } from "../remote-coordinator/index";
import type { Invitation } from "../remote-prototype/client";
import { startFixture } from "../remote-prototype/fixture";

const ROOT = resolve(import.meta.dir, "..");
const MAX_OUTPUT = 1024 * 1024;

export async function buildPeer(output: string, signal?: AbortSignal): Promise<void> {
	const child = Bun.spawn(["go", "build", "-o", output, "./cmd/remote-peer"], {
		cwd: join(ROOT, "remote-peer"),
		stdout: "pipe",
		stderr: "pipe",
	});
	let bytes = 0;
	let diagnostic = "";
	const timer = setTimeout(() => child.kill(), 300_000);
	const abort = () => child.kill();
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	async function collect(stream: ReadableStream<Uint8Array>) {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > MAX_OUTPUT) {
					child.kill();
					throw new Error("BUILD_OUTPUT_LIMIT");
				}
				diagnostic = (diagnostic + decoder.decode(value, { stream: true })).slice(-65536);
			}
		} finally {
			reader.releaseLock();
		}
	}
	try {
		const [exit] = await Promise.all([child.exited, collect(child.stdout), collect(child.stderr)]);
		if (signal?.aborted) throw signal.reason ?? new Error("STARTUP_CANCELLED");
		if (exit !== 0) throw new Error(`PEER_BUILD_FAILED: ${diagnostic}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

/** Owns ONLY its isolated coordinator, fixture, peer and temporary directory. */
export async function startPrototype(
	options: {
		peerBinary?: string;
		leaseSeconds?: number;
		stunUrls?: string[];
		signal?: AbortSignal;
	} = {},
) {
	const checkStartup = () => {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("STARTUP_CANCELLED");
	};
	checkStartup();
	const directory = await mkdtemp(join(ROOT, ".webrtc-prototype-"));
	let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
	let coordinator: Awaited<ReturnType<typeof startCoordinator>> | undefined;
	let child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
	let stopped = false;
	let outputTask: Promise<void> | undefined;
	let errorTask: Promise<void> | undefined;
	let lastStatus = "starting";
	let stopPromise: Promise<void> | undefined;
	let abortStartup = () => {};
	const abort = () => {
		abortStartup();
		if (child) void stop().catch(() => child?.kill());
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	function stop(): Promise<void> {
		if (stopPromise) return stopPromise;
		stopPromise = (async () => {
			stopped = true;
			options.signal?.removeEventListener("abort", abort);
			if (child) {
				try {
					child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
					child.stdin.end();
				} catch {}
				const killTimer = setTimeout(() => child?.kill(), 3000);
				try {
					await child.exited;
				} finally {
					clearTimeout(killTimer);
				}
			}
			await Promise.allSettled(
				[outputTask, errorTask].filter((value): value is Promise<void> => !!value),
			);
			fixture?.stop();
			await coordinator?.stop();
			await rm(directory, { recursive: true, force: true });
		})();
		return stopPromise;
	}
	try {
		const binary =
			options.peerBinary ??
			join(directory, process.platform === "win32" ? "remote-peer.exe" : "remote-peer");
		if (!options.peerBinary) await buildPeer(binary, options.signal);
		checkStartup();
		const clientBuild = await Bun.build({
			entrypoints: [join(ROOT, "remote-prototype/entry.ts")],
			target: "browser",
			format: "esm",
		});
		if (!clientBuild.success || clientBuild.outputs.length !== 1)
			throw new Error("CLIENT_BUILD_FAILED");
		checkStartup();
		const javascript = await clientBuild.outputs[0].text();
		if (new TextEncoder().encode(javascript).byteLength > MAX_OUTPUT)
			throw new Error("CLIENT_BUILD_LIMIT");
		fixture = await startFixture({
			onSessionInvalidated(token) {
				if (!child || stopped) return;
				try {
					child.stdin.write(`${JSON.stringify({ type: "revoke-session", token })}\n`);
					void Promise.resolve(child.stdin.flush()).catch(() => child?.kill());
				} catch {
					child.kill();
				}
			},
		});
		checkStartup();
		coordinator = await startCoordinator({
			host: "127.0.0.1",
			allowLocalhost: true,
			leaseSeconds: options.leaseSeconds ?? 75,
			assetHandler(request) {
				const path = new URL(request.url).pathname;
				if (path === "/")
					return new Response(Bun.file(join(ROOT, "remote-prototype/index.html")), {
						headers: { "Content-Type": "text/html", "Referrer-Policy": "no-referrer" },
					});
				if (path === "/client.js")
					return new Response(javascript, { headers: { "Content-Type": "text/javascript" } });
			},
		});
		checkStartup();
		child = Bun.spawn([binary], {
			cwd: directory,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: directory, USERPROFILE: directory },
		});
		let resolveReady!: (value: Omit<Invitation, "signalUrl">) => void;
		let rejectReady!: (error: Error) => void;
		const ready = new Promise<Omit<Invitation, "signalUrl">>((yes, no) => {
			resolveReady = yes;
			rejectReady = no;
		});
		let resolveRegistration!: () => void;
		let rejectRegistration!: (error: Error) => void;
		const registered = new Promise<void>((yes, no) => {
			resolveRegistration = yes;
			rejectRegistration = no;
		});
		abortStartup = () => {
			const error =
				options.signal?.reason instanceof Error
					? options.signal.reason
					: new Error("STARTUP_CANCELLED");
			rejectReady(error);
			rejectRegistration(error);
		};
		void ready.catch(() => {});
		void registered.catch(() => {});
		const deadline = setTimeout(() => {
			rejectReady(new Error(`PEER_START_TIMEOUT:${lastStatus}`));
			rejectRegistration(new Error(`REGISTRATION_TIMEOUT:${lastStatus}`));
		}, 30_000);
		outputTask = (async () => {
			const reader = child?.stdout.getReader();
			if (!reader) throw new Error("PEER_STDOUT_MISSING");
			const decoder = new TextDecoder();
			let pending = "";
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					pending += decoder.decode(value, { stream: true });
					while (pending.includes("\n")) {
						const end = pending.indexOf("\n");
						const line = pending.slice(0, end);
						pending = pending.slice(end + 1);
						if (new TextEncoder().encode(line).byteLength > 8192)
							throw new Error("PEER_STATUS_LIMIT");
						const event = JSON.parse(line) as { type: string; code?: string } & Omit<
							Invitation,
							"signalUrl"
						>;
						if (event.type === "ready") resolveReady(event);
						else if (event.type === "status") {
							lastStatus = event.code ?? "unknown";
							if (lastStatus === "registered") resolveRegistration();
						} else if (event.type === "error") {
							lastStatus = event.code ?? "peer_error";
							rejectReady(new Error(lastStatus));
							rejectRegistration(new Error(lastStatus));
						}
					}
					if (new TextEncoder().encode(pending).byteLength > 8192)
						throw new Error("PEER_STATUS_LIMIT");
				}
				if (!stopped) {
					rejectReady(new Error("PEER_EXITED"));
					rejectRegistration(new Error("PEER_EXITED"));
				}
			} catch (error) {
				child?.kill();
				rejectReady(error instanceof Error ? error : new Error("PEER_PROTOCOL_ERROR"));
				rejectRegistration(error instanceof Error ? error : new Error("PEER_PROTOCOL_ERROR"));
			} finally {
				reader.releaseLock();
			}
		})();
		errorTask = (async () => {
			const reader = child?.stderr.getReader();
			if (!reader) return;
			let bytes = 0;
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
					if (bytes > MAX_OUTPUT) {
						child?.kill();
						throw new Error("PEER_LOG_LIMIT");
					}
				}
			} finally {
				reader.releaseLock();
			}
		})();
		void errorTask.catch(() => {});
		child.stdin.write(
			`${JSON.stringify({ mode: "prototype", signalUrl: coordinator.signalUrl, bridgeUrl: fixture.bridgeUrl, bridgeSecret: fixture.bridgeSecret, statePath: join(directory, "peer-state.json"), stunUrls: options.stunUrls ?? [], allowLocalhost: true, leaseSeconds: options.leaseSeconds ?? 75 })}\n`,
		);
		let invitation: Invitation;
		try {
			invitation = {
				...(await ready),
				signalUrl: coordinator.signalUrl.replace("/signal/instance", "/signal/browser"),
			};
			await registered;
		} finally {
			clearTimeout(deadline);
		}
		return {
			directory,
			origin: coordinator.origin,
			invitation,
			fixture,
			coordinator,
			status: () => lastStatus,
			revoke(grantId = "all") {
				child?.stdin.write(`${JSON.stringify({ type: "revoke", grantId })}\n`);
			},
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}

if (import.meta.main) {
	const controller = new AbortController();
	const stop = () => controller.abort(new Error("STARTUP_CANCELLED"));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	let prototype: Awaited<ReturnType<typeof startPrototype>> | undefined;
	try {
		prototype = await startPrototype({ signal: controller.signal });
		const invitationFile = join(prototype.directory, "invitation.json");
		await writeFile(invitationFile, `${JSON.stringify(prototype.invitation, null, 2)}\n`, {
			mode: 0o600,
		});
		console.log(`Isolated M1 prototype: ${prototype.origin}`);
		console.log(
			`Private invitation file: ${invitationFile} (paste its JSON into the local debug page)`,
		);
		console.log(
			"Fixture-only login: admin / prototype-admin. No production users or database are loaded.",
		);
		await new Promise<void>((resolve) => {
			if (controller.signal.aborted) resolve();
			else controller.signal.addEventListener("abort", () => resolve(), { once: true });
		});
	} catch (error) {
		if (!controller.signal.aborted) {
			console.error(error instanceof Error ? error.message : "PROTOTYPE_FAILED");
			process.exitCode = 1;
		}
	} finally {
		await prototype?.stop();
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}
