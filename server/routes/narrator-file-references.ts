import { MAX_FILE_REFERENCE_METADATA_BYTES } from "@shared/file-reference";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppError, zodValidationError } from "../lib/errors";
import {
	previewFileReferenceSchema,
	resolveFileReferencesSchema,
	searchFileReferencesSchema,
} from "../lib/validators/file-references";
import {
	type FileReferenceService,
	fileReferenceService,
} from "../services/file-reference-service";

/** Injectable service keeps route tests isolated from DB, devices and user files. */
export function createFileReferenceRoutes(service: FileReferenceService = fileReferenceService) {
	const routes = new Hono();
	routes.use("*", async (c, next) => {
		if (!c.get("user")?.sub) throw new AppError("Authentication required", 401, "UNAUTHORIZED");
		c.header("Cache-Control", "no-store");
		await next();
	});
	routes.get("/search", async (c) => {
		const parsed = searchFileReferencesSchema.safeParse(c.req.query());
		if (!parsed.success) throw zodValidationError(parsed.error);
		return c.json(
			await service.searchFileReferences(
				c.req.param("id") ?? "",
				c.get("user").sub,
				parsed.data,
				c.req.raw.signal,
			),
		);
	});
	routes.post(
		"/resolve",
		bodyLimit({
			maxSize: MAX_FILE_REFERENCE_METADATA_BYTES + 1024,
			onError: () => {
				throw new AppError(
					"File reference metadata body exceeds its byte budget",
					413,
					"FILE_REFERENCE_METADATA_TOO_LARGE",
				);
			},
		}),
		async (c) => {
			let body: unknown;
			try {
				body = await c.req.json();
			} catch (error) {
				if (error instanceof Error && error.name === "BodyLimitError")
					throw new AppError(
						"File reference metadata body exceeds its byte budget",
						413,
						"FILE_REFERENCE_METADATA_TOO_LARGE",
					);
				throw new AppError("Invalid JSON body", 400, "VALIDATION_ERROR");
			}
			const parsed = resolveFileReferencesSchema.safeParse(body);
			if (!parsed.success) throw zodValidationError(parsed.error);
			return c.json({
				targets: await service.resolveFileReferences(
					c.req.param("id") ?? "",
					c.get("user").sub,
					parsed.data.targets,
					c.req.raw.signal,
				),
			});
		},
	);
	routes.get("/preview", async (c) => {
		const parsed = previewFileReferenceSchema.safeParse(c.req.query());
		if (!parsed.success) throw zodValidationError(parsed.error);
		return c.json(
			await service.previewFileReference(
				c.req.param("id") ?? "",
				c.get("user").sub,
				parsed.data,
				c.req.raw.signal,
			),
		);
	});
	routes.get("/image-preview", async (c) => {
		const parsed = previewFileReferenceSchema.safeParse(c.req.query());
		if (!parsed.success) throw zodValidationError(parsed.error);
		const image = await service.previewFileReferenceImage(
			c.req.param("id") ?? "",
			c.get("user").sub,
			parsed.data,
			c.req.raw.signal,
		);
		c.header("Content-Type", image.mimeType);
		c.header("Content-Length", String(image.bytes.byteLength));
		c.header("X-Content-Type-Options", "nosniff");
		// Defense in depth for direct navigation. Consumers must use img, never iframe/HTML.
		c.header("Content-Security-Policy", "default-src 'none'; sandbox");
		return c.body(new Uint8Array(image.bytes));
	});
	return routes;
}

export const fileReferenceRoutes = createFileReferenceRoutes();
