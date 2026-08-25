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

## Provisioning a box, start to finish

Order matters in exactly one place: **the DNS record must resolve before the
first `docker compose up`**, because Caddy requests the certificate on boot and
a failed request backs off before it retries.

**1. The server.** Hetzner Cloud, Add Server, CCX33 (8 dedicated vCPU, 32 GB,
240 GB disk), Ubuntu 24.04, and add your SSH key in the create dialog so root
login is by key from the start. Note the IPv4 address.

**2. DNS.** At the registrar, an `A` record for the name you want, pointing at
that IPv4. Verify it from your own machine before going further, because
everything after this depends on it:

```bash
dig +short core.workoptional.studio
```

**3. Base setup**, as root on the box:

```bash
apt update && apt upgrade -y && curl -fsSL https://get.docker.com | sh
```

```bash
adduser --disabled-password --gecos "" deploy && usermod -aG docker deploy
```

**4. A deploy key**, generated on your machine so the private half never
travels:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/takeoff_deploy -N "" -C github-actions
```

```bash
ssh-copy-id -i ~/.ssh/takeoff_deploy.pub deploy@core.workoptional.studio
```

**5. Firewall.** Hetzner Cloud firewall (or `ufw`): inbound **22, 80, 443**
only. 80 is not optional, Caddy uses it for the certificate challenge and for
the redirect to 443.

**6. Let the box pull the image.** The repo is private, so the GHCR package is
private too and an unauthenticated `docker compose pull` fails with `denied`.
Create a classic PAT with **`read:packages`**, then as `deploy`:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

That writes `~/.docker/config.json` and persists, so CI never logs in itself.

**7. First boot**, as `deploy`:

```bash
git clone https://github.com/AtlasSolutions100/takeoff-detection-engine.git
```

```bash
cd takeoff-detection-engine && cp .env.example .env
```

Fill in `TAKEOFF_UI_PASSWORD` and `SITE_HOST`, then:

```bash
docker compose up -d && docker compose logs -f caddy
```

**8. GitHub repo secrets**, so CI can deploy: `DEPLOY_HOST` (the hostname),
`DEPLOY_USER` (`deploy`), `DEPLOY_SSH_KEY` (the **private** key from step 4,
the whole file including its BEGIN and END lines), `DEPLOY_DIR`
(`/home/deploy/takeoff-detection-engine`).

**9. Seed the demo plans**, from your own machine, which is where the corpus
lives: `./seed-demo.sh https://core.workoptional.studio`.

## The password guard

The container **refuses to start** without `TAKEOFF_UI_PASSWORD`, or with one
under 8 characters. That is deliberate: this box holds clients' live bid
documents, and a missing password has to be a refusal, not a log line.
Verified on the built image, both cases exit 1 and name the reason.

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

`./seed-demo.sh https://core.workoptional.studio`, run from a machine that has
the plan corpus. It uploads from there to the box, detects the pages worth
showing, and prints how long each took. Safe to re-run: uploads are
content-addressed and a page with a fresh result reports `done` without
recomputing. Klayton's fiber set is deliberately excluded, he is under NDA.

**Re-seed after any deploy that changed `takeoff_engine/`.** A stored result
records the engine signature that produced it, and `_result_stale` in
`server.py` refuses to serve one whose signature has moved. That is correct
behaviour, because a number the current engine would not produce is how a wrong
figure reaches a bid, but it means the volume surviving a deploy keeps the
files without keeping them valid. A UI-only or `server.py`-only deploy needs no
re-seed.

That is a pre-warmed cache, and the honest way to use it is to say so and press
**Reset this document** live — it clears the server's cached detections for that
PDF and re-detects from scratch in front of the room. That turns the one thing
that could look staged into the most convincing thing in the demo.

## If it will not start

`docker compose logs app` — the entrypoint prints exactly which guard it hit.
The health check treats **401 as healthy**: the site password being on is the
correct state, not a failure.
