import { resolve } from "node:path";
import { createRemoteHost } from "../remote-host";
import {
	configureRemoteBootstrap,
	importRemoteFrontend,
	readRemoteFrontendCatalog,
	setRemoteFrontendDisabled,
} from "../remote-host/store";

export async function remoteHostCLI(args: string[] = process.argv.slice(2)): Promise<void> {
	const [command, ...flags] = args;
	if (!command || command === "help" || command === "--help") {
		console.log(
			"Usage:\n  bun scripts/remote-host.ts import --store=DIR --manifest=FILE\n  bun scripts/remote-host.ts bootstrap --store=DIR --build-id=ID\n  bun scripts/remote-host.ts disable --store=DIR --build-id=ID [--disabled=false]\n  bun scripts/remote-host.ts catalog --store=DIR\n  bun scripts/remote-host.ts serve --store=DIR [--bootstrap=ID] [--hostname=127.0.0.1] [--port=8787]\nPublic listeners additionally require --allow-public-tls --tls-cert=FILE --tls-key=FILE --instance-domain=DOMAIN. No API, websocket or business relay is provided.",
		);
		return;
	}
	if (!["import", "bootstrap", "disable", "catalog", "serve"].includes(command))
		throw new Error("REMOTE_HOST_COMMAND_INVALID");
	const values = new Map<string, string>();
	let allowPublic = false;
	for (const flag of flags) {
		if (flag === "--allow-public-tls" && !allowPublic) {
			allowPublic = true;
			continue;
		}
		const match =
			/^--(store|manifest|build-id|disabled|bootstrap|hostname|port|tls-cert|tls-key|instance-domain)=(.+)$/.exec(
				flag,
			);
		if (!match || values.has(match[1])) throw new Error("REMOTE_HOST_ARGUMENT_INVALID");
		values.set(match[1], match[2]);
	}
	const path = values.get("store");
	if (!path) throw new Error("REMOTE_HOST_STORE_REQUIRED");
	const storePath = resolve(path);
	const stop = new AbortController(),
		cancel = () => stop.abort(new Error("REMOTE_HOST_CANCELLED"));
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		if (command === "import") {
			const manifestPath = values.get("manifest");
			if (!manifestPath) throw new Error("REMOTE_HOST_MANIFEST_REQUIRED");
			const manifest = await importRemoteFrontend({
				storePath,
				manifestPath: resolve(manifestPath),
				signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10 * 60_000)]),
			});
			console.log(JSON.stringify({ buildId: manifest.buildId, nfVersion: manifest.nfVersion }));
			return;
		}
		if (command === "catalog") {
			console.log(JSON.stringify(await readRemoteFrontendCatalog(storePath), null, 2));
			return;
		}
		if (command === "disable" || command === "bootstrap") {
			const buildId = values.get("build-id");
			if (!buildId) throw new Error("REMOTE_HOST_BUILD_ID_REQUIRED");
			if (command === "bootstrap") await configureRemoteBootstrap(storePath, buildId, stop.signal);
			else {
				const value = values.get("disabled") ?? "true";
				if (value !== "true" && value !== "false") throw new Error("REMOTE_HOST_DISABLED_INVALID");
				await setRemoteFrontendDisabled(storePath, buildId, value === "true", stop.signal);
			}
			console.log(JSON.stringify({ ok: true, buildId }));
			return;
		}
		const hostname = values.get("hostname") ?? "127.0.0.1",
			port = Number(values.get("port") ?? 8787),
			loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error("REMOTE_HOST_PORT_INVALID");
		const certificate = values.get("tls-cert"),
			key = values.get("tls-key");
		if (
			!!certificate !== !!key ||
			(!loopback && (!allowPublic || !certificate || !key || !values.get("instance-domain")))
		)
			throw new Error("REMOTE_HOST_PUBLIC_TLS_REQUIRED");
		const tls =
			certificate && key
				? { cert: Bun.file(resolve(certificate)), key: Bun.file(resolve(key)) }
				: undefined;
		if (
			tls &&
			(!(await tls.cert.exists()) ||
				!(await tls.key.exists()) ||
				tls.cert.size > 1024 * 1024 ||
				tls.key.size > 1024 * 1024)
		)
			throw new Error("REMOTE_HOST_TLS_FILE_INVALID");
		const host = await createRemoteHost({
			storePath,
			bootstrapBuildId: values.get("bootstrap"),
			allowLocalhost: loopback,
			instanceDomain: values.get("instance-domain"),
			signal: stop.signal,
		});
		const server = Bun.serve({
			hostname,
			port,
			tls,
			fetch: async (request) =>
				(await host.assetHandler(request)) ?? new Response(null, { status: 404 }),
		});
		console.log(
			JSON.stringify({ listening: server.url.origin, bootstrapBuildId: host.bootstrapBuildId }),
		);
		try {
			await new Promise<void>((done) => {
				if (stop.signal.aborted) done();
				else stop.signal.addEventListener("abort", () => done(), { once: true });
			});
		} finally {
			await server.stop(true);
		}
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}
if (import.meta.main)
	remoteHostCLI().catch((error) => {
		console.error(error instanceof Error ? error.message : "REMOTE_HOST_FAILED");
		process.exitCode = 1;
	});
