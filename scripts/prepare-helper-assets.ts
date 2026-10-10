import { resolve } from "node:path";
import { HELPER_PLATFORMS, type HelperPlatform } from "../shared/helper-distribution";
import { prepareHelperPlatform, prepareZstdHelper, smokeHelperPlatform } from "./lib/helper-build";

const args = process.argv.slice(2);
const option = (name: string, fallback = "") =>
	args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const platform = option(
	"platform",
	`${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
) as HelperPlatform;
if (!HELPER_PLATFORMS.includes(platform)) throw new Error("Invalid helper platform");
const output = resolve(option("output", ".helper-release/local"));
const cache = resolve(option("cache", `.helper-release/cache/${platform}`));
if (option("tool") === "zstd") await prepareZstdHelper(platform, cache, output);
else await prepareHelperPlatform(platform, cache, output);
if (args.includes("--smoke")) await smokeHelperPlatform(platform, output);
console.log(`Prepared locally at ${output}; no Release or update-server writes performed.`);
