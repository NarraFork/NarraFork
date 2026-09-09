/** Paths and OS ownership details are only returned to instance administrators. */
export interface DataDirectorySecurityStatus {
	status: "ok" | "restricted" | "unavailable";
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
