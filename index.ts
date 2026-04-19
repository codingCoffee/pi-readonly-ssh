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
	// Load the bundled default so we can seed a user-editable copy on first run.
	const defaultYamlPath = resolve(__dirname, "commands.yaml");
	let defaultYaml = "";
	try {
		defaultYaml = readFileSync(defaultYamlPath, "utf8");
	} catch {
		// If the bundled yaml is somehow missing (unlikely), fall back to a minimal one.
		defaultYaml = "settings: {}\nhosts: []\ncommands: []\n";
	}

	// Seed the XDG config path if no user-owned config exists yet. This returns
	// the path that the user is expected to edit going forward — purely informational.
	ensureConfig(__dirname, defaultYaml);

	// Pick up whichever config file wins the priority chain right now.
	let configPath = resolveConfigPath(__dirname);
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
		const hostBadge = config.settings.allow_any_host
			? `${hostCount} named + any`
			: `${hostCount} host${hostCount === 1 ? "" : "s"}`;
		ctx.ui.setStatus(
			"readonly-ssh",
			ctx.ui.theme.fg(
				"accent",
				`ro-ssh: ${cmdCount} cmds, ${hostBadge}${config.settings.strict_mode ? " [strict]" : ""}`,
			),
		);

		if (hostCount === 0 && !config.settings.allow_any_host) {
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
			lines.push(`readonly-ssh allowlist  (${config.commands.length} commands)`);
			lines.push(config.path);
			lines.push("");
			// Pad command names for alignment.
			const nameWidth = Math.min(
				16,
				config.commands.reduce((w, c) => Math.max(w, c.name.length), 0),
			);
			for (const c of config.commands) {
				const parts: string[] = [];
				if (c.subcommands?.length) parts.push(`sub: ${c.subcommands.join("|")}`);
				if (c.banned_flags?.length) parts.push(`banned: ${c.banned_flags.join(" ")}`);
				if (typeof c.max_args === "number") parts.push(`max_args=${c.max_args}`);
				const name = c.name.padEnd(nameWidth);
				lines.push(parts.length ? `  ${name}  ${parts.join("  ")}` : `  ${name}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("ssh-hosts", {
		description: "List hosts the readonly-ssh extension may target",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			const hostCount = config.hosts.length;
			const header = config.settings.allow_any_host
				? `readonly-ssh hosts  (${hostCount} named + any allowed)`
				: `readonly-ssh hosts  (${hostCount} host${hostCount === 1 ? "" : "s"})`;
			lines.push(header);
			lines.push(config.path);
			lines.push("");

			if (hostCount > 0) {
				const nameWidth = config.hosts.reduce((w, h) => Math.max(w, h.name.length), 0);
				lines.push("  Named hosts:");
				for (const h of config.hosts) {
					lines.push(`    • ${h.name.padEnd(nameWidth)}  →  ${h.ssh}`);
				}
				lines.push("");
			} else {
				lines.push("  (no named hosts configured)");
				lines.push("");
			}

			if (config.settings.allow_any_host) {
				lines.push("  allow_any_host = true");
				lines.push("    → any ssh target (user@host, host, or ~/.ssh/config alias) is accepted.");
			} else {
				lines.push("  allow_any_host = false");
				lines.push("    → only the named hosts above are accepted.");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("ssh-reload", {
		description: "Re-read the readonly-ssh YAML allowlist",
		handler: async (_args, ctx) => {
			try {
				// Re-resolve in case the user just created a higher-priority file
				// (e.g. a new ./.pi/readonly-ssh/commands.yaml).
				configPath = resolveConfigPath(__dirname);
				config = loadConfig(configPath);
			} catch (e) {
				ctx.ui.notify(`readonly-ssh: reload failed: ${(e as Error).message}`, "error");
				return;
			}
			const failures = runSelfTests(config);
			applyStrictMode();
			const badge = config.settings.allow_any_host
				? `${config.hosts.length} named + any`
				: `${config.hosts.length} hosts`;
			ctx.ui.setStatus(
				"readonly-ssh",
				ctx.ui.theme.fg(
					"accent",
					`ro-ssh: ${config.commands.length} cmds, ${badge}${config.settings.strict_mode ? " [strict]" : ""}`,
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
