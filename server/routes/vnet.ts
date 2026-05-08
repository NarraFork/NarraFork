import { Hono } from "hono";
import { vnetRelayHub } from "../lib/vnet/relay";
import { getVNetUdpRendezvousStatus } from "../lib/vnet/udp-rendezvous";

export const vnetRoutes = new Hono();

vnetRoutes.get("/status", (c) => {
	return c.json({
		relay: vnetRelayHub.getStats(),
		udp: getVNetUdpRendezvousStatus(),
	});
});
