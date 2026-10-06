/**
 * Re-export shim for unified-gateway event parsing.
 *
 * The implementation moved to `@shared/agent-protocol/gateway-events` so the
 * shared protocol layer — which bundled plugin code reuses — has no
 * `server/` imports. Host importers keep using this path unchanged.
 */
export {
	isGatewayEventType,
	parseGatewayDataEvent,
	parseGatewaySSEEvent,
} from "@shared/agent-protocol/gateway-events";
