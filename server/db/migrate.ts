import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "./index";

migrate(db, { migrationsFolder: "./drizzle" });
console.log("Migrations complete.");
