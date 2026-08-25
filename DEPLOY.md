# Deploying the review UI

One container, one instance. `JOBS` lives in process memory and every artifact
lives on the mounted volume, so **a second replica would hold half the state**
and the UI would 404 at random. Scale the box up, never out, until the job
store moves somewhere shared.

## Sizing, and why

| | | why |
|---|---|---|
| RAM | **32 GB** | a heavy sheet peaks at multiple GB and 4 detection workers run at once. `TAKEOFF_WORKERS` is the dial if you want less. |
| vCPU | 8 | one core per worker plus the web process |
| disk | 160 GB | the job cache was already 1.3 GB after a handful of documents, and it is what makes a demo instant instead of 90 s a sheet |

Hetzner CCX-class is the value pick. Anything with a real disk and real memory
works; a small PaaS instance with an ephemeral filesystem does not — losing
`/data/jobs` means every demo is cold again.

## First run

```bash
git clone https://github.com/AtlasSolutions100/takeoff-detection-engine.git
cd takeoff-detection-engine
cp .env.example .env      # fill in TAKEOFF_UI_PASSWORD and SITE_HOST
docker compose up -d
```

Point `SITE_HOST`'s DNS A record at the box first — Caddy gets a certificate on
boot and needs the name to resolve.

The container **refuses to start** without `TAKEOFF_UI_PASSWORD`, or with one
under 8 characters. That is deliberate: this box holds clients' live bid
documents, and a missing password has to be a refusal, not a log line.

## Updates

- **push to `main`** → builds, publishes `:latest`, deploys to **staging**
- **push a `v*` tag** → publishes `:vN.N.N`, deploys to **production**

Continuous deploys go to staging only because a deploy restarts the single
container and anyone demoing at that moment loses their session. The box a
client sees moves when you tag it — which you do when nobody is in a meeting.

```bash
git tag v1.0.0 && git push origin v1.0.0    # production
```

GitHub repo secrets required: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`,
`DEPLOY_DIR`. The image is published to GHCR with the built-in `GITHUB_TOKEN`.

## What hosted mode changes

`TAKEOFF_HOSTED=1` is set in the image. It refuses client-supplied filesystem
paths — those would be an arbitrary file read on a public box — and empties
`/api/samples`. **Uploading is therefore the only way in**, which is why the
whole window is a drop target.

Uploads are content-addressed: the same plan set uploaded twice resolves to the
same path, so the second upload returns the same job with its detections
already cached, and the reviewer's saved labels and prices come back with it.

## Getting the demo plans onto a new box

Upload them once through the browser and they persist on the volume. Then open
each sheet you plan to show and let it detect, so the demo is instant.

That is a pre-warmed cache, and the honest way to use it is to say so and press
**Reset this document** live — it clears the server's cached detections for that
PDF and re-detects from scratch in front of the room. That turns the one thing
that could look staged into the most convincing thing in the demo.

## If it will not start

`docker compose logs app` — the entrypoint prints exactly which guard it hit.
The health check treats **401 as healthy**: the site password being on is the
correct state, not a failure.
