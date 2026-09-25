# Local audio call smoke, 2026-09-25

This records a local verification of the optional LiveKit call path. No cloud
deployment or persistent LiveKit resource was changed.

## Environment

- macOS arm64; `livekit-server` 1.13.7 and `lk` 2.18.8 installed locally with Homebrew.
- `livekit-server --dev` bound `127.0.0.1:7880` with its documented development key.
- A 20-second 440 Hz Opus `.ogg` fixture was generated in `/private/tmp` with `ffmpeg`.

## Observed results

1. `lk room join --dev --url ws://127.0.0.1:7880 --identity call-smoke-publisher --publish /private/tmp/krispy-call-smoke.ogg --exit-after-publish krispy-local-smoke` connected and published one `MICROPHONE` audio track. `lk room participants list --dev --url http://127.0.0.1:7880 krispy-local-smoke` showed one active publisher with one track.
2. A second `lk room join --dev --url ws://127.0.0.1:7880 --identity call-smoke-subscriber --auto-subscribe krispy-local-smoke` connected and logged `track subscribed`, `kind: audio`, to the publisher's track.
3. `closeCallRoom()` from `services/edge/src/call-token.ts` sent its signed `DeleteRoom` request to the real local server. The subscriber logged `server initiated leave` with reason `ROOM_DELETED` and exited.
4. A token minted by `issueCallToken()` opened a real `/rtc` WebSocket on the local server and received a binary signaling frame. This verifies that LiveKit accepted the participant JWT format.
5. `closeCallRoom()` returned success for LiveKit's structured `not_found` response to a room that had never been joined.

The local server and both CLI processes were stopped afterward; port 7880 refused
connections. HTTP Worker→Durable Object tests cover auth, consent, stale calls,
deadline alarms, and cleanup retries. `bun run check` passed after these changes.

## Production feasibility, read-only audit

The `hetzner-master` K3s context had four Ready nodes and one NotReady node;
each reported 20 allocatable CPU and about 64 GiB memory. The Ready nodes showed
0–9% CPU and 14–28% memory in `kubectl top nodes`. Existing LoadBalancer and
NodePort services exposed TCP 80/443; no UDP service was found. Capacity appears
adequate for a small pilot, but that is an inference from a snapshot, not a load
test. A deployment needs a public IP and firewall/UDP plan. [LiveKit's Kubernetes
guide](https://docs.livekit.io/transport/self-hosting/kubernetes/) requires host
networking, limiting placement to one LiveKit pod per node. Its [port
guide](https://docs.livekit.io/transport/self-hosting/ports-firewall/) lists
signaling behind TLS, ICE UDP or UDP mux, ICE TCP, and optional TURN ports. No
cluster change was made.

Browser microphone behavior and iOS/native audio remain unverified locally.
