const mode = Bun.argv[2] ?? "normal";
const encoder = new TextEncoder();
let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

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

function parseFrames(): void {
	while (true) {
		const marker = new Uint8Array([13, 10, 13, 10]);
		let delimiter = -1;
		for (let index = 0; index <= buffer.length - marker.length; index++) {
			if (
				buffer[index] === 13 &&
				buffer[index + 1] === 10 &&
				buffer[index + 2] === 13 &&
				buffer[index + 3] === 10
			) {
				delimiter = index;
				break;
			}
		}
		if (delimiter < 0) return;
		const header = new TextDecoder().decode(buffer.slice(0, delimiter));
		const match = /(?:^|\r\n)content-length:\s*(\d+)\s*$/im.exec(header);
		if (!match) return;
		const length = Number(match[1]);
		const bodyStart = delimiter + 4;
		if (buffer.length < bodyStart + length) return;
		const body = JSON.parse(
			new TextDecoder().decode(buffer.slice(bodyStart, bodyStart + length)),
		) as {
			id?: string | number;
			method?: string;
		};
		buffer = buffer.slice(bodyStart + length);
		handle(body);
	}
}

function handle(message: { id?: string | number; method?: string }): void {
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
		params: { pluginId: "com.example.runtime", version: "1.0.0", rpcProtocol: "narrafork.rpc/1" },
	});
	setTimeout(() => process.exit(37), 20);
} else {
	const hello = () =>
		send({
			jsonrpc: "2.0",
			method: "hello",
			params: { pluginId: "com.example.runtime", version: "1.0.0", rpcProtocol: "narrafork.rpc/1" },
		});
	if (mode === "slow") setTimeout(hello, 250);
	else setTimeout(hello, 0);
}

process.stdin.on("data", (chunk: Uint8Array) => {
	buffer = concat(buffer, new Uint8Array(chunk));
	parseFrames();
});
