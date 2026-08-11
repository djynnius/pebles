# Deploying Pebbles

One image, three runtimes. Non-negotiables that apply to every runtime:

- **Engine containers need setuid transitions.** Sessions run as the requesting user's
  uid (REQ-12), so pebblesd must setuid. Default Docker/Podman capabilities suffice
  (SETUID/SETGID/CHOWN/FOWNER/DAC_OVERRIDE/KILL) — never run `--privileged`, and do
  **not** set `no-new-privileges` on engine containers: it silently breaks sessions.
- **Podman must be rootful** (`systemctl enable --now podman.socket`, units under
  `/etc/containers/systemd/`). Rootless remaps uids through subuid ranges, which breaks
  the host-uid identity model (REQ-11); pebblesd detects a rootless socket and refuses.
- **Incus engines run unprivileged** with a 1:1 idmap of the reserved Pebbles uid range
  (60000–64999). Delegate the range to root first:
  `echo "root:60000:5000" >> /etc/subuid && echo "root:60000:5000" >> /etc/subgid`.
  Privileged containers are the fallback where subuid delegation isn't possible.
- The config volume (`/var/lib/pebbles`) holds the role and all state — keep it on
  restarts; upgrading is "pull new image, same volume" (REQ-09).

| Directory | Contents |
|---|---|
| `docker/` | Compose file for a single-box install (main serving engine sessions) |
| `podman/` | Rootful quadlet unit for systemd-managed installs |
| `incus/` | Profile with the idmap + instance launch examples |
