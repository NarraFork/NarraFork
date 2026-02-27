import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { NotFoundError, ValidationError } from "@server/lib/errors";
import { generateShortId } from "@server/lib/id";
import { Hono } from "hono";

const SOUNDS_DIR = resolve(homedir(), ".narrafork", "notification-sounds");

const ALLOWED_MIME_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm"]);

const MIME_TO_EXT: Record<string, string> = {
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/ogg": ".ogg",
	"audio/webm": ".webm",
};

const MAX_FILE_SIZE = 1 * 1024 * 1024;

function getUserDir(userId: string): string {
	const dir = resolve(SOUNDS_DIR, userId);
	// Prevent path traversal
	if (!dir.startsWith(SOUNDS_DIR)) {
		throw new ValidationError("Invalid user ID");
	}
	return dir;
}

function findFileById(userDir: string, id: string): string | null {
	if (!existsSync(userDir)) return null;
	// Prevent path traversal via id
	if (id.includes("/") || id.includes("\\") || id.includes("..")) {
		throw new ValidationError("Invalid sound ID");
	}
	const files = readdirSync(userDir);
	const match = files.find((f) => f.startsWith(id));
	if (!match) return null;
	const full = resolve(userDir, match);
	if (!full.startsWith(userDir)) {
		throw new ValidationError("Invalid sound ID");
	}
	return full;
}

export const notificationSoundRoutes = new Hono();

notificationSoundRoutes.post("/", async (c) => {
	const userId = c.get("user").sub;
	const formData = await c.req.formData();
	const file = formData.get("file");

	if (!file || !(file instanceof File)) {
		throw new ValidationError("Missing file in form data");
	}

	if (!ALLOWED_MIME_TYPES.has(file.type)) {
		throw new ValidationError(
			`Unsupported MIME type: ${file.type}. Allowed: ${[...ALLOWED_MIME_TYPES].join(", ")}`,
		);
	}

	if (file.size > MAX_FILE_SIZE) {
		throw new ValidationError("File size exceeds 1MB limit");
	}

	const id = generateShortId();
	const ext = MIME_TO_EXT[file.type];
	const userDir = getUserDir(userId);

	if (!existsSync(userDir)) {
		mkdirSync(userDir, { recursive: true });
	}

	const filePath = resolve(userDir, `${id}${ext}`);
	if (!filePath.startsWith(userDir)) {
		throw new ValidationError("Invalid file path");
	}

	await Bun.write(filePath, file);

	return c.json({ id, filename: `${id}${ext}`, mediaType: file.type });
});

notificationSoundRoutes.get("/:id", async (c) => {
	const userId = c.get("user").sub;
	const { id } = c.req.param();
	const userDir = getUserDir(userId);
	const filePath = findFileById(userDir, id);

	if (!filePath) {
		throw new NotFoundError("Notification sound", id);
	}

	const bunFile = Bun.file(filePath);
	const headers = new Headers({
		"Content-Type": bunFile.type,
		"Cache-Control": "public, max-age=86400",
	});

	return new Response(bunFile, { headers });
});

notificationSoundRoutes.delete("/:id", (c) => {
	const userId = c.get("user").sub;
	const { id } = c.req.param();
	const userDir = getUserDir(userId);
	const filePath = findFileById(userDir, id);

	if (!filePath) {
		throw new NotFoundError("Notification sound", id);
	}

	rmSync(filePath);

	return c.json({ ok: true });
});
