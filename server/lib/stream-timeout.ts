/**
 * Re-export shim for the stream stale-read utilities.
 *
 * The implementation moved to `@shared/stream-timeout` so the shared
 * protocol layer — which bundled plugin code reuses — has no `server/` imports.
 * Existing host importers keep using this path unchanged.
 */
export {
	readWithTimeout,
	StreamByteBudget,
	StreamSizeLimitError,
	StreamStaleError,
} from "@shared/stream-timeout";
