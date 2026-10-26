import { Buffer } from "node:buffer";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { UiNode } from "@shared/gen-ui-markup";
import type { ConnectionTransport, LaunchOptions } from "puppeteer-core";
import { findChromePath } from "../../lib/browser/pool";

export interface GenUiCaptureInput {
	html: string;
	/** Parsed markup nodes, delivered using the existing ui-tree protocol. */
	tree?: UiNode[];
	viewport: { width: number; height: number };
	signal: AbortSignal;
}

export interface GenUiCaptureResult {
	images: Array<{ format: "png"; base64: string }>;
	diagnostics: string[];
	failed: boolean;
	/** Rendering completed with resources restricted by the offline sandbox. */
	limited?: boolean;
}

export const CAPTURE_LIMITS = {
	concurrency: 2,
	totalMs: 30_000,
	screenshotMs: 5_000,
	pixels: 2_000_000,
	imageBytes: 2 * 1024 * 1024,
	htmlBytes: 16 * 1024 * 1024,
	treeBytes: 1024 * 1024,
	diagnostics: 20,
	diagnosticBytes: 2048,
	totalDiagnosticBytes: 16 * 1024,
	cdpMessageBytes: 4 * 1024 * 1024,
	cdpTotalBytes: 16 * 1024 * 1024,
	cdpBytesPerSecond: 8 * 1024 * 1024,
	cdpMessagesPerSecond: 1000,
} as const;

/** Private Chrome, never the shared pool or a user's browser profile. */
export function captureLaunchOptions(executablePath: string, signal: AbortSignal): LaunchOptions {
	return {
		executablePath,
		headless: true,
		pipe: true,
		signal,
		timeout: 10_000,
		protocolTimeout: CAPTURE_LIMITS.screenshotMs,
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false,
		// Puppeteer owns a fresh temporary profile. Never disable either Chrome sandbox.
		args: [
			"--disable-extensions",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-dev-shm-usage",
			"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
			"--disable-quic",
			// Defense in depth for requests outside a page's interception (e.g. WebSockets).
			"--proxy-server=http://127.0.0.1:9",
			"--proxy-bypass-list=<-loopback>",
			"--host-resolver-rules=MAP * ~NOTFOUND",
		],
	};
}

/** Validate the actual final argv, including Puppeteer's environment-derived defaults. */
export function assertCaptureSandboxArgs(args: readonly string[]): void {
	for (const argument of args) {
		const name = argument.split("=", 1)[0]?.toLowerCase() ?? "";
		if (
			(/^--(?:no|disable)-/.test(name) && name.includes("sandbox")) ||
			["--allow-sandbox-debugging", "--single-process", "--in-process-gpu", "--no-zygote"].includes(
				name,
			)
		) {
			throw new Error(
				`Sandbox-enabled capture refused unsafe Chrome argument ${name}; no insecure fallback.`,
			);
		}
	}
}

/** Bound NUL-delimited CDP frames while receiving chunks, before concatenation,
 * UTF-8 decoding or Puppeteer's JSON.parse. No native ws maxPayload assumptions.
 */
