# ADR-001: Reserved uid/gid range for Pebbles users

**Status:** Accepted · **Date:** 2026-08-11 · **Deciders:** implementation (flagged for
owner review in the M0.3 summary)

## Context

Every Pebbles user is a real UNIX account, and uids/gids must be identical on every
registered host (REQ-11): homes and lake files are shared across containers and hosts,
so a uid is effectively a wire-protocol constant. Changing the range after v1 ships
means chowning every home and every lake file on every host. The Incus backend also
needs one contiguous range to identity-map (`raw.idmap`) into unprivileged containers.

## Decision

**Pebbles allocates uids and gids exclusively from 70000–74999** (5000 accounts; the
v1 scale target is 25 concurrent users, NFR-05). Personal primary groups use the same
number as the uid. Allocation is lowest-free-first; engine registration audits the
range and refuses on conflict.

## Why not 60000–64999 (the earlier working proposal)

Debian policy *globally reserves* 60000–64999 for Debian's own static allocations, and
the Pebbles image is Debian — a future package could legitimately claim a uid there and
collide with a user account inside every container. 70000–74999 sits in the space
Debian policy leaves unused. Being above 65535 is not a problem for any supported
component (Linux uids are 32-bit; NFSv4, ext4/xfs, tar, Incus idmaps all handle it);
only legacy 16-bit-uid systems would care, and none are in scope.

## Consequences

- `pebbles-identity` hard-codes `PEBBLES_UID_MIN = 70000`, `PEBBLES_UID_MAX = 74999`.
- Incus hosts delegate the range to root (`root:70000:5000` in `/etc/subuid` and
  `/etc/subgid`) and profiles map `both 70000-74999 70000-74999`.
- `useradd` is always called with an explicit `-u`/`-g` (Debian's default `UID_MAX`
  of 60000 would never allocate here on its own — that's a feature: nothing but
  Pebbles creates accounts in this range).
- Changing this constant later is a data-exposure-grade migration; treat any future
  proposal to move it as a new ADR with a fleet-wide chown plan.
