/** Runtime-only hooks, never persisted in provider settings or shared DTOs. */
export interface ProviderTransport {
	/** Redact connection-specific secrets before the network diagnostic layer records/logs them. */
	redactText?: (text: string) => string;
	/** Runs last, after every configured/user header has been assembled. */
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
): Promise<Response> {
	if (!transport) return next(input, init);
	const headers = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined),
	);
	transport.transportHeaders?.(headers);
	const finalInit = { ...init, headers };
	return transport.fetch ? transport.fetch(input, finalInit, next) : next(input, finalInit);
}