export function createBoundedCaptureTransport(
	read: Readable,
	write: Writable,
	signal: AbortSignal,
	onViolation: (error: Error) => void,
	now: () => number = () => performance.now(),
): ConnectionTransport {
	let chunks: Buffer[] = [];
	let frameBytes = 0;
	let totalBytes = 0;
	let windowBytes = 0;
	let windowMessages = 0;
	let windowStart = now();
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		chunks = [];
		read.pause();
		read.destroy();
		write.destroy();
		signal.removeEventListener("abort", stop);
		transport.onclose?.();
	};
	const fail = (message: string) => {
		if (stopped) return;
		onViolation(new Error(message));
		stop();
	};
	const transport: ConnectionTransport = {
		send(message) {
			if (!stopped) write.write(`${message}\0`);
		},
		close: stop,
	};
	read.on("data", (data: Buffer) => {
		if (stopped) return;
		if (!Buffer.isBuffer(data)) {
			fail("Capture CDP transport received an invalid chunk.");
			return;
		}
		const current = now();
		if (current - windowStart >= 1000) {
			windowStart = current;
			windowBytes = 0;
			windowMessages = 0;
		}
		totalBytes += data.length;
		windowBytes += data.length;
		if (
			totalBytes > CAPTURE_LIMITS.cdpTotalBytes ||
			windowBytes > CAPTURE_LIMITS.cdpBytesPerSecond
		) {
			fail("Capture CDP transport exceeded its total or per-second byte budget.");
			return;
		}
		let offset = 0;
		while (offset < data.length && !stopped) {
			const delimiter = data.indexOf(0, offset);
			const end = delimiter === -1 ? data.length : delimiter;
			const length = end - offset;
			if (frameBytes + length > CAPTURE_LIMITS.cdpMessageBytes) {
				fail("Capture CDP transport exceeded its 4MiB message limit.");
				return;
			}
			if (length) {
				chunks.push(data.subarray(offset, end));
				frameBytes += length;
			}
			if (delimiter === -1) break;
			if (++windowMessages > CAPTURE_LIMITS.cdpMessagesPerSecond) {
				fail("Capture CDP transport exceeded its event-rate budget.");
				return;
			}
			const message = Buffer.concat(chunks, frameBytes).toString("utf8");
			chunks = [];
			frameBytes = 0;
			transport.onmessage?.(message);
			offset = delimiter + 1;
		}
	});
	read.on("error", () => fail("Capture CDP read pipe failed."));
	write.on("error", () => fail("Capture CDP write pipe failed."));
	read.on("close", stop);
	signal.addEventListener("abort", stop, { once: true });
	if (signal.aborted) stop();
	return transport;
}

export function createCaptureDiagnostics() {
	const entries: string[] = [];
	let bytes = 0;
	return {
		entries,
		add(value: string) {
			if (entries.length >= CAPTURE_LIMITS.diagnostics) return;
			const available = Math.min(
				CAPTURE_LIMITS.diagnosticBytes,
				CAPTURE_LIMITS.totalDiagnosticBytes - bytes,
			);
			if (available <= 0) return;
			// Slice before encoding, so even a hostile long string has bounded work here.
			let text = Buffer.from(value.slice(0, available)).subarray(0, available).toString("utf8");
			while (Buffer.byteLength(text) > available) text = text.slice(0, -1);
			if (!text || entries.includes(text)) return;
			entries.push(text);
			bytes += Buffer.byteLength(text);
		},
	};
}

export function validateCaptureInput(input: GenUiCaptureInput): void {
	const { width, height } = input.viewport;
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 1 ||
		height < 1 ||
		width > 4096 ||
		height > 4096 ||
		width * height > CAPTURE_LIMITS.pixels
	) {
		throw new Error("Capture viewport must be positive integers, at most 4096 per side and 2MP.");
	}
	if (Buffer.byteLength(input.html) > CAPTURE_LIMITS.htmlBytes) {
		throw new Error("Capture HTML exceeds the 16MiB limit.");
	}
	if (input.tree !== undefined) {
		// parseUiMarkup already bounds source length and nesting; only the wire budget remains.
		if (Buffer.byteLength(JSON.stringify(input.tree)) > CAPTURE_LIMITS.treeBytes) {
			throw new Error("Capture markup tree exceeds the 1MiB limit.");
		}
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("GenUI capture cancelled.");
}

