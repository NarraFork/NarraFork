import {
	parseRemoteBackendIdentity,
	REMOTE_CAPABILITY_NAMES,
	type RemoteBackendIdentity,
} from "../../../shared/remote-access/application";
import { REMOTE_BRIDGE_HEADERS, type RemotePeerOpen } from "../../../shared/remote-access/ipc";
import { app } from "../../app";
import { createServerRequestDispatcher } from "../../http-dispatcher";
import { createServerRequestLifecycle } from "../../http-request-lifecycle";
import { createStartupReadinessGate } from "../../lib/startup-readiness";
import { APP_VERSION, BUILD_GITHUB_REPOSITORY, GIT_COMMIT } from "../../lib/version";
import { type WSData, wsHandlers } from "../../websocket/ws-handler";
import { createRemoteAccessBridge } from "../remote-access-bridge";
import {
	RemoteAccessRegistry,
	type RemoteNotification,
	remoteSecret,
} from "../remote-access-registry";

/** Real app/DB/dispatcher/WS; use only under tests/preload's isolated NARRAFORK_HOME. */
export function createProductionRemoteBackendHarness(
	options: {
		ready?: boolean;
		/** Selection-protocol fixtures only; does not claim historical NF business compatibility. */
		identity?: RemoteBackendIdentity;
		backend?: "sqlite" | "postgres";
		notify?: RemoteNotification;
		budgets?: Parameters<typeof createRemoteAccessBridge>[0]["budgets"];
	} = {},
) {
	if (process.env.NARRAFORK_TEST !== "1")
		throw new Error("An isolated test environment is required");
	const lifecycle = createServerRequestLifecycle();
	const readiness = createStartupReadinessGate();
	if (options.ready !== false) {
		readiness.markReady();
		readiness.settle({ ok: true });
	}
	const dispatch = createServerRequestDispatcher({
		app,
		lifecycle,
		startupReadiness: readiness,
		activeDatabaseBackend: options.backend ?? "sqlite",
	});
	const identity = options.identity
		? parseRemoteBackendIdentity(options.identity)
		: {
				nfVersion: APP_VERSION,
				sourceCommit: GIT_COMMIT,
				repository: BUILD_GITHUB_REPOSITORY,
				bootstrapAbi: 1,
				apiEpoch: 1,
				wireVersion: 2,
				capabilities: [...REMOTE_CAPABILITY_NAMES],
			};
	const epoch = remoteSecret();
	const processCapability = remoteSecret();
	const registry = new RemoteAccessRegistry(epoch, identity, options.notify);
	const bridge = createRemoteAccessBridge({
		dispatch,
		lifecycle,
		readiness,
		registry,
		processCapability,
		budgets: options.budgets,
	});
	const ordinary = Bun.serve<WSData>({
		hostname: "127.0.0.1",
		port: 0,
		fetch: dispatch,
		websocket: wsHandlers,
	});
	return {
		app,
		dispatch,
		lifecycle,
		readiness,
		identity,
		epoch,
		processCapability,
		registry,
		bridge,
		url: ordinary.url.origin,
		acceptPeer(peer?: RemotePeerOpen) {
			const accepted = registry.accept(
				peer ?? {
					peerId: remoteSecret(),
					grantId: remoteSecret(),
					instanceId: "test_instance",
					clientPublicKey: "test_public_key",
					grantExpiresAt: Math.floor(Date.now() / 1000) + 3600,
				},
			);
			return {
				...accepted,
				headers: {
					[REMOTE_BRIDGE_HEADERS.process]: processCapability,
					[REMOTE_BRIDGE_HEADERS.epoch]: epoch,
					[REMOTE_BRIDGE_HEADERS.context]: accepted.contextId,
					[REMOTE_BRIDGE_HEADERS.capability]: accepted.contextCapability,
				},
			};
		},
		async stop() {
			lifecycle.stopAccepting();
			bridge.stop();
			lifecycle.abortAll();
			void ordinary.stop(true);
			await lifecycle.drain();
		},
	};
}
