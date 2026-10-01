export interface DiskSafetySettings {
	/** Administrator-controlled override; tool permissions never bypass this guard. */
	mode: "enforce" | "warn" | "off";
	warningFreeMb: number;
	warningFreePercent: number;
	blockFreeMb: number;
	criticalFreeMb: number;
	/** Headroom for WAL, tool outcomes and concurrent filesystem metadata. */
	reserveMb: number;
	checkIntervalMs: number;
	pathCacheTtlMs: number;
	probeTimeoutMs: number;
}

export const DEFAULT_DISK_SAFETY: DiskSafetySettings = {
	mode: "enforce",
	warningFreeMb: 1024,
	warningFreePercent: 5,
	blockFreeMb: 256,
	criticalFreeMb: 64,
	reserveMb: 32,
	checkIntervalMs: 10_000,
	pathCacheTtlMs: 60_000,
	probeTimeoutMs: 1000,
};
