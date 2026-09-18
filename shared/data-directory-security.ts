/**
 * Paths and OS ownership details are only returned to instance administrators.
 *
 * `unknown` is an inconclusive check, not a verdict: the probe itself did not finish
 * (slow or hung filesystem, timeout). It must never be presented as a permission
 * problem, because operators then go looking for a fault that does not exist.
 */
export interface DataDirectorySecurityStatus {
	status: "ok" | "restricted" | "unavailable" | "unknown";
	canRepair: boolean;
	details?: {
		code: string;
		path: string;
		message: string;
		mode?: string;
		ownerUid?: number;
		serviceUid?: number;
	};
}
