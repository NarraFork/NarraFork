import { nanoid } from "nanoid";

export function generateId(size = 21): string {
	return nanoid(size);
}

export function generateShortId(size = 8): string {
	return nanoid(size);
}
