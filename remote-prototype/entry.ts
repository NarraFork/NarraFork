import {
	type Invitation,
	loadGrant,
	PrototypeClient,
	resourceBlob,
	takeFragmentInvitation,
} from "./client";

export * from "./client";

function element<T extends HTMLElement>(id: string, type: { new (...args: never[]): T }): T {
	const value = document.getElementById(id);
	if (!(value instanceof type)) throw new Error(`missing_element_${id}`);
	return value;
}
const invitationInput = element("invitation", HTMLTextAreaElement);
const expectedInput = element("expected", HTMLInputElement);
const localInput = element("localhost", HTMLInputElement);
const stunInput = element("stun", HTMLInputElement);
const tokenInput = element("token", HTMLInputElement);
const uploadInput = element("upload", HTMLInputElement);
const output = element("output", HTMLPreElement);
const status = element("state", HTMLParagraphElement);
let client: PrototypeClient | undefined;
let token = "";
let operation: AbortController | undefined;

// Intentionally log only explicit business demo results, candidate types and safe error codes.
function log(message: string): void {
	output.textContent = `${output.textContent ?? ""}${message.slice(0, 8192)}\n`.slice(-65536);
}
function safeError(error: unknown): string {
	if (error instanceof Error && /^[a-zA-Z0-9_]+$/.test(error.message)) return error.message;
	return "operation_failed";
}
function action(id: string, execute: () => Promise<void> | void): void {
	element(id, HTMLButtonElement).addEventListener("click", () => {
		void Promise.resolve()
			.then(execute)
			.catch((error) => {
				status.textContent = safeError(error);
				log(safeError(error));
			});
	});
}
function connected(): PrototypeClient {
	if (!client) throw new Error("not_connected");
	return client;
}
function options() {
	return {
		expectedInstanceId: expectedInput.value.trim() || undefined,
		allowLocalhost: localInput.checked,
		stunUrls: stunInput.value
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean),
	};
}
try {
	const invitation = takeFragmentInvitation();
	if (invitation) invitationInput.value = JSON.stringify(invitation, null, 2);
} catch (error) {
	status.textContent = safeError(error);
}

async function connect(invitation: Invitation, grant?: Awaited<ReturnType<typeof loadGrant>>) {
	client?.close();
	token = "";
	tokenInput.value = "";
	status.textContent = "信令 / 收集 ICE / 配对中";
	// Remove the invitation (including pairing secret) from DOM before any network operation.
	invitationInput.value = "";
	client = await PrototypeClient.connect(invitation, { ...options(), grant });
	status.textContent = "已配对，等待 B 业务认证";
	log("paired");
}
action("connect", async () => {
	if (invitationInput.value.length > 8192) throw new Error("invitation_too_large");
	const invitation = JSON.parse(invitationInput.value) as Invitation;
	await connect(invitation);
});
action("reconnect", async () => {
	const id =
		location.hostname.split(".")[0]?.length === 52
			? location.hostname.split(".")[0]
			: expectedInput.value.trim();
	const grant = await loadGrant(id ?? "");
	if (!grant) throw new Error("saved_grant_missing");
	await connect(
		{
			instanceId: grant.instanceId,
			publicKey: grant.publicKey,
			signalUrl: grant.signalUrl,
			discoveryCapability: grant.discoveryCapability,
			pairId: "",
			pairingSecret: "",
		},
		grant,
	);
});
action("disconnect", () => {
	operation?.abort();
	client?.close();
	client = undefined;
	token = "";
	tokenInput.value = "";
	status.textContent = "已断开";
});
action("authenticate", async () => {
	token = tokenInput.value.trim();
	tokenInput.value = "";
	await connected().authenticate(token);
	status.textContent = "ready（wire/API/app 版本已匹配）";
});
action("fixture-login", async () => {
	const response = await connected().request("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: "admin", password: "prototype-admin" }),
	});
	if (!response.ok) throw new Error("fixture_login_failed");
	const body = (await response.json()) as { token: string };
	token = body.token;
	await connected().authenticate(token);
	status.textContent = "fixture ready";
});
action("projects", async () => {
	log(await (await connected().request("/api/projects")).text());
});
action("stats", async () => {
	log(JSON.stringify(await connected().candidateStats()));
});
action("sse", async () => {
	operation?.abort();
	operation = new AbortController();
	const response = await connected().request("/api/events", { signal: operation.signal });
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing_response_body");
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const decoded = decoder.decode(value, { stream: true });
			if (decoded) log(decoded);
		}
		const tail = decoder.decode();
		if (tail) log(tail);
	} finally {
		reader.releaseLock();
	}
});
action("socket", async () => {
	const socket = connected().openSocket("/ws/narrator", token);
	socket.onmessage = (event) => log(event.data);
	socket.onclose = () => log("socket_closed");
	await socket.ready;
	socket.send(JSON.stringify({ type: "subscribe", narratorIds: ["fixture"] }));
	socket.send(JSON.stringify({ type: "ping" }));
});
action("blob", async () => {
	operation?.abort();
	operation = new AbortController();
	const resource = await resourceBlob(connected(), "/api/download?size=131072", operation.signal);
	try {
		log(`blob bytes=${resource.blob.size}, URL created`);
	} finally {
		resource.revoke();
		log("blob URL revoked");
	}
});
action("send-upload", async () => {
	const file = uploadInput.files?.[0];
	if (!file || file.size > 8 * 1024 * 1024 - 4096) throw new Error("file_too_large_or_missing");
	const form = new FormData();
	form.append("file", file);
	operation?.abort();
	operation = new AbortController();
	const response = await connected().request("/api/upload", {
		method: "POST",
		body: form,
		signal: operation.signal,
	});
	log(await response.text());
});
action("cancel", () => {
	operation?.abort();
});
window.addEventListener("pagehide", () => {
	operation?.abort();
	client?.close();
});