async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void work.catch(() => {});
		throw abortError(signal);
	}
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				onAbort = () => reject(abortError(signal));
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/** Kill only the process/group we spawned; cleanup never waits on renderer JS. */
async function disposeBrowser(
	child: ChildProcess | undefined,
	profile: string | undefined,
): Promise<void> {
	if (child?.pid && child.exitCode === null) {
		if (process.platform === "win32") {
			await new Promise<void>((resolve) => {
				execFile(
					"taskkill",
					["/pid", String(child.pid), "/T", "/F"],
					{ timeout: 500, maxBuffer: 1024, windowsHide: true },
					() => {
						try {
							child.kill("SIGKILL");
						} catch {
							/* Already exited. */
						}
						resolve();
					},
				);
			});
		} else {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* Already exited. */
			}
		}
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve();
				return;
			}
			const timeout = setTimeout(resolve, 500);
			child.once("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
	}
	if (profile) {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				rm(profile, { recursive: true, force: true }).catch(() => {}),
				new Promise<void>((resolve) => {
					timeout = setTimeout(resolve, 500);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
}

let activeCaptures = 0;

/** No installations, sandbox fallbacks, host actions, or shared-browser side effects. */
export async function captureGenUiSnapshot(input: GenUiCaptureInput): Promise<GenUiCaptureResult> {
	const diagnostics = createCaptureDiagnostics();
	const images: GenUiCaptureResult["images"] = [];
	let failed = false;
	let limited = false;
	if (activeCaptures >= CAPTURE_LIMITS.concurrency) {
		return {
			images,
			diagnostics: ["GenUI capture is busy (maximum two concurrent captures)."],
			failed: true,
		};
	}
	activeCaptures++;
	const deadline = new AbortController();
	// Reserve the final two seconds of the total budget for process/profile cleanup.
	const timer = setTimeout(
		() => deadline.abort(new Error("GenUI capture exceeded 30 seconds.")),
		28_000,
	);
	const signal = AbortSignal.any([input.signal, deadline.signal]);
	let child: ChildProcess | undefined;
	let profile: string | undefined;
	let transport: ConnectionTransport | undefined;
	let disposing = false;
	try {
		validateCaptureInput(input);
		if (signal.aborted) throw abortError(signal);
		const executablePath = findChromePath();
		if (!executablePath)
			throw new Error(
				"Chrome is unavailable. Install sandbox-capable Chrome separately; capture never installs it.",
			);
		const puppeteer = await import("puppeteer-core");
		profile = await mkdtemp(join(tmpdir(), "narrafork-gen-ui-"));
		if (signal.aborted) throw abortError(signal);
		const args = puppeteer.default.defaultArgs({
			...captureLaunchOptions(executablePath, signal),
			userDataDir: profile,
		});
		args.push("--remote-debugging-pipe");
		assertCaptureSandboxArgs(args);
		// We own these pipe handles from spawn onward. No unbounded Puppeteer
		// PipeTransport/WebSocket connection exists, even during trusted startup.
		child = spawn(executablePath, args, {
			stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		let stderr = Buffer.alloc(0);
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 2048)
				stderr = Buffer.concat([stderr, chunk.subarray(0, 2048 - stderr.length)]);
		});
		const startupFailure = () => {
			if (!disposing && !signal.aborted)
				deadline.abort(
					new Error(
						`Sandbox-enabled Chrome exited or failed to launch; no insecure fallback. ${stderr.toString("utf8")}`,
					),
				);
		};
		child.once("error", startupFailure);
		child.once("exit", startupFailure);
		const read = child.stdio[4] as Readable | null;
		const write = child.stdio[3] as Writable | null;
		if (!read || !write) throw new Error("Chrome debugging pipes are unavailable.");
		transport = createBoundedCaptureTransport(read, write, signal, (error) => {
			diagnostics.add(error.message);
			deadline.abort(error);
		});
		const ownedBrowser = await withAbort(
			puppeteer.default.connect({
				transport,
				protocolTimeout: CAPTURE_LIMITS.screenshotMs,
				defaultViewport: null,
			}),
			signal,
		);
		await withAbort(
			(async () => {
				const browserCdp = await ownedBrowser.target().createCDPSession();
				await browserCdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
				// Freeze worker targets before their first instruction; never resume them.
				browserCdp.on("Target.attachedToTarget", (event) => {
					if (!["worker", "shared_worker", "service_worker"].includes(event.targetInfo.type))
						return;
					limited = true;
					diagnostics.add(`Blocked ${event.targetInfo.type} target.`);
					void browserCdp
						.send("Target.closeTarget", { targetId: event.targetInfo.targetId })
						.catch(() => {});
				});
				await browserCdp.send("Target.setAutoAttach", {
					autoAttach: true,
					waitForDebuggerOnStart: true,
					flatten: true,
					filter: [{ type: "worker" }, { type: "shared_worker" }, { type: "service_worker" }],
				});
				// Do not construct a Puppeteer Page: it enables Runtime console/error streams,
				// allowing hostile code to send unbounded diagnostic payloads into the server.
				const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
				const { sessionId } = await browserCdp.send("Target.attachToTarget", {
					targetId,
					flatten: true,
				});
				const cdp = browserCdp.connection()?.session(sessionId);
				if (!cdp) throw new Error("Could not attach the isolated capture target.");
				await cdp.send("Emulation.setDeviceMetricsOverride", {
					...input.viewport,
					deviceScaleFactor: 1,
					mobile: false,
				});
				await cdp.send("Network.setBypassServiceWorker", { bypass: true });
				await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
				cdp.on("Fetch.requestPaused", (request) => {
					if (
						["Image", "Font"].includes(request.resourceType) &&
						(request.request.url.startsWith("data:") || request.request.url.startsWith("blob:"))
					) {
						void cdp
							.send("Fetch.continueRequest", { requestId: request.requestId })
							.catch(() => {});
						return;
					}
					limited = true;
					diagnostics.add(`Blocked resource request: ${request.request.url.slice(0, 1000)}`);
					void cdp
						.send("Fetch.failRequest", {
							requestId: request.requestId,
							errorReason: "BlockedByClient",
						})
						.catch(() => {});
				});
				await cdp.send("Target.setAutoAttach", {
					autoAttach: true,
					waitForDebuggerOnStart: true,
					flatten: true,
					filter: [{ type: "worker" }, { type: "shared_worker" }, { type: "service_worker" }],
				});
				cdp.on("Target.attachedToTarget", (event) => {
					limited = true;
					diagnostics.add(`Blocked ${event.targetInfo.type} target.`);
					void browserCdp
						.send("Target.closeTarget", { targetId: event.targetInfo.targetId })
						.catch(() => {});
				});
				await cdp.send("Page.enable");
				cdp.on("Page.javascriptDialogOpening", () => {
					void cdp.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
				});
				let initialFrameNavigation = true;
				cdp.on("Page.frameRequestedNavigation", (event) => {
					if (initialFrameNavigation && event.url === "about:srcdoc") {
						initialFrameNavigation = false;
						return;
					}
					limited = true;
					diagnostics.add(`Blocked navigation: ${event.url.slice(0, 1000)}`);
					void cdp.send("Page.stopLoading").catch(() => {});
				});
				// The host contains no application code and never honors ui-action messages.
				const { frameTree } = await cdp.send("Page.getFrameTree");
				await cdp.send("Page.setDocumentContent", {
					frameId: frameTree.frame.id,
					html: "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; frame-src about:; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head><body></body></html>",
				});
				const installHost = ({ html, tree }: { html: string; tree?: UiNode[] }) => {
					const frame = document.createElement("iframe");
					frame.sandbox.add("allow-scripts");
					frame.setAttribute(
						"allow",
						"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'",
					);
					const state = {
						painted: false,
						failed: false,
						limited: false,
						diagnostics: [] as string[],
						bytes: 0,
					};
					Object.defineProperty(window, "__nfCapture", { value: state });
					const encoder = new TextEncoder();
					window.addEventListener("message", (event) => {
						if (event.source !== frame.contentWindow) return;
						const data = event.data;
						if (data?.type === "narrafork:ui-ready" && tree !== undefined) {
							frame.contentWindow?.postMessage({ type: "narrafork:ui-tree", nodes: tree }, "*");
						} else if (data?.type === "narrafork:preview-painted") {
							state.painted = true;
						} else if (data?.type === "narrafork:preview-diagnostic") {
							if (data.severity === "warning") state.limited = true;
							else state.failed = true;
							if (
								typeof data.message !== "string" ||
								state.diagnostics.length >= 20 ||
								state.bytes >= 16384
							)
								return;
							let text = data.message.slice(0, 2048);
							const budget = Math.min(2048, 16384 - state.bytes);
							while (encoder.encode(text).length > budget) text = text.slice(0, -1);
							state.bytes += encoder.encode(text).length;
							state.diagnostics.push(text);
						}
					});
					frame.srcdoc = html;
					document.body.append(frame);
				};
				await cdp.send("Runtime.evaluate", {
					expression: `(${installHost.toString()})(${JSON.stringify({ html: input.html, tree: input.tree })})`,
				});
				const paintDeadline = Date.now() + 10_000;
				let painted = false;
				while (!signal.aborted && Date.now() < paintDeadline) {
					const status = await cdp.send("Runtime.evaluate", {
						expression: "window.__nfCapture.painted || window.__nfCapture.failed",
						returnByValue: true,
					});
					if (status.result.value === true) {
						painted = true;
						break;
					}
					// Bounded polling of host state, not frame-supplied console or CDP bindings.
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				if (!painted) {
					failed = true;
					diagnostics.add("Preview did not report a completed paint within 10 seconds.");
				}
				// CDP captures the trusted host viewport, never pixels supplied by frame messages.
				const shot = await cdp.send(
					"Page.captureScreenshot",
					{
						format: "png",
						fromSurface: true,
						captureBeyondViewport: false,
						clip: { x: 0, y: 0, ...input.viewport, scale: 1 },
					},
					{ timeout: CAPTURE_LIMITS.screenshotMs },
				);
				// Check base64 size before allocating its binary representation.
				if (
					shot.data.length > Math.ceil(CAPTURE_LIMITS.imageBytes / 3) * 4 ||
					Buffer.from(shot.data, "base64").byteLength > CAPTURE_LIMITS.imageBytes
				) {
					throw new Error("Screenshot exceeded the 2MiB limit.");
				}
				images.push({ format: "png", base64: shot.data });
				const status = await cdp.send("Runtime.evaluate", {
					expression:
						"({painted:window.__nfCapture.painted,failed:window.__nfCapture.failed,limited:window.__nfCapture.limited,diagnostics:window.__nfCapture.diagnostics})",
					returnByValue: true,
				});
				const state = status.result.value as {
					painted: boolean;
					failed: boolean;
					limited: boolean;
					diagnostics: string[];
				};
				if (!state) throw new Error("Capture host became unavailable.");
				failed ||= state.failed || !state.painted;
				limited ||= state.limited;
				for (const diagnostic of state.diagnostics) diagnostics.add(diagnostic);
				if (state.failed && !state.diagnostics.length)
					diagnostics.add("Preview reported a runtime error.");
				if (!state.painted && !diagnostics.entries.length)
					diagnostics.add("Preview did not complete a paint.");
			})(),
			signal,
		);
	} catch (error) {
		failed = true;
		diagnostics.add(error instanceof Error ? error.message : "GenUI capture failed.");
	} finally {
		clearTimeout(timer);
		disposing = true;
		transport?.close();
		await disposeBrowser(child, profile);
		activeCaptures--;
	}
	return {
		images,
		diagnostics: diagnostics.entries,
		failed: failed || !images.length,
		...(limited ? { limited: true } : {}),
	};
}
