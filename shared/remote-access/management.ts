/** Ordinary administrator entry only. Never sent as a remote business capability. */
export interface RemoteAccessSettings {
	enabled: boolean;
	signalUrl: string;
	stunUrls: string[];
	iceIPAllowlist: string[];
	iceInterfaceAllowlist: string[];
	iceNetworkTypes: ("udp4" | "udp6")[];
	allowLocalhost: boolean;
	leaseSeconds: number;
}

export interface RemoteAccessInvitation {
	instanceId: string;
	publicKey: string;
	pairId: string;
	pairingSecret: string;
	discoveryCapability: string;
	expiresAt: number;
	signalUrl: string;
}
export interface RemoteAccessGrant {
	id: string;
	publicKey: string;
	expiresAt: number;
	revoked: boolean;
}
export interface RemoteAccessStatus {
	enabled: boolean;
	state: "disabled" | "needs-install" | "starting" | "ready" | "backoff" | "failed";
	installed: boolean;
	componentVersion: string | null;
	instanceId: string | null;
	peers: number;
	lastError: string | null;
	config: RemoteAccessSettings;
}
