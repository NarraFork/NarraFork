import { z } from "zod";
import type { RemoteAccessSettings } from "../../shared/remote-access/management";

export const DEFAULT_REMOTE_ACCESS: RemoteAccessSettings = {
	enabled: false,
	signalUrl: "",
	stunUrls: [],
	iceIPAllowlist: [],
	iceInterfaceAllowlist: [],
	iceNetworkTypes: ["udp4", "udp6"],
	allowLocalhost: false,
	leaseSeconds: 300,
};
export const remoteAccessSettingsSchema = z
	.object({
		enabled: z.boolean(),
		signalUrl: z.string().max(2048),
		stunUrls: z
			.array(
				z
					.string()
					.max(512)
					.regex(/^stuns?:[^\s]+$/),
			)
			.max(8),
		iceIPAllowlist: z.array(z.string().min(1).max(128)).max(32),
		iceInterfaceAllowlist: z.array(z.string().min(1).max(128)).max(32),
		iceNetworkTypes: z
			.array(z.enum(["udp4", "udp6"]))
			.min(1)
			.max(2),
		allowLocalhost: z.boolean(),
		leaseSeconds: z.number().int().min(60).max(3600),
	})
	.strict()
	.superRefine((value, context) => {
		if (!value.signalUrl && !value.enabled) return;
		try {
			const url = new URL(value.signalUrl);
			const local =
				value.allowLocalhost && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
			if (
				url.username ||
				url.password ||
				url.hash ||
				(url.protocol !== "wss:" && !(local && url.protocol === "ws:"))
			)
				throw new Error();
		} catch {
			context.addIssue({
				code: "custom",
				path: ["signalUrl"],
				message:
					"A wss coordinator URL is required (ws is only allowed for explicit localhost testing)",
			});
		}
	});
