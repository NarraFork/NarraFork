import type { TransactionManifestRequest } from "./revert-transaction-manifest-worker";

/** Version 2 adds RPC correlation without changing the signed manifest/request contents. */
export const REVERT_MANIFEST_WORKER_VERSION = 2;

export interface TransactionManifestWorkerRequest {
	requestId: string;
	request: TransactionManifestRequest;
}
