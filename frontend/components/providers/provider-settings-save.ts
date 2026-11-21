import type { TokenDancePublicConnection } from "@shared/tokendance";

export async function saveProviderSettings<T>(
	saveSettings: () => Promise<T>,
	saveConnection?: () => Promise<TokenDancePublicConnection>,
): Promise<T> {
	const response = await saveSettings();
	if (!saveConnection) return response;
	const tokendance = await saveConnection();
	return { ...response, tokendance };
}
