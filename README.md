# BananaBread Arena

BananaBread Arena is an experimental LNbits WASM extension for paid,
server-authoritative multiplayer deathmatch. It uses
[Sour](https://github.com/cfoust/sour), the maintained multiplayer fork of
BananaBread, for the browser client and game server.

Players do not launch a private single-player page:

1. A player enters a name and Lightning address in the public lobby.
2. LNbits creates a 50–100 sat admission invoice.
3. A settled invoice becomes a private gateway ticket.
4. The gateway starts or reuses an isolated five-player Sour room and admits
   the paid player.
5. Sour validates movement, damage, and deaths.
6. A server-confirmed death pays the victim's stake to the killer, minus the
   arena's fee (10% by default).
7. The victim must pay again to respawn.

No browser endpoint can declare a winner or request a reward.

## Status and rules

This is a private-beta design. The defaults are intentionally conservative:

- continuous public free-for-all rooms;
- five paid players per room;
- 50 sat minimum and 100 sat maximum admission;
- no bots in paid rooms;
- rewards require at least two paid live players;
- a disconnected body remains in Sour for 60 seconds;
- a player who survives that grace period is removed and receives a full
  refund;
- server events and failed Lightning settlements are idempotent and retryable.

The arena wallet must have enough additional balance for routing fees. A
Lightning-address payout can remain pending at the wallet backend; pending
payments are never blindly retried because doing so could pay twice.

## Architecture

There are two deployable parts:

- `wasm/module.wasm` runs inside LNbits. It owns invoices, admission state,
  player stakes, kill settlement, refunds, and retries.
- `gateway/` is a Go service placed in front of Sour. It verifies paid tickets,
  starts one loopback-only Sour process per LNbits room, proxies the web client,
  fixes each client to its paid identity and room, and converts authoritative
  Sour `N_DIED` packets into idempotent LNbits events.

The gateway blocks Sour cluster commands and bot-management packets. Its event
journal is persisted before a reward or refund event is delivered to LNbits.
The shared server secret is never sent to a browser.

## Deploy

### 1. Install Sour v0.2.5

Download the archive for the gateway host from the
[Sour v0.2.5 release](https://github.com/cfoust/sour/releases/tag/v0.2.5).
The Linux amd64 archive is:

```text
sour_0.2.5_linux_amd64.tar.gz
sha256: 18efcf8cf73e66ade20eacdb8e6649c29de6722a6141fba094fffae46b3bc836
```

Extract it into a private directory. The directory supplied as
`BANANABREAD_SOUR_ROOT` must contain `assets/.index.source`; its `sour` binary
is supplied as `BANANABREAD_SOUR_BINARY`.

### 2. Build and run the gateway

```bash
cd gateway
go build -o bananabread-gateway .
cp .env.example .env
```

Set every required value in `.env`, then run the binary with those variables
loaded. The shared secret must be the same value configured in the LNbits
extension. Put the gateway behind HTTPS and forward WebSocket upgrades. Only
the gateway listener is public; its per-room Sour ports bind to
`127.0.0.1` and must not be exposed.

The provided `gateway/Dockerfile` builds a Linux amd64 image containing the
gateway and the checksum-verified Sour v0.2.5 release. Persist
`/var/lib/bananabread` as a volume.

### 3. Configure LNbits

Open the extension admin page:

1. Choose the arena wallet.
2. Set the public HTTPS gateway URL.
3. Generate a shared secret and give the exact same secret to the gateway.
4. Keep the default 10% arena fee or set the desired fee.
5. Enable paid arenas and save.
6. Authorize external background payments up to 100 sats.
7. Create an arena and share its public link.

Changing the settings secret affects newly created arenas. Existing arenas
retain the gateway URL and secret with which they were created.

## Gateway environment

| Variable                               | Default              | Purpose                                                |
| -------------------------------------- | -------------------- | ------------------------------------------------------ |
| `BANANABREAD_PUBLIC_URL`               | required             | Public HTTPS origin of the gateway                     |
| `BANANABREAD_LNBITS_URL`               | required             | Public LNbits origin                                   |
| `BANANABREAD_SERVER_SECRET`            | required             | Shared secret, at least 32 characters                  |
| `BANANABREAD_SOUR_BINARY`              | `sour`               | Sour v0.2.5 executable                                 |
| `BANANABREAD_SOUR_ROOT`                | `.`                  | Extracted Sour directory containing `assets/`          |
| `BANANABREAD_DATA_DIR`                 | `./bananabread-data` | Event journal, room configs, logs, and cache           |
| `BANANABREAD_LISTEN_ADDR`              | `127.0.0.1:1340`     | Gateway listen address                                 |
| `BANANABREAD_MAX_ROOMS`                | `16`                 | Maximum isolated Sour processes                        |
| `BANANABREAD_DISCONNECT_GRACE_SECONDS` | `60`                 | Fixed safety policy; values other than 60 are rejected |

`GET /healthz` is available for health checks.

## Build and verify

From `dev/`:

```bash
npm run check
npm test
npm run build
```

From `gateway/`:

```bash
go test ./...
go vet ./...
```

The WASM component is built with the pinned `@bytecodealliance/jco` version in
`dev/package.json`. Gateway dependencies and the Sour protocol dependency are
pinned in `gateway/go.mod`.

## Upstream

- Original BananaBread: <https://github.com/kripken/BananaBread>
- Maintained multiplayer fork: <https://github.com/cfoust/sour>
- Pinned Sour release: `v0.2.5`
- Payment-flow reference: <https://github.com/lnbits/lnq1>

See `UPSTREAM-LICENSES.md` for attribution and license notes.
