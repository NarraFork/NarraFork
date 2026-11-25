import { isValidGitHubRepository } from "../../shared/github-repository";
import { mirrorJobTimeoutMs, mirrorTransferTimeoutMs } from "../../shared/mirror-relay";
import { validateWebDavConfig, type WebDavConfig } from "../../shared/webdav-transport";
import type { ServerConfig } from "../types";

export interface MirrorRelaySettings {
	webdav: WebDavConfig;
	/** Internal authentication only. Never log or persist resolved settings. */
	signingKey: string;
	pollIntervalMs: number;
	downloadConcurrency: number;
	totalTimeoutMs?: number;
	products: { product: string; repository: string }[];
}

function secret(name: unknown, env: NodeJS.ProcessEnv): string {
	if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))
		throw new Error("Mirror relay requires credential environment references");
	const value = env[name];
	if (!value || value.length > 4096 || /[\r\n\0]/.test(value))
		throw new Error("Mirror relay credential environment value is missing or invalid");
	return value;
}

/** An unconfigured direct-only server does not inspect relay credentials or start background work. */
export function resolveMirrorRelaySettings(
	config: Pick<ServerConfig, "mirrorRelay" | "mirrorRepositories">,
	env: NodeJS.ProcessEnv = process.env,
): MirrorRelaySettings | undefined {
	const relay = config.mirrorRelay;
	if (!relay || relay.enabled === false) return undefined;
	if (
		relay.enabled !== true ||
		Object.keys(relay).some(
			(key) =>
				![
					"enabled",
					"url",
					"feed",
					"usernameEnv",
					"passwordEnv",
					"bearerTokenEnv",
					"signingKeyEnv",
					"pollIntervalSeconds",
					"downloadConcurrency",
					"downloadRedirectHosts",
					"totalTimeoutMinutes",
					"transferTimeoutMinutes",
				].includes(key),
		)
	)
		throw new Error("Invalid mirror relay configuration");
	for (const minutes of [relay.totalTimeoutMinutes, relay.transferTimeoutMinutes])
		if (minutes !== undefined && typeof minutes !== "number")
			throw new Error("Mirror relay timeouts must be numeric whole minutes");
	const downloadConcurrency =
		relay.downloadConcurrency === undefined ? 8 : relay.downloadConcurrency;
	if (
		!Number.isSafeInteger(downloadConcurrency) ||
		downloadConcurrency < 1 ||
		downloadConcurrency > 8
	)
		throw new Error("Mirror relay download concurrency must be an integer between 1 and 8");
	const pollSeconds = relay.pollIntervalSeconds ?? 60;
	if (!Number.isSafeInteger(pollSeconds) || pollSeconds < 10 || pollSeconds > 3600)
		throw new Error("Mirror relay poll interval must be between 10 and 3600 seconds");
	const products = Object.entries(config.mirrorRepositories ?? {}).map(([product, repository]) => {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(product) || !isValidGitHubRepository(repository))
			throw new Error("Mirror relay requires operator-configured product repositories");
		return { product, repository: repository.toLowerCase() };
	});
	if (!products.length || products.length > 16)
		throw new Error("Mirror relay requires between 1 and 16 configured product repositories");
	const bearer = relay.bearerTokenEnv !== undefined;
	if (
		(bearer && (relay.usernameEnv !== undefined || relay.passwordEnv !== undefined)) ||
		(!bearer && (relay.usernameEnv === undefined || relay.passwordEnv === undefined))
	)
		throw new Error("Mirror relay requires exactly one WebDAV authentication method");
	const webdav = validateWebDavConfig({
		url: relay.url ?? "",
		feed: relay.feed ?? "default",
		...(relay.transferTimeoutMinutes === undefined
			? {}
			: { transferTimeoutMs: mirrorTransferTimeoutMs(relay.transferTimeoutMinutes) }),
		...(relay.downloadRedirectHosts !== undefined
			? { downloadRedirectHosts: relay.downloadRedirectHosts }
			: {}),
		auth: bearer
			? { bearerToken: secret(relay.bearerTokenEnv, env) }
			: { username: secret(relay.usernameEnv, env), password: secret(relay.passwordEnv, env) },
	});
	const totalTimeoutMs =
		relay.totalTimeoutMinutes === undefined
			? undefined
			: mirrorJobTimeoutMs("main", relay.totalTimeoutMinutes);
	if (
		relay.transferTimeoutMinutes !== undefined &&
		mirrorTransferTimeoutMs(relay.transferTimeoutMinutes) >
			(totalTimeoutMs ?? mirrorJobTimeoutMs("main"))
	)
		throw new Error("Mirror relay job deadline must cover its streamed object budget");
	const signingKey = secret(relay.signingKeyEnv, env);
	if (
		!/^[A-Za-z0-9+/]{43}=$/.test(signingKey) ||
		Buffer.from(signingKey, "base64").length !== 32 ||
		Buffer.from(signingKey, "base64").toString("base64") !== signingKey
	)
		throw new Error("Mirror relay signing key must encode exactly 32 random bytes");
	const settings = {
		pollIntervalMs: pollSeconds * 1000,
		downloadConcurrency,
		products,
		...(relay.totalTimeoutMinutes === undefined
			? {}
			: { totalTimeoutMs: mirrorJobTimeoutMs("main", relay.totalTimeoutMinutes) }),
	} as MirrorRelaySettings;
	Object.defineProperties(settings, {
		webdav: { value: webdav, enumerable: false },
		signingKey: { value: signingKey, enumerable: false },
	});
	return Object.freeze(settings);
}
