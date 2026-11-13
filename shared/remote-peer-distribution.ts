import { COMPONENT_VERSIONS } from "./helper-distribution";
import type { RemotePeerDistribution } from "./remote-peer";
import { parseRemotePeerDistribution } from "./remote-peer-manifest";

export { parseRemotePeerDistribution } from "./remote-peer-manifest";
/** No APP_VERSION fallback: an undeclared helper must never be selected implicitly. */
export function createRemotePeerDistribution(
	pin: { version: string; protocolVersion: number } | undefined,
): Readonly<RemotePeerDistribution> | undefined {
	if (!pin) return undefined;
	return Object.freeze(parseRemotePeerDistribution({ ...pin, tag: `remote-peer-v${pin.version}` }));
}
export const REMOTE_PEER_DISTRIBUTION = createRemotePeerDistribution(COMPONENT_VERSIONS.remotePeer);
