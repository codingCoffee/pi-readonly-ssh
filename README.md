# readonly-ssh

A [pi](https://github.com/mariozechner/pi) extension that exposes an `ssh_exec`
tool to the LLM for running **allow-listed, read-only** commands on remote
hosts over SSH.

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

This extension lives at `.pi/extensions/readonly-ssh/` (project-local
auto-discovery). Install its dependencies:

```bash
cd .pi/extensions/readonly-ssh
npm install
```

Start pi from the project root and the extension loads automatically.

## Configure

Edit `commands.yaml` next to this README:

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

After edits: `/ssh-reload` in pi (no restart needed).

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
