import { networkInterfaces } from "node:os";

/** Get RFC 1918 private IPv4 addresses from network interfaces. */
export function getLanAddresses(): string[] {
	const nets = networkInterfaces();
	const result: string[] = [];
	for (const ifaces of Object.values(nets)) {
		for (const iface of ifaces ?? []) {
			if (iface.internal || iface.family !== "IPv4") continue;
			const a = iface.address;
			// RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
			if (a.startsWith("10.") || a.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(a)) {
				result.push(a);
			}
		}
	}
	return result;
}
