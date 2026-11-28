/** Runtime-only hooks, never persisted in provider settings or shared DTOs. */
export interface ProviderTransport {
	/** Redact connection-specific secrets before the network diagnostic layer records/logs them. */
	redactText?: (text: string) => string;
	/** Runs after assembled defaults; an explicit operator UA still wins at final send. */
	transportHeaders?: (headers: Headers) => void;
	fetch?: (
		input: string | URL | Request,
		init: RequestInit | undefined,
		next: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
	) => Promise<Response>;
}

export function runProviderTransport(
	transport: ProviderTransport | undefined,
	input: string | URL | Request,
	init: RequestInit | undefined,
	next: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
	/** Operator-selected UA, not a protocol default. All other transport fields remain owned by the transport. */
	explicitUserAgent?: string,
): Promise<Response> {
	const send =
		explicitUserAgent === undefined
			? next
			: (target: string | URL | Request, options?: RequestInit) => {
					const headers = new Headers(
						options?.headers ?? (target instanceof Request ? target.headers : undefined),
					);
					headers.set("User-Agent", explicitUserAgent);
					return next(target, { ...options, headers });
				};
	if (!transport) return send(input, init);
	const headers = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined),
	);
	transport.transportHeaders?.(headers);
	if (explicitUserAgent !== undefined) headers.set("User-Agent", explicitUserAgent);
	const finalInit = { ...init, headers };
	// A transport retry may build fresh headers. Preserve UA at next() as well as
	// in the request given to the hook, without replaying any other static header.
	return transport.fetch ? transport.fetch(input, finalInit, send) : next(input, finalInit);
}
