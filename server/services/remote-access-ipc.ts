import {
	encodeRemoteIpcEnvelope,
	parseRemoteIpcLine,
	REMOTE_IPC_COMMAND_TIMEOUT_MS,
	REMOTE_IPC_MAX_LINE_BYTES,
	REMOTE_IPC_MAX_PENDING,
	type RemoteIpcEnvelope,
	type RemoteIpcType,
	type RemotePeerInitConfig,
} from "../../shared/remote-access/ipc";
import { remoteSecret } from "./remote-access-registry";

/** Owns only the optional child; malformed output/EOF invalidates the whole epoch. */
export class RemotePeerProcess {
	private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	private readonly pending = new Map<
		string,
		{
			operation: string;
			resolve: (value: Record<string, unknown>) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private ended = false;
	private stopping?: Promise<void>;
	private readySeen = false;
	private readonly initRequestId = remoteSecret();
	private outputWindowStart = Date.now();
	private outputWindowBytes = 0;
	private readyResolve!: () => void;
	private readyReject!: (error: Error) => void;
	readonly ready = new Promise<void>((resolve, reject) => {
		this.readyResolve = resolve;
		this.readyReject = reject;
	});
	private readonly readyTimer: ReturnType<typeof setTimeout>;
	readonly diagnostics: string[] = [];
	constructor(
		path: string,
		readonly epoch: string,
		config: RemotePeerInitConfig,
		private readonly onEvent: (message: RemoteIpcEnvelope) => void,
		private readonly onFailure: (code: string) => void,
	) {
		this.child = Bun.spawn([path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.readyTimer = setTimeout(
			() => this.fail("REMOTE_PEER_START_TIMEOUT"),
			REMOTE_IPC_COMMAND_TIMEOUT_MS,
		);
		void this.ready.catch(() => {}); // The caller may attach its await after an immediate pipe failure.
		void this.readStdout();
		void this.readStderr();
		void this.child.exited.then(() => this.fail("REMOTE_PEER_EXITED"));
		this.send("init", { config }, this.initRequestId);
	}
	send(type: RemoteIpcType, payload: Record<string, unknown>, requestId = remoteSecret()) {
		if (this.ended) throw new Error("REMOTE_PEER_CLOSED");
		if (type !== "init" && !this.pending.has(requestId)) {
			if (this.pending.size >= REMOTE_IPC_MAX_PENDING) throw new Error("REMOTE_PEER_BUSY");
			const timer = setTimeout(
				() => this.fail("REMOTE_PEER_COMMAND_TIMEOUT"),
				REMOTE_IPC_COMMAND_TIMEOUT_MS,
			);
			this.pending.set(requestId, { operation: type, resolve: () => {}, reject: () => {}, timer });
		}
		const line = encodeRemoteIpcEnvelope({
			ipcVersion: 2,
			epoch: this.epoch,
			requestId,
			type,
			payload,
		});
		this.child.stdin.write(line);
		void Promise.resolve(this.child.stdin.flush()).catch(() =>
			this.fail("REMOTE_PEER_PIPE_FAILED"),
		);
	}
	command(type: RemoteIpcType, payload: Record<string, unknown> = {}) {
		if (this.ended || this.pending.size >= REMOTE_IPC_MAX_PENDING)
			return Promise.reject(new Error("REMOTE_PEER_BUSY"));
		const requestId = remoteSecret();
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error("REMOTE_PEER_COMMAND_TIMEOUT"));
				this.fail("REMOTE_PEER_COMMAND_TIMEOUT");
			}, REMOTE_IPC_COMMAND_TIMEOUT_MS);
			this.pending.set(requestId, { operation: type, resolve, reject, timer });
			try {
				this.send(type, payload, requestId);
			} catch {
				this.fail("REMOTE_PEER_PIPE_FAILED");
			}
		});
	}
	private async readStdout() {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let buffer = "";
		try {
			for await (const chunk of this.child.stdout) {
				if (this.ended) return;
				// Bound before decoding; one reader chunk is never accumulated without limit.
				if (Date.now() - this.outputWindowStart > 1000) {
					this.outputWindowStart = Date.now();
					this.outputWindowBytes = 0;
				}
				this.outputWindowBytes += chunk.byteLength;
				if (
					chunk.byteLength > REMOTE_IPC_MAX_LINE_BYTES * 2 ||
					this.outputWindowBytes > 1024 * 1024
				)
					throw new Error();
				buffer += decoder.decode(chunk, { stream: true });
				let end = buffer.indexOf("\n");
				while (end >= 0) {
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					const event = parseRemoteIpcLine(line);
					if (event.epoch !== this.epoch) throw new Error();
					if (event.type === "ready") {
						if (this.readySeen || event.requestId !== this.initRequestId) throw new Error();
						this.readySeen = true;
						clearTimeout(this.readyTimer);
						this.onEvent(event);
						this.readyResolve();
					} else if (event.type === "command.result" || event.type === "command.error") {
						const pending = this.pending.get(event.requestId);
						if (!pending || pending.operation !== event.payload.operation) throw new Error();
						if (
							event.type === "command.result" &&
							(!event.payload.result ||
								typeof event.payload.result !== "object" ||
								Array.isArray(event.payload.result))
						)
							throw new Error();
						this.pending.delete(event.requestId);
						clearTimeout(pending.timer);
						if (event.type === "command.error")
							pending.reject(new Error("REMOTE_PEER_COMMAND_FAILED"));
						else if (
							!event.payload.result ||
							typeof event.payload.result !== "object" ||
							Array.isArray(event.payload.result)
						)
							throw new Error();
						else pending.resolve(event.payload.result as Record<string, unknown>);
					} else this.onEvent(event);
					end = buffer.indexOf("\n");
				}
				if (Buffer.byteLength(buffer) > REMOTE_IPC_MAX_LINE_BYTES) throw new Error();
			}
			this.fail("REMOTE_PEER_EOF");
		} catch {
			this.fail("REMOTE_PEER_BAD_IPC");
		}
	}
	private async readStderr() {
		try {
			for await (const chunk of this.child.stderr) {
				if (this.ended) return;
				if (Date.now() - this.outputWindowStart > 1000) {
					this.outputWindowStart = Date.now();
					this.outputWindowBytes = 0;
				}
				this.outputWindowBytes += chunk.byteLength;
				if (this.outputWindowBytes > 1024 * 1024) {
					this.fail("REMOTE_PEER_OUTPUT_LIMIT");
					return;
				}
				// Never copy arbitrary child diagnostics (tokens, invites, paths) into logs/status.
				this.diagnostics.push(`peer stderr: ${chunk.byteLength} bytes suppressed`);
				if (this.diagnostics.length > 32) this.diagnostics.shift();
			}
		} catch {
			/* stdout/exit owns epoch invalidation */
		}
	}
	private invalidate(code: string) {
		this.ended = true;
		clearTimeout(this.readyTimer);
		this.readyReject(new Error(code));
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(code));
		}
		this.pending.clear();
	}
	private fail(code: string) {
		if (this.ended) return;
		this.invalidate(code);
		this.child.kill();
		this.onFailure(code);
	}
	private async waitExit(milliseconds: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.child.exited.then(() => true),
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), milliseconds);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	/** Serial reconciliation must await this before opening the same state lock again. */
	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.stopping = (async () => {
			if (!this.ended) {
				try {
					this.send("shutdown", {});
				} catch {
					/* continue with owned-child cleanup */
				}
				this.invalidate("REMOTE_PEER_STOPPED");
			}
			this.child.stdin.end();
			if (await this.waitExit(2000)) return;
			this.child.kill("SIGKILL");
			if (!(await this.waitExit(2000))) throw new Error("REMOTE_PEER_EXIT_TIMEOUT");
		})();
		return this.stopping;
	}
}
