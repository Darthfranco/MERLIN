# Optional local process supervision

These **inert examples** keep the existing MERLIN assistant process running on its host. Nothing is installed by cloning the repository or running the hosting inspector. They do not connect the phone demo to the assistant, make the server reachable from an iPad, or provide household authentication. Read [hosting options](../docs/HOSTING.md) before choosing an architecture.

## Inspect without changing anything

From the checkout, run:

```sh
node scripts/hosting-doctor.mjs
```

The dependency-free inspector checks Node's minimum version, executable presence for npm/Git, the installed dependency manifest, configuration/data metadata, and default optional voice directories. It does not read `.env` or household file contents, run discovered programs, contact providers, inspect processes, install packages, or write files. A nonempty inherited key variable is reported only as present. It issues **no ready-for-hosting verdict**; exit code 0 means the report completed, not that all prerequisites or a deployment work. Exit code 1 means invalid arguments or the inspection could not complete. Service environments can differ from your terminal.

## Prepare a local assistant deliberately

Complete the [local prototype setup](../docs/PROTOTYPE.md#run-locally) first, including `npm ci`, a private `.env`, and an ordinary `npm start` test. Use one unprivileged account that owns this checkout and its private data. Stop that manual process before enabling a supervisor. Do not run two processes against the same `data/`, share the directory over a network filesystem, remove a live `server.lock`, or auto-update this checkout while MERLIN is running.

- Use the actual absolute Node executable path from `command -v node`; services do not start your shell's version manager. Update the template if that Node path changes. The repository requires Node 22.16+; keep the selected release supported and patched.
- Replace **every** `/ABSOLUTE/PATH/TO` placeholder in a copy of the chosen template. Never put credentials in a service file. Both templates ask Node to load the checkout's `.env` with the same parsing as `npm start`.
- Runtime state lives at `<checkout>/data/`, regardless of the working directory. There is currently no `DATA_DIR` or `HOST` setting. Review existing file ownership/permissions and keep backups private. Files are not encrypted merely because they are local.
- Prepare an owner-only data directory. The macOS example also requires `local/hosting-logs/` to exist before loading. Example commands, run from your chosen checkout after reviewing the paths:

  ```sh
  mkdir -p data local/hosting-logs
  chmod 700 data local/hosting-logs
  chmod 600 .env
  ```

- The assistant remains at `http://127.0.0.1:3000` and its character surface at `/companion/` on **that same machine**. `PORT` can change the local port; it does not change the host checks. Model requests still need internet access to Meta. A process supervisor does not prevent system sleep or deliver alarms to sleeping/closed browsers.
- Optional voice requires its separate [voice setup](../docs/VOICE.md). The templates install no Python packages, model files, audio devices, or microphone permissions. Default voice paths remain in the checkout's ignored `local/`; any `VOICE_PYTHON` override must exist for the service account. Local speech and physical audio need separate verification.

## macOS LaunchAgent

Copy [the LaunchAgent example](macos/org.merlin.local-assistant.plist.example) to a private working location, replace its paths, then save it as `~/Library/LaunchAgents/org.merlin.local-assistant.plist`. Create `~/Library/LaunchAgents` if necessary. Keep the checkout somewhere this user agent can access; macOS may restrict Desktop/Documents and other protected directories. Preserve valid XML if a path contains `&` or `<`.

Validate before explicitly enabling it:

```sh
plutil -lint "$HOME/Library/LaunchAgents/org.merlin.local-assistant.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/org.merlin.local-assistant.plist"
launchctl print "gui/$(id -u)/org.merlin.local-assistant"
```

This is a **logged-in user agent**, not a boot-time headless daemon. It starts when loaded and at later logins, and restarts after unsuccessful exits. It stops at logout and cannot keep a sleeping Mac awake. A permanent headless Mac mini deployment needs an administrator to choose an appropriate service account, boot daemon, power policy, and backup process; this example does not configure those. These lifecycle differences follow [Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html); use the installed `man launchctl` for current command behavior.

Standard output/error go to the ignored `local/hosting-logs/` files; review access and rotation because those files are not automatically size-limited. Do not publish logs without checking them. To stop and unload the agent:

```sh
launchctl bootout "gui/$(id -u)/org.merlin.local-assistant"
```

Move its plist out of `~/Library/LaunchAgents` if you also want to prevent loading at subsequent login. After updating paths or MERLIN, unload and bootstrap again. Do not run `npm start` alongside it.

## Linux systemd

Copy [the systemd user-unit example](linux/merlin-local-assistant.service.example), replace its paths, and save it as `~/.config/systemd/user/merlin-local-assistant.service` (create that directory if needed). Choose paths without spaces or `%` for this simple template. Use a Linux distribution with systemd user services and run these commands as the checkout's ordinary owner, **without sudo**:

```sh
systemd-analyze --user verify "$HOME/.config/systemd/user/merlin-local-assistant.service"
systemctl --user daemon-reload
systemctl --user enable --now merlin-local-assistant.service
systemctl --user status merlin-local-assistant.service
journalctl --user -u merlin-local-assistant.service -n 30
```

The unit starts when its user manager starts; login/session behavior depends on the host. A server administrator may deliberately enable user lingering for boot/logout persistence, following [loginctl's documentation](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html#enable-linger%20%5BUSER%E2%80%A6%5D). No lingering, boot startup, firewall, public port, or reverse proxy is configured by this repository. VM ownership does not add the missing remote-application features.

Output goes to the system journal. Retention and readers depend on the machine's journal policy; logs are not covered by MERLIN's memory-delete control. The unit's failure restart behavior and environment are defined by [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) and [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html). To stop it and disable future user-manager startup:

```sh
systemctl --user disable --now merlin-local-assistant.service
```

For deliberate updates, stop the service, make a private backup of `.env` and `data/`, update the checkout/dependencies, run appropriate checks, then restart. Restore data only while stopped; two runtimes must never write the same store. These templates have been checked structurally, not installed or tested as running OS services.
