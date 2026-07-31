/**
 * Re-export shim for the stream stale-read utilities.
 *
 * protocol layer — which bundled plugin code reuses — has no `server/` imports.
 * Existing host importers keep using this path unchanged.
 */
export {
	readWithTimeout,
	StreamByteBudget,
	StreamSizeLimitError,
	StreamStaleError,
} from "@shared/stream-timeout";
