/** Only browser-owned blobs or bounded raster data may reach a remote DOM src. */
export function isRemoteInlineImage(source: string): boolean {
	return (
		source.startsWith("blob:") ||
		(source.length <= 12 * 1024 * 1024 &&
			/^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(source))
	);
}
