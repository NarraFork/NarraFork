/**
 * Re-export shim for unified-gateway event parsing.
 *
 * `server/` imports. Host importers keep using this path unchanged.
 */
export {
	isGatewayEventType,
	parseGatewayDataEvent,
	parseGatewaySSEEvent,
