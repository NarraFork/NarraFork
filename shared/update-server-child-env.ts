/**
 * Upload authority belongs to the update-server HTTP publisher, never its CLI helpers.
 * Copy rather than mutate the publisher environment; retain GitHub auth, proxy/CA and
 * platform-specific tool settings. Case-insensitive names also cover Windows environments.
 */
export function updateServerChildEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(([name]) => {
			const normalized = name.toUpperCase();
			return normalized !== "NF_UPDATE_TOKEN" && normalized !== "NF_UPDATE_SERVER";
		}),
	);
}
