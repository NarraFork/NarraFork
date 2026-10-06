export interface SandboxPolicy {
	readonly kind: "podman";
	readonly uid: number;
	readonly memoryBytes: number;
	readonly maxPids: number;
	readonly cpuCores: number;
	readonly cpuSeconds: number;
}
export interface CleanupReport {
	readonly confirmed: boolean;
	readonly exitCode: number | null;
	readonly message?: string;
}
export interface SandboxSession {
	readonly policy: SandboxPolicy;
	/** Bounded, newline-delimited JSON text. The consumer validates each frame. */
	readonly frames: AsyncIterable<string>;
	readonly exited: Promise<number>;
	/** Inspect actual isolation after ready, before any user source is sent. */
	verifyIsolation(): Promise<void>;
	send(json: string): Promise<void>;
	/** Idempotent and bounded; may terminate only this session's owned resources. */
	terminate(): Promise<CleanupReport>;
	stderr(): string;
}
export interface SandboxLaunch {
	readonly runId: string;
	/** Trusted application-generated broker/worker bootstrap; never raw user source. */
	readonly bootstrap: string;
	readonly wallMs: number;
	readonly signal: AbortSignal;
}
export interface IsolationDriver {
	readonly policy: SandboxPolicy;
	/** Fail closed if the platform, immutable local image or resource controls are absent. */
	checkAvailable(signal?: AbortSignal): Promise<void>;
	launch(options: SandboxLaunch): Promise<SandboxSession>;
}
