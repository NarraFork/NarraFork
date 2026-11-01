const mode = Bun.argv[2] ?? "normal";
const encoder = new TextEncoder();
const headerBytes: number[] = [];
let pendingBody: Uint8Array | undefined;
let bodyOffset = 0;
let toolCalls = 0;

type FixtureRpcRequest = {
	id?: string | number;
	method?: string;
	params?: { input?: { text?: string }; contributionId?: string };
};

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
	const result = new Uint8Array(left.byteLength + right.byteLength);
	result.set(left);
	result.set(right, left.byteLength);
	return result;
}

function send(message: Record<string, unknown>): void {
	const body = encoder.encode(JSON.stringify(message));
	const header = encoder.encode(
		`Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
	);
	process.stdout.write(concat(header, body));
}

// Collect each body once rather than repeatedly concatenating a growing multi-MiB buffer.
function parseFrames(chunk: Uint8Array): void {
	let offset = 0;
	while (offset < chunk.length) {
		if (!pendingBody) {
			headerBytes.push(chunk[offset++]);
			const size = headerBytes.length;
			if (size > 8192) throw new Error("Fixture header exceeded 8 KiB");
			if (
				size < 4 ||
				headerBytes[size - 4] !== 13 ||
				headerBytes[size - 3] !== 10 ||
				headerBytes[size - 2] !== 13 ||
				headerBytes[size - 1] !== 10
			)
				continue;
			const header = new TextDecoder().decode(new Uint8Array(headerBytes));
			const match = /(?:^|\r\n)content-length:\s*(\d+)\s*$/im.exec(header);
			const length = Number(match?.[1]);
			if (!Number.isSafeInteger(length) || length < 1 || length > 64 * 1024 * 1024) {
				throw new Error("Invalid fixture body length");
			}
			pendingBody = new Uint8Array(length);
			bodyOffset = 0;
			headerBytes.length = 0;
		}
		const count = Math.min(chunk.length - offset, pendingBody.length - bodyOffset);
		pendingBody.set(chunk.subarray(offset, offset + count), bodyOffset);
		offset += count;
		bodyOffset += count;
		if (bodyOffset === pendingBody.length) {
			const message = JSON.parse(new TextDecoder().decode(pendingBody)) as FixtureRpcRequest;
			pendingBody = undefined;
			handle(message);
		}
	}
}

function handle(message: FixtureRpcRequest): void {
	if (!message.method) return;
	if (message.method === "initialize") {
		if (mode === "notify") send({ jsonrpc: "2.0", method: "initialized", params: { ok: true } });
		else send({ jsonrpc: "2.0", id: message.id, result: { initialized: true } });
		return;
	}
	if (message.method === "activate") {
		if (mode === "notify") send({ jsonrpc: "2.0", method: "activated", params: { ok: true } });
		else send({ jsonrpc: "2.0", id: message.id, result: { activated: true } });
		return;
	}
	if (message.method === "health") {
		if (mode === "notify") send({ jsonrpc: "2.0", method: "healthy", params: { healthy: true } });
		else send({ jsonrpc: "2.0", id: message.id, result: { healthy: true } });
		return;
	}
	if (message.method === "deactivate") {
		send({ jsonrpc: "2.0", id: message.id, result: { deactivated: true } });
		return;
	}
	if (message.method === "shutdown") {
		send({ jsonrpc: "2.0", id: message.id, result: { shutdown: true } });
		setTimeout(() => process.exit(0), 5);
		return;
	}
	if (message.method === "tools.invoke") {
		toolCalls += 1;
		const text = message.params?.input?.text ?? "";
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				output: message.params?.contributionId === "double" ? text.repeat(2) : text,
				isError: false,
				metadata: { toolCalls, childRssBytes: process.memoryUsage().rss },
			},
		});
		return;
	}
	if (message.method === "$/cancelRequest") return;
	if (mode === "slow") {
		setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { ok: true } }), 500);
		return;
	}
	send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
}

process.stderr.write(`fixture-${mode}-stderr-${"x".repeat(256)}\n`);

if (mode === "malformed") {
	setTimeout(() => process.stdout.write("not-a-content-length-frame\n"), 5);
} else if (mode === "crash") {
	send({
		jsonrpc: "2.0",
		method: "hello",
		params: {
			pluginId: "com.example.runtime",
			version: "1.0.0",
			rpcProtocol: "narrafork.rpc/1",
			...(process.env.NF_PLUGIN_PACKAGE_DIGEST
				? { packageDigest: process.env.NF_PLUGIN_PACKAGE_DIGEST }
				: {}),
		},
	});
	setTimeout(() => process.exit(37), 20);
} else {
	const hello = () =>
		send({
			jsonrpc: "2.0",
			method: "hello",
			params: {
				pluginId: "com.example.runtime",
				version: "1.0.0",
				rpcProtocol: "narrafork.rpc/1",
				...(process.env.NF_PLUGIN_PACKAGE_DIGEST
					? { packageDigest: process.env.NF_PLUGIN_PACKAGE_DIGEST }
					: {}),
			},
		});
	if (mode === "slow") setTimeout(hello, 250);
	else setTimeout(hello, 0);
}

process.stdin.on("data", parseFrames);
