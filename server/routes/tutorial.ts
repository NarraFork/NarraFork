import { Hono } from "hono";
import { catalogError } from "../lib/errors";

// Compatibility only: stale clients must not start sessions or mutate saved data.
// Authentication is still inherited from app.ts; the global handler serializes 410.
export const tutorialRoutes = new Hono().all("*", () => {
	throw catalogError("TUTORIAL_REMOVED");
});
