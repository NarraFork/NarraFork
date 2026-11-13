import { expect, mock, test } from "bun:test";
import type { RemoteBackendIdentity } from "@shared/remote-access/application";
import { type RecoverableClient, RecoveringTransport } from "./recovering-transport";

const identity: RemoteBackendIdentity = {
	nfVersion: "0.1.0",
	sourceCommit: "a".repeat(40),
	repository: "owner/nf",
	bootstrapAbi: 1,
	apiEpoch: 1,
	wireVersion: 2,
	capabilities: ["projects"],
};
function client(): RecoverableClient & { state: string } {
	const instance = {
		state: "paired",
		backendIdentity: identity,
		authenticate: mock(async (_token: string) => {
			instance.state = "ready";
		}),
		request: mock(async () => Response.json({ ok: true })),
		upload: mock(async () => Response.json({ ok: true })),
		openSocket: mock(() => {
			throw new Error("unused");
		}),
		close: mock(() => {
			instance.state = "closed";
		}),
	};
	return instance;
}
test("read-only recovery reauthenticates with pinned identity and retries once", async () => {
	const first = client();
	const next = client();
	first.request = mock(async () => {
		first.state = "closed";
		throw new Error("connection lost");
	});
	const reconnect = mock(async () => next);
	const status = mock(() => {});
	const transport = new RecoveringTransport(first, reconnect, status);
	await transport.authenticate("nfs_session");
	await transport.request("/api/projects");
	expect(reconnect).toHaveBeenCalledTimes(1);
	expect(next.authenticate).toHaveBeenCalledWith("nfs_session");
	expect(next.request).toHaveBeenCalledTimes(1);
	expect(status).toHaveBeenCalledWith("recovering");
});
test("ambiguous write and upload failure is never replayed", async () => {
	const first = client();
	const reconnect = mock(async () => client());
	const transport = new RecoveringTransport(first, reconnect);
	first.request = mock(async () => {
		first.state = "closed";
		throw new Error("result unknown");
	});
	await expect(
		transport.request("/api/narrators/abc/messages", { method: "POST", body: "{}" }),
	).rejects.toThrow("result unknown");
	expect(reconnect).not.toHaveBeenCalled();
	first.state = "ready";
	first.upload = mock(async () => {
		first.state = "closed";
		throw new Error("result unknown");
	});
	await expect(
		transport.upload("/api/narrator-attachments/abc", new Blob(["data"])),
	).rejects.toThrow("result unknown");
	expect(reconnect).not.toHaveBeenCalled();
});
test("a changed backend identity closes the replacement without sending the token", async () => {
	const first = client();
	const next = client();
	Object.assign(next, { backendIdentity: { ...identity, sourceCommit: "b".repeat(40) } });
	const transport = new RecoveringTransport(first, async () => next);
	await transport.authenticate("nfs_secret");
	first.state = "closed";
	await expect(transport.request("/api/projects")).rejects.toThrow(
		"REMOTE_BACKEND_IDENTITY_CHANGED",
	);
	expect(next.authenticate).not.toHaveBeenCalled();
	expect(next.close).toHaveBeenCalledTimes(1);
});
test("parallel reads share one recovery; cancellation never replays", async () => {
	const first = client();
	const next = client();
	const reconnect = mock(async () => next);
	const transport = new RecoveringTransport(first, reconnect);
	first.state = "closed";
	await Promise.all([transport.request("/api/projects"), transport.request("/api/projects")]);
	expect(reconnect).toHaveBeenCalledTimes(1);
	const controller = new AbortController();
	controller.abort();
	await expect(transport.request("/api/projects", { signal: controller.signal })).rejects.toThrow();
	expect(next.request).toHaveBeenCalledTimes(2);
});
test("closing the owner prevents late reconnect from resurrecting the application", async () => {
	const first = client();
	const next = client();
	let resolve!: (value: RecoverableClient) => void;
	const transport = new RecoveringTransport(
		first,
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	first.state = "closed";
	const request = transport.request("/api/projects");
	transport.close();
	resolve(next);
	await expect(request).rejects.toThrow();
	expect(next.request).not.toHaveBeenCalled();
	expect(next.close).toHaveBeenCalledTimes(1);
});
