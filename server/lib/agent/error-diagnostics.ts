/**
 * Re-export shim for bounded API error diagnostics.
 *
 * The implementation moved to `@shared/agent-protocol/error-diagnostics` so the
 * shared protocol layer — which bundled plugin code reuses — has no
 * `server/` imports. Host importers keep using this path unchanged.
 */
export {
	diagnosticsFromError,
	ERROR_DIAGNOSTICS_SCHEMA,
	MAX_DIAGNOSTIC_HEADERS,
	MAX_DIAGNOSTIC_JSON_CHARS,
	MAX_DIAGNOSTIC_TEXT_CHARS,
	normalizeApiRequestDiagnostics,
	normalizeDiagnosticHeaders,
	parseErrorDiagnostics,
	parseUpstreamErrorEnvelope,
	type UpstreamErrorEnvelope,
} from "@shared/agent-protocol/error-diagnostics";
