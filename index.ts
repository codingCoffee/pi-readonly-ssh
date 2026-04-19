/**
 * readonly-ssh
 *
 * A pi extension that gives the LLM a new `ssh_exec` tool to run strictly
 * allow-listed, read-only commands on remote hosts over SSH.
 *
 * The allowlist lives in `commands.yaml` next to this file. Edit it and run
 * `/ssh-reload` to apply changes without restarting pi.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ensureConfig, loadConfig, resolveConfigPath, type Config } from "./src/config.js";
import { runSelfTests } from "./src/selftest.js";
import { registerSshExecTool } from "./src/tool.js";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
	const configPath = resolveConfigPath(__dirname);

	// Seed default YAML (the one that ships with the extension) if missing.
	const defaultYamlPath = resolve(__dirname, "commands.yaml");
	let defaultYaml = "";
	try {
		defaultYaml = readFileSync(defaultYamlPath, "utf8");
	} catch {
		// If the bundled yaml is somehow missing (unlikely), fall back to a minimal one.
		defaultYaml = "settings: {}\nhosts: []\ncommands: []\n";
	}
	ensureConfig(configPath, defaultYaml);

	let config: Config = loadConfig(configPath);
	let savedActiveTools: string[] | null = null;

	const applyStrictMode = () => {
		if (config.settings.strict_mode) {
			if (savedActiveTools === null) {
				savedActiveTools = pi.getActiveTools();
			}
			const filtered = pi.getAllTools()
				.map((t) => t.name)
				.filter((n) => n !== "bash");
			pi.setActiveTools(filtered);
		} else if (savedActiveTools !== null) {
			pi.setActiveTools(savedActiveTools);
			savedActiveTools = null;
		}
	};

	registerSshExecTool(pi, () => config);

	pi.on("session_start", async (_event, ctx) => {
		// Self-test on load so misconfigurations are loud.
		const failures = runSelfTests(config);
		if (failures.length > 0) {
			ctx.ui.notify(
				`readonly-ssh: ${failures.length} self-test failure(s). Check /ssh-reload output.`,
				"error",
			);
			for (const f of failures.slice(0, 5)) {
				console.error(`[readonly-ssh] selftest: ${f}`);
			}
		}

		applyStrictMode();

		const hostCount = config.hosts.length;
		const cmdCount = config.commands.length;
		ctx.ui.setStatus(
			"readonly-ssh",
			ctx.ui.theme.fg(
				"accent",
				`ro-ssh: ${cmdCount} cmds, ${hostCount} host${hostCount === 1 ? "" : "s"}${config.settings.strict_mode ? " [strict]" : ""}`,
			),
		);

		if (hostCount === 0) {
			ctx.ui.notify(
				`readonly-ssh: no hosts configured. Edit ${configPath} and run /ssh-reload.`,
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		// Restore tools we disabled in strict mode, best-effort.
		if (savedActiveTools !== null) {
			try {
				pi.setActiveTools(savedActiveTools);
			} catch {
				/* ignore */
			}
		}
	});

	pi.registerCommand("ssh-allowed", {
		description: "List commands the readonly-ssh extension permits",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			lines.push(`readonly-ssh allowlist (${config.path})`);
			lines.push("");
			for (const c of config.commands) {
				let line = `  ${c.name}`;
				if (c.subcommands?.length) line += ` [${c.subcommands.join("|")}]`;
				if (c.banned_flags?.length) line += ` banned: ${c.banned_flags.join(" ")}`;
				if (typeof c.max_args === "number") line += ` max_args=${c.max_args}`;
				lines.push(line);
			}
			ctx.ui.notify(`${config.commands.length} allowed commands — see console`, "info");
			console.log(lines.join("\n"));
		},
	});

	pi.registerCommand("ssh-hosts", {
		description: "List hosts the readonly-ssh extension may target",
		handler: async (_args, ctx) => {
			if (config.hosts.length === 0) {
				ctx.ui.notify(`No hosts configured. Edit ${config.path} and run /ssh-reload.`, "warning");
				return;
			}
			const lines = config.hosts.map((h) => `  ${h.name}  ->  ${h.ssh}`);
			console.log(`readonly-ssh hosts (${config.path})`);
			console.log(lines.join("\n"));
			ctx.ui.notify(`${config.hosts.length} host(s) — see console`, "info");
		},
	});

	pi.registerCommand("ssh-reload", {
		description: "Re-read the readonly-ssh YAML allowlist",
		handler: async (_args, ctx) => {
			try {
				config = loadConfig(configPath);
			} catch (e) {
				ctx.ui.notify(`readonly-ssh: reload failed: ${(e as Error).message}`, "error");
				return;
			}
			const failures = runSelfTests(config);
			applyStrictMode();
			ctx.ui.setStatus(
				"readonly-ssh",
				ctx.ui.theme.fg(
					"accent",
					`ro-ssh: ${config.commands.length} cmds, ${config.hosts.length} hosts${config.settings.strict_mode ? " [strict]" : ""}`,
				),
			);
			if (failures.length > 0) {
				ctx.ui.notify(
					`readonly-ssh reloaded, but ${failures.length} self-test failure(s). See console.`,
					"warning",
				);
				for (const f of failures) console.error(`[readonly-ssh] selftest: ${f}`);
			} else {
				ctx.ui.notify(
					`readonly-ssh reloaded: ${config.commands.length} cmds, ${config.hosts.length} host(s). Self-tests passed.`,
					"success",
				);
			}
		},
	});
}
