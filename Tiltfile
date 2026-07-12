# krispyai (public core) — Tilt entrypoint.  Boot with:  ./tilt_up.sh
# (never `tilt up` directly — the script pins Tilt UI port 10440 so multiple
# projects coexist).
#
# Real logic lives in .devops/Tiltfile. Served roles get stable named URLs via
# Vercel Portless: <service>.krispy.localhost:1355 — no pinned service ports.

load_dynamic('.devops/Tiltfile')

# =============================================================================
# Dashboard "title" — Tilt has no native project-title setting, so a banner
# resource in its own CAPITALIZED label group (capitals sort before lowercase)
# headlines the sidebar with the project name. Cosmetic, zero-cost.
# =============================================================================
local_resource(
    'KRISPY-CORE',
    cmd='echo "🥐 KrispyAI (public core) — dev dashboard · ./tilt_up.sh · UI :10440"',
    labels=['KRISPY-CORE'],
)
