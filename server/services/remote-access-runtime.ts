import { join } from "node:path";
import {
	parseRemoteBackendIdentity,
	REMOTE_CAPABILITY_NAMES,
} from "../../shared/remote-access/application";
import { isRemoteIpcId, type RemotePeerOpen } from "../../shared/remote-access/ipc";
import type { RemoteAccessStatus } from "../../shared/remote-access/management";
import { REMOTE_REQUEST_POLICY } from "../../shared/remote-access/request-policy";
import type { createServerRequestDispatcher } from "../http-dispatcher";
import type { ServerRequestLifecycle } from "../http-request-lifecycle";
import { AppError } from "../lib/errors";
import { getNarraforkPath } from "../lib/narrafork-home";
import { DEFAULT_REMOTE_ACCESS, remoteAccessSettingsSchema } from "../lib/remote-access-config";
import { ensureRemotePeerBinary, getInstalledRemotePeerBinary } from "../lib/remote-peer-binaries";
import { settings, subscribeSettingsChanges } from "../lib/settings";
import type { StartupReadinessGate } from "../lib/startup-readiness";
import {
	APP_VERSION,
	BUILD_GITHUB_REPOSITORY,
	BUILD_REMOTE_PEER_DISTRIBUTION,
	GIT_COMMIT,
} from "../lib/version";
import { createRemoteAccessBridge } from "./remote-access-bridge";
import { RemotePeerProcess } from "./remote-access-ipc";
import { RemoteAccessRegistry, remoteSecret } from "./remote-access-registry";

