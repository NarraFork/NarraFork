/** A process-local capability marker. No header or public Hono binding can populate it. */
export interface TrustedRemoteRequestContext {
	contextId: string;
	grantId: string;
	clientIp: string;
}
const requests = new WeakMap<Request, TrustedRemoteRequestContext>();
export function markTrustedRemoteRequest(
	request: Request,
	context: TrustedRemoteRequestContext,
): void {
	requests.set(request, Object.freeze({ ...context }));
}
export function trustedRemoteRequestContext(
	request: Request,
): TrustedRemoteRequestContext | undefined {
	return requests.get(request);
}
