import { useEffect, useState } from "react";
import { getAvatarUrl, getToken } from "../lib/api";

/**
 * Fetch an authenticated avatar image and return a local blob URL.
 * Automatically revokes the previous blob URL on change/unmount.
 */
export function useAvatarBlobUrl(
	userId: string | null | undefined,
	avatarImageId: string | null | undefined,
): string | null {
	const [blobUrl, setBlobUrl] = useState<string | null>(null);

	useEffect(() => {
		if (!userId || !avatarImageId) {
			setBlobUrl(null);
			return;
		}

		const token = getToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;

		let cancelled = false;
		let objectUrl: string | null = null;

		fetch(getAvatarUrl(userId, avatarImageId), { headers })
			.then((res) => (res.ok ? res.blob() : null))
			.then((blob) => {
				if (blob && !cancelled) {
					objectUrl = URL.createObjectURL(blob);
					setBlobUrl(objectUrl);
				}
			})
			.catch(() => {});

		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [userId, avatarImageId]);

	return blobUrl;
}
