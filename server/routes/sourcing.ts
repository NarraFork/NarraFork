import { Hono } from "hono";
import { getSourcingCatalog } from "../lib/sourcing/presets";

/**
 * Service templates and the add-provider catalog. Behind the session gate like the add page
 * itself; it carries no user data or secrets, only build-time constants.
 */
export const sourcingRoutes = new Hono().get("/templates", (c) => c.json(getSourcingCatalog()));
