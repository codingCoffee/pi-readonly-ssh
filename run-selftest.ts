// Standalone self-test runner. Execute with: bun run-selftest.ts
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveConfigPath } from "./src/config.js";
import { runSelfTests } from "./src/selftest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(resolveConfigPath(__dirname));
const failures = runSelfTests(cfg);
if (failures.length === 0) {
	console.log(`OK: ${cfg.commands.length} commands, all self-tests pass.`);
	process.exit(0);
} else {
	console.error(`FAIL: ${failures.length} failure(s):`);
	for (const f of failures) console.error("  - " + f);
	process.exit(1);
}
