# @codingcoffee/pi-readonly-ssh

A [pi](https://github.com/mariozechner/pi) extension that exposes an `ssh_exec`
tool to the LLM for running **allow-listed, read-only** commands on remote
hosts over SSH.

[![npm](https://img.shields.io/npm/v/@codingcoffee/pi-readonly-ssh.svg)](https://www.npmjs.com/package/@codingcoffee/pi-readonly-ssh)

> ## ⚠️  Heads up: this extension disables the built-in `bash` tool by default
>
> The shipped `commands.yaml` sets `settings.strict_mode: true`, which
> removes pi's built-in `bash` tool from the active toolset while this
> extension is loaded. **This is intentional and is the whole point of the
> extension.**
>
> Without strict mode, the LLM could trivially bypass every safeguard here by
> just calling `bash` with `ssh user@host '<whatever>'` — every allowlist,
> every regex, every host gate would be meaningless. If you want `ssh_exec`
> to mean anything at all, the bash tool has to go.
>
> If you **don't** want this behaviour (e.g. you're fine with the LLM running
> arbitrary shell commands locally and only want `ssh_exec` as a convenience
> wrapper), set `settings.strict_mode: false` in your `commands.yaml` and
> run `/ssh-reload`. The built-in `bash` tool will be restored.

## What it does

- Registers a new tool `ssh_exec(host, command, timeout_sec?)`.
- Validates `command` against a YAML allowlist **before** anything touches SSH.
- Rejects all shell metacharacters — no pipes, redirects, command
  substitution, heredocs, backgrounding, or newlines.
- Rejects hosts not in the configured list.
- Runs the command with `ssh -T -o BatchMode=yes` (no password prompts, no TTY).
- Enforces per-call timeout and a hard cap on returned output bytes.
- Optional: disables the built-in `bash` tool entirely (`strict_mode: true`).
- Optional: audit log of every attempted command.
- Ships a self-test suite that runs on load and on `/ssh-reload` to catch
  policy-file mistakes (e.g. someone accidentally adding `bash` to the list).

## Install

### From npm (recommended)

Install the extension globally into pi. This works on any machine with `pi`
installed — you do **not** need `npm` or `node` on your PATH, because pi
manages the package fetch and resolution internally.

```bash
pi install npm:@codingcoffee/pi-readonly-ssh
```

Verify:

```bash
pi list                    # should show @codingcoffee/pi-readonly-ssh
pi                         # launch pi; look for "ro-ssh: N cmds, ..." in the footer
```

Inside pi, try `/ssh-allowed` and `/ssh-hosts`.

#### Bun-only machines

`pi install` shells out to `npm` for the fetch. If the target machine has Bun
but no `npm`, point pi at Bun's bundled npm wrapper by adding this to
`~/.pi/agent/settings.json`:

```json
{
  "npmCommand": ["bun", "x", "--bun", "npm"]
}
```

Then run `pi install npm:@codingcoffee/pi-readonly-ssh` as normal.

### From git (no npm required)

Pi clones the repo directly — no `npm` needed on the host:

```bash
pi install git:github.com/codingcoffee/pi-readonly-ssh
# or pinned to a release tag:
pi install git:github.com/codingcoffee/pi-readonly-ssh@v0.1.0
```

### Try without installing (ephemeral, one run only)

```bash
pi -e npm:@codingcoffee/pi-readonly-ssh
# or from git:
pi -e git:github.com/codingcoffee/pi-readonly-ssh
```

### Project-local install

To install into the current project only (writes to `.pi/settings.json`,
shareable via git — pi auto-installs on startup for teammates):

```bash
pi install -l npm:@codingcoffee/pi-readonly-ssh
```

### Uninstall

```bash
pi remove npm:@codingcoffee/pi-readonly-ssh
# or, if installed from git:
pi remove git:github.com/codingcoffee/pi-readonly-ssh
```

### Development (from source)

Clone the repo and run directly:

```bash
git clone https://github.com/codingcoffee/pi-readonly-ssh.git
cd pi-readonly-ssh
bun install
pi -e ./index.ts
```

## Configure

### Where does `commands.yaml` live?

On first run the extension seeds an editable copy at
`$XDG_CONFIG_HOME/pi-readonly-ssh/commands.yaml` (defaults to
`~/.config/pi-readonly-ssh/commands.yaml`). Edit that file — upgrades via
`pi install` will never overwrite it because it lives outside the package.

At load time (and on every `/ssh-reload`) these paths are checked in order;
**the first one that exists wins**:

| # | Path | Purpose |
|---|---|---|
| 1 | `$READONLY_SSH_CONFIG` | Explicit override via env var. Highest priority. |
| 2 | `./.pi/readonly-ssh/commands.yaml` | Project-local (CWD-relative). Check into git to share with your team. |
| 3 | `$XDG_CONFIG_HOME/pi-readonly-ssh/commands.yaml` | Per-user global. Auto-seeded from the bundled default on first run. Falls back to `~/.config/...` if `$XDG_CONFIG_HOME` is unset. |
| 4 | `<installed-package>/commands.yaml` | Bundled default shipped inside the npm tarball. Read-only — treat as a template. |

The active path is printed in the header of `/ssh-allowed` and `/ssh-hosts`
so you can always tell which file is in effect.

### What goes in `commands.yaml`

```yaml
settings:
  strict_mode: false          # true = disable built-in `bash` tool
  max_output_bytes: 1048576
  default_timeout_sec: 30
  allow_globs: true
  allow_any_host: false       # true = let the LLM target any ssh host
  audit_log: ~/.pi/readonly-ssh.log

hosts:
  - name: prod-web-1
    ssh: deploy@prod-web-1.example.com
  - name: staging
    ssh: staging        # an alias from ~/.ssh/config

commands:
  - name: systemctl
    subcommands: [status, is-active, is-enabled, show, list-units, cat]
  # ...
```

After edits: `/ssh-reload` in pi (no restart needed). `/ssh-reload` also
re-runs the priority chain — so if you just created a new project-local
`./.pi/readonly-ssh/commands.yaml`, it will be picked up without restarting.

## Slash commands

| Command | Purpose |
|---|---|
| `/ssh-allowed` | Print the current command allowlist |
| `/ssh-hosts`   | Print the configured hosts |
| `/ssh-reload`  | Re-read `commands.yaml` and re-run self-tests |

## How the guard works (in order)

1. **Raw-string scan.** If the input contains any of `| & ; > < \` $( ${ <( >( ` or a newline, **reject**. This happens on the raw string before any parsing, so quoting tricks don't help.
2. **Heredoc scan.** `<<` or `<<<` → reject.
3. **shell-quote parse.** If the parser produces any non-string token (operators, comments, unquoted globs), reject.
4. **Glob scan.** Unless `allow_globs: true`, reject tokens containing `*`, `?`, `{a,b}`, or a leading `~`.
5. **Allowlist lookup.** `basename(argv[0])` must be in `commands:`. Otherwise reject.
6. **Subcommand check.** If the rule has `subcommands:`, `argv[1]` must match.
7. **Banned flags.** `banned_flags` matched exactly against every `argv[1..]` token (and against `--flag` prefix of `--flag=value`).
8. **Banned arg regex.** `banned_args_regex` matched against every `argv[1..]` token.
9. **`max_args`.** Enforce the cap.
10. **`sudo` special-case.** Strip `sudo` + `-u/-g/...` args, then **recursively** validate the inner command against the same allowlist (depth-limited). `sudo bash` fails because `bash` isn't allowed; `sudo systemctl status nginx` works.
11. **Transport.** Each argv token is single-quoted (`'…'` with `'\''` escaping) before being joined and passed as one string to `ssh <host> -- …`. Even if a token contained what looks like a metacharacter, the remote shell sees it as a literal.

## Threat model

This extension assumes:

- The LLM may try to construct arbitrary commands, including malicious ones.
- The LLM will not discover new hosts it isn't told about (hosts are gated).
- The SSH account on the remote is trusted *only insofar as its own
  permissions go.* If you give the remote account write access, commands that
  are read-only in spirit can still be chained externally. **Give the SSH user
  the least privilege it needs.**
- The `commands.yaml` file itself is trusted (it's edited by the user).

What this extension **does** prevent:

- Pipes, redirects, chaining, backgrounding, heredocs.
- Command substitution and parameter expansion.
- Running a disallowed binary (including `bash`, `sh`, `tee`, `dd`, `scp`,
  `rsync`, `ssh`, `nc`, etc. — simply by not listing them).
- Running a disallowed subcommand of an allowed multi-verb tool (`kubectl
  delete` is rejected even though `kubectl get` is fine).
- Dangerous flags on otherwise-safe tools (`find -delete`, `tail -f`,
  `journalctl -f`, `curl -X POST`, etc.).
- Targeting hosts not in the allowlist (when `allow_any_host: false`).
- Unbounded output size or runtime.
- The LLM passing `@`-prefixed commands.

What this extension does **not** try to prevent:

- Reading secrets that the remote account can read. If the user doesn't want
  the LLM to see `/etc/shadow`, don't give the SSH account sudo access to
  read it and don't add commands that can read it.
- Covert channels via DNS or network probes that are themselves in the
  allowlist (e.g. `dig`, `curl`). Remove those if you care.
- Logic bugs in the remote commands themselves (e.g. a buggy
  `systemctl status` that somehow writes).

## Extending the allowlist

Add a `commands:` entry:

```yaml
- name: mytool
  subcommands: [inspect, report]
  banned_flags: ["--write", "--apply"]
  max_args: 8
```

Then `/ssh-reload`. The self-test suite runs automatically to verify the
universal "must-reject" cases still fail.

## Example session

```
user> Can you check why nginx is unhappy on prod-web-1?

assistant [ssh_exec host=prod-web-1 command="systemctl status nginx"]
... output ...

assistant [ssh_exec host=prod-web-1 command="journalctl -u nginx -n 200"]
... output ...

assistant [ssh_exec host=prod-web-1 command="ls /var/log/nginx"]
... output ...
```

If the assistant tries:

```
ssh_exec host=prod-web-1 command="tail -f /var/log/nginx/error.log | grep 500"
```

…it gets:

```
REJECTED by readonly-ssh guard: pipe '|' is not allowed; ssh_exec does not run shell pipelines
```

and re-plans with discrete calls.
