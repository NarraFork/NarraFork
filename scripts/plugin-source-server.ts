import { resolve } from "node:path";
import {
	createPluginSourceFeed,
	pluginSourcePublicOrigin,
} from "../server/lib/plugins/source-feed";

export interface PluginSourceServerOptions {
	root: string;
	host: string;
	port: number;
	publicOrigin: string;
}

export function parsePluginSourceServerArgs(args: string[]): PluginSourceServerOptions {
	const values = new Map<string, string>();
	for (const argument of args) {
		const match = /^--(root|host|port|origin)=(.+)$/.exec(argument);
		if (!match || values.has(match[1] ?? ""))
			throw new Error("Invalid or duplicate source-server argument");
		values.set(match[1] ?? "", match[2] ?? "");
	}
	if (!values.get("root"))
		throw new Error("An explicit --root public release directory is required");
	const host = values.get("host") ?? "127.0.0.1";
	if (!/^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)$/.test(host))
		throw new Error("Unsupported source-server bind address");
	const port = Number(values.get("port") ?? "8910");
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
		throw new Error("Invalid source-server port");
	if (host === "0.0.0.0" && !values.has("origin"))
		throw new Error("Non-loopback binding requires an explicit public HTTPS origin");
	const publicOrigin = pluginSourcePublicOrigin(values.get("origin") ?? `http://127.0.0.1:${port}`);
	return { root: resolve(values.get("root") ?? ""), host, port, publicOrigin };
}

export async function startPluginSourceServer(options: PluginSourceServerOptions) {
	const app = await createPluginSourceFeed(options);
	return Bun.serve({
		hostname: options.host.replace(/^\[|\]$/g, ""),
		port: options.port,
		idleTimeout: 30,
		maxRequestBodySize: 1024,
		fetch: app.fetch,
	});
}

if (import.meta.main) {
	try {
		const options = parsePluginSourceServerArgs(process.argv.slice(2));
		const server = await startPluginSourceServer(options);
		console.info(
			`Plugin source reference API listening at ${server.url}; public origin: ${options.publicOrigin}`,
		);
		const stop = () => {
			void server.stop(true);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Plugin source server failed");
		process.exitCode = 1;
	}
}
