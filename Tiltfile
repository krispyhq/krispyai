# krispyai — Tilt entrypoint.  Boot with:  ./tilt_up.sh   (never `tilt up`
# directly — the script pins Tilt UI port 10440 so multiple projects coexist).
#
# Real logic lives in .devops/Tiltfile. Served roles get stable named URLs via
# Vercel Portless: <service>.krispy.localhost:1355 — no pinned service ports.
# See docs/portless.md.

load_dynamic('.devops/Tiltfile')
