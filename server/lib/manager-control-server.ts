import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { managerControlCompanionHost } from "../../shared/server-host";
import { isManagerTokenAuthorized } from "./manager-token";

export type ListenerResource = {
	url: URL;
	port: number | undefined;
	stop(force: boolean): unknown;
};

/** Bun's bind error message varies by platform; its code also covers companion conflicts. */
export function isListenerPortConflict(error: unknown): boolean {
	if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE")
		return true;
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("EADDRINUSE") || message.includes("address already in use");
}

export type ManagerControlPeer = Pick<Bun.Server<undefined>, "requestIP">;
type ControlDispatch = (
	request: Request,
	server: ManagerControlPeer,
) => Response | undefined | Promise<Response | undefined>;

/** Resolve DNS once before binding, so the control destination reflects the actual socket.
 * In unmanaged mode retain Bun's existing hostname behavior. No credential ever targets DNS.
 */
export async function resolveManagerListenHost(
	host: string,
	managerToken: string | undefined,
	resolveHost: (host: string) => Promise<{ address: string }> = lookup,
): Promise<string> {
	const bare = host.replace(/^\[|\]$/g, "");
	if (!managerToken || !bare || isIP(bare)) return bare;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			resolveHost(bare).then(({ address }) => {
				if (!isIP(address)) throw new Error("DNS did not return an IP address");
				return address;
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Manager listen host DNS lookup timed out")),
					5000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Only the newest requested rebind may commit after asynchronous DNS resolution.
 * The commit callback is synchronous: it must detach/bind/rollback as one atomic operation.
 */
export function createManagerRebindCoordinator<Address>(options: {
	resolveHost: (host: string) => Promise<string>;
	getCurrentAddress: () => Address;
	isAccepting: () => boolean;
	rebind: (
		host: string,
		port: number,
		resolvedHost: string,
		rebindOptions?: { preserveResponse: boolean },
	) => Address;
}) {
	let epoch = 0;
	let pending: { epoch: number; host: string; port: number } | undefined;
	const assertAccepting = () => {
		if (!options.isAccepting()) throw new Error("Cannot rebind HTTP listeners during shutdown");
	};
	const isPending = (host: string, port: number) => pending?.host === host && pending.port === port;
	const rebind = async (
		host: string,
		port: number,
		rebindOptions?: { preserveResponse: boolean },
	) => {
		const requestEpoch = ++epoch;
		pending = { epoch: requestEpoch, host, port };
		try {
			assertAccepting();
			let resolvedHost: string;
			try {
				resolvedHost = await options.resolveHost(host);
			} catch (error) {
				assertAccepting();
				if (requestEpoch !== epoch) return options.getCurrentAddress();
				throw error;
			}
			assertAccepting();
			if (requestEpoch !== epoch) return options.getCurrentAddress();
			return options.rebind(host, port, resolvedHost, rebindOptions);
		} finally {
			if (pending?.epoch === requestEpoch) pending = undefined;
		}
	};
	return Object.assign(rebind, {
		isPending,
		/** A file intent can supersede pending DNS even when it needs no new socket. */
		invalidatePendingUnless(host: string, port: number): void {
			if (!pending || isPending(host, port)) return;
			++epoch;
			pending = undefined;
		},
	});
}

/** No session fallback, path prefixes, pages or WebSocket upgrades on the companion socket. */
export function managerControlRefusal(
	request: Request,
	peerIp: string | undefined | null,
	token: string,
): Response | undefined {
	const path = new URL(request.url).pathname;
	const allowed =
		(request.method === "GET" && path === "/api/update/check") ||
		(request.method === "POST" &&
			(path === "/api/update/download" ||
				path === "/api/update/apply" ||
				path === "/api/system/lifecycle/signal"));
	if (!allowed || request.headers.has("upgrade")) {
		return new Response("Not found", { status: 404 });
	}
	if (
		!isManagerTokenAuthorized({
			peerIp,
			authorization: request.headers.get("authorization"),
			expectedToken: token,
		})
	) {
		return new Response("Manager authorization required", { status: 401 });
	}
}

function stopListeners(listeners: ListenerResource[], force: boolean): Promise<void> {
	// Invoke every stop synchronously, even when another member throws. Do not await WS drains.
	const results = listeners.map((listener) => {
		try {
			return Promise.resolve(listener.stop(force));
		} catch (error) {
			return Promise.reject(error);
		}
	});
	return Promise.allSettled(results).then((settled) => {
		const errors = settled.filter((result) => result.status === "rejected");
		if (errors.length) throw new AggregateError(errors.map((result) => result.reason));
	});
}

/** Bind public + optional restricted loopback as one resource; never fallback on control failure. */
export function startManagerListenerGroup<T extends ListenerResource>(options: {
	bindPublic: () => { listener: T; host: string };
	managerToken: string | undefined;
	tls?: Bun.TLSOptions;
	dispatch: ControlDispatch;
	bindControl?: (options: {
		hostname: string;
		port: number;
		tls?: Bun.TLSOptions;
		idleTimeout: number;
		fetch: (request: Request, server: ManagerControlPeer) => Promise<Response>;
	}) => ListenerResource;
}) {
	const { listener, host } = options.bindPublic();
	const listeners: ListenerResource[] = [listener];
	let controlListener: ListenerResource | undefined;
	try {
		const token = options.managerToken;
		const companionHost = managerControlCompanionHost(host);
		if (token && companionHost) {
			if (!listener.port) throw new Error("Public listener has no TCP port for manager control");
			controlListener = (options.bindControl ?? ((config) => Bun.serve(config)))({
				hostname: companionHost,
				port: listener.port,
				tls: options.tls,
				idleTimeout: 255,
				async fetch(request, server) {
					const refusal = managerControlRefusal(request, server.requestIP(request)?.address, token);
					return (
						refusal ??
						(await options.dispatch(request, server)) ??
						new Response("Control handler returned no response", { status: 500 })
					);
				},
			});
			listeners.push(controlListener);
		}
	} catch (error) {
		// A conflict on loopback must not leave a partially-started public service behind.
		void stopListeners(listeners, true).catch(() => {});
		throw error;
	}
	return {
		publicListener: listener,
		controlListener,
		host,
		url: listener.url,
		port: listener.port,
		stop: (force: boolean) => stopListeners(listeners, force),
	};
}