interface RuntimeHost {
	dispatch: ReturnType<typeof createServerRequestDispatcher>;
	lifecycle: ServerRequestLifecycle;
	readiness: StartupReadinessGate;
}
export class RemoteAccessRuntime {
	private host?: RuntimeHost;
	private peer?: RemotePeerProcess;
	private bridge?: ReturnType<typeof createRemoteAccessBridge>;
	private registry?: RemoteAccessRegistry;
	private stopSubscription?: () => void;
	private queue = Promise.resolve();
	private ownedStop: Promise<void> = Promise.resolve();
	private retryTimer?: ReturnType<typeof setTimeout>;
	private attempts = 0;
	private configuration = "";
	private state: RemoteAccessStatus["state"] = "disabled";
	private lastError: string | null = null;
	private instanceId: string | null = null;
	private installed = false;
	private closing = false;
	private installing?: Promise<RemoteAccessStatus>;
	private config() {
		return remoteAccessSettingsSchema.parse(settings.remoteAccess ?? DEFAULT_REMOTE_ACCESS);
	}
	async status(): Promise<RemoteAccessStatus> {
		// Disk-only check. Never install, reconcile, start or ask the child for an invitation.
		this.installed = !!(await getInstalledRemotePeerBinary().catch(() => null));
		const config = this.config();
		return {
			enabled: config.enabled,
			state: !config.enabled ? "disabled" : !this.installed ? "needs-install" : this.state,
			installed: this.installed,
			componentVersion: BUILD_REMOTE_PEER_DISTRIBUTION?.version ?? null,
			instanceId: this.instanceId,
			peers: this.registry?.contexts.size ?? 0,
			lastError: this.lastError,
			config,
		};
	}
	attach(host: RuntimeHost) {
		if (this.host) throw new Error("REMOTE_RUNTIME_ALREADY_ATTACHED");
		this.host = host;
		this.stopSubscription = subscribeSettingsChanges(() => {
			this.attempts = 0;
			this.enqueue();
		});
		this.enqueue();
		return () => this.stop();
	}
	private enqueue() {
		this.queue = this.queue
			.then(() => this.reconcile())
			.catch(async () => {
				await this.stopOwned().catch(() => {});
				this.state = "failed";
				this.lastError = "REMOTE_CONFIGURATION_FAILED";
			});
	}
	async install() {
		if (this.installing) return this.installing;
		this.installing = (async () => {
			await ensureRemotePeerBinary(undefined, { signal: AbortSignal.timeout(130_000) });
			this.attempts = 0;
			this.enqueue();
			await this.queue;
			return this.status();
		})().finally(() => {
			this.installing = undefined;
		});
		return this.installing;
	}
	private stopOwned() {
		this.closing = true;
		clearTimeout(this.retryTimer);
		const peer = this.peer;
		this.peer = undefined;
		this.bridge?.stop();
		this.bridge = undefined;
		this.registry = undefined;
		this.ownedStop = this.ownedStop.then(() => peer?.stop());
		void this.ownedStop.catch(() => {
			this.state = "failed";
			this.lastError = "REMOTE_PEER_EXIT_TIMEOUT";
		});
		this.instanceId = null;
		this.closing = false;
		return this.ownedStop;
	}
	private async reconcile() {
		const host = this.host;
		if (!host) return;
		const config = this.config();
		const key = JSON.stringify({ config, source: settings.update });
		if (this.peer && key === this.configuration) return;
		await this.stopOwned();
		if (this.host !== host) return;
		this.configuration = key;
		if (!config.enabled || !this.host.lifecycle.accepting) {
			this.state = "disabled";
			return;
		}
		if (this.attempts >= 5) {
			this.state = "failed";
			return;
		}
		const artifact = await getInstalledRemotePeerBinary();
		if (
			this.host !== host ||
			!host.lifecycle.accepting ||
			key !== JSON.stringify({ config: this.config(), source: settings.update })
		)
			return;
		this.installed = !!artifact;
		if (!artifact) {
			this.state = "needs-install";
			return;
		}
		const directory = getNarraforkPath("remote-access");
		// Go exclusively creates/validates the private state directory, including Windows DACL.
		const identity = parseRemoteBackendIdentity({
			nfVersion: APP_VERSION,
			sourceCommit: GIT_COMMIT,
			repository: BUILD_GITHUB_REPOSITORY,
			bootstrapAbi: 1,
			apiEpoch: 1,
			wireVersion: 2,
			capabilities: [...REMOTE_CAPABILITY_NAMES],
		});
		const epoch = remoteSecret();
		const processCapability = remoteSecret();
		const registry = new RemoteAccessRegistry(epoch, identity, (type, payload) => {
			try {
				this.peer?.send(type, payload);
			} catch {
				this.failed("REMOTE_PEER_PIPE_FAILED");
			}
		});
		this.registry = registry;
		this.bridge = createRemoteAccessBridge({ ...this.host, registry, processCapability });
		this.state = "starting";
		this.lastError = null;
		const peer = new RemotePeerProcess(
			artifact.path,
			epoch,
			{
				mode: "narrafork",
				signalUrl: config.signalUrl,
				stunUrls: config.stunUrls,
				iceIPAllowlist: config.iceIPAllowlist,
				iceInterfaceAllowlist: config.iceInterfaceAllowlist,
				iceNetworkTypes: config.iceNetworkTypes,
				allowLocalhost: config.allowLocalhost,
				leaseSeconds: config.leaseSeconds,
				bridgeUrl: this.bridge.url,
				bridgeSecret: processCapability,
				statePath: join(directory, "peer-state.json"),
				backendIdentity: identity,
				requestPolicy: REMOTE_REQUEST_POLICY,
			},
			(event) => {
				if (event.type === "ready") {
					if (
						!isRemoteIpcId(event.payload.instanceId) ||
						typeof event.payload.publicKey !== "string"
					)
						throw new Error("REMOTE_PEER_READY_INVALID");
					this.instanceId = event.payload.instanceId;
				} else if (event.type === "peer.open") {
					try {
						const accepted = registry.accept(event.payload as unknown as RemotePeerOpen);
						this.peer?.send("peer.accept", { ...accepted }, event.requestId);
					} catch {
						this.peer?.send(
							"peer.reject",
							{ peerId: event.payload.peerId, reason: "invalid_open" },
							event.requestId,
						);
					}
				} else if (event.type === "peer.closed" && typeof event.payload.peerId === "string")
					registry.closePeer(event.payload.peerId);
				else if (
					event.type === "grant.changed" &&
					event.payload.revoked === true &&
					typeof event.payload.grantId === "string"
				)
					registry.revokeGrant(event.payload.grantId);
			},
			(code) => this.failed(code),
		);
		this.peer = peer;
		try {
			await peer.ready;
		} catch {
			if (this.peer === peer) this.failed("REMOTE_PEER_START_FAILED");
			return;
		}
		if (this.peer === peer) this.state = "ready";
	}
	private failed(code: string) {
		if (this.closing || !this.host) return;
		this.stopOwned();
		this.attempts++;
		this.lastError = code;
		this.state = this.attempts >= 5 ? "failed" : "backoff";
		if (this.attempts < 5) {
			this.retryTimer = setTimeout(
				() => this.enqueue(),
				Math.min(30_000, 1000 * 2 ** (this.attempts - 1)),
			);
			this.retryTimer.unref();
		}
	}
	async command(
		type: "pair.create" | "pair.cancel" | "grants.list" | "grants.revoke",
		payload: Record<string, unknown> = {},
	) {
		if (!this.peer || this.state !== "ready")
			throw new AppError("Remote access is not ready", 503, "REMOTE_NOT_READY");
		if (type === "grants.revoke" && typeof payload.grantId === "string")
			this.registry?.revokeGrant(payload.grantId);
		try {
			return await this.peer.command(type, payload);
		} catch {
			throw new AppError("Remote component command failed", 503, "REMOTE_COMMAND_FAILED");
		}
	}
	stop() {
		this.stopSubscription?.();
		this.stopSubscription = undefined;
		this.host = undefined;
		const stopped = this.stopOwned();
		this.state = "disabled";
		return stopped;
	}
}
export const remoteAccessRuntime = new RemoteAccessRuntime();
export function attachRemoteAccessRuntime(host: RuntimeHost) {
	return remoteAccessRuntime.attach(host);
}
