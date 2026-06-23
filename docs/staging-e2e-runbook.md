# Staging E2E Smoke Runbook

This document explains how to run the CareMemory end-to-end scenario suite against a real staging deployment (e.g. Render).

## Overview

The E2E smoke suite is the same `pnpm test:e2e:staging` command used locally. When pointed at a staging API URL it exercises:

- `/health` dependency checks (PostgreSQL + Redis)
- `/dev/test-tool/*` simulation endpoints to drive onboarding, check-ins, and Disease Card generation
- `/api/briefs` and `/api/briefs/:id/pdf` to verify Brief / PDF generation

> **Security warning**: the `/dev/test-tool` endpoints can reset users and manipulate the virtual clock. They must **never** be enabled on the production API service. Only enable them on a dedicated staging environment protected by `TEST_TOOL_API_KEY`.

---

## Required Render configuration

For the **staging API service** (`carememory-api` in `infra/render.yaml`):

| Environment variable | Required value |
|----------------------|----------------|
| `NODE_ENV`           | `production`   |
| `ENABLE_TEST_TOOL`   | `true`         |
| `TEST_TOOL_API_KEY`  | A long random string (e.g. `openssl rand -hex 32`) |
| `APP_BASE_URL`       | The staging API URL, e.g. `https://carememory-api-staging.onrender.com` |
| `API_BASE_URL`       | Same as `APP_BASE_URL` |
| `WEB_BASE_URL`       | The staging Web URL, e.g. `https://carememory-web-staging.onrender.com` |
| `DATABASE_URL`       | From Render PostgreSQL |
| `REDIS_URL`          | From Render Redis |
| `ENCRYPTION_KEY`     | 32-byte random string |
| `JWT_SECRET`         | Random string |

For the **production API service**, keep:

```
ENABLE_TEST_TOOL=false
TEST_TOOL_API_KEY=        # leave empty
```

---

## Required GitHub secrets

In the repository settings, add:

| Secret | Example | Purpose |
|--------|---------|---------|
| `STAGING_API_BASE_URL` | `https://carememory-api-staging.onrender.com` | Target URL for the smoke suite |
| `TEST_TOOL_API_KEY` | `<same random string as Render>` | Authenticates E2E runner to `/dev/test-tool` |
| `RENDER_API_DEPLOY_HOOK_URL` | `https://api.render.com/deploy/...` | Optional: trigger Render re-deploy |
| `RENDER_WEB_DEPLOY_HOOK_URL` | `https://api.render.com/deploy/...` | Optional: trigger Render Web re-deploy |

When these secrets are present, `.github/workflows/deploy.yml` will automatically wait for the staging API to become healthy and then run `pnpm test:e2e:staging` after every successful main-branch build.

---

## Manual run from a developer machine

```bash
# 1. Build the E2E runner
pnpm build

# 2. Run against staging
API_BASE_URL=https://carememory-api-staging.onrender.com \
TEST_TOOL_API_KEY=<your-staging-key> \
  pnpm test:e2e:staging
```

To skip the health wait (e.g. you already verified the service manually):

```bash
API_BASE_URL=https://carememory-api-staging.onrender.com \
TEST_TOOL_API_KEY=<your-staging-key> \
  pnpm test:e2e:staging --no-wait
```

---

## Verifying the deployment without E2E

If you do not have a staging environment with the test tool enabled, you can still verify a deployment with `curl`:

```bash
curl -s https://carememory-api-staging.onrender.com/health | jq .
```

Expected response shape:

```json
{
  "status": "ok",
  "timestamp": "2026-06-15T14:30:00.000Z",
  "version": "dev",
  "checks": {
    "database": "ok",
    "redis": "ok"
  }
}
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `401 Unauthorized` from `/dev/test-tool/*` | `TEST_TOOL_API_KEY` missing or mismatch | Verify the key in Render and in the runner environment |
| `404 Not Found` from `/dev/test-tool/*` | `ENABLE_TEST_TOOL` is not `true` on staging | Set `ENABLE_TEST_TOOL=true` in Render staging env |
| `/health` returns `degraded` | PostgreSQL or Redis unavailable | Check Render service logs |
| E2E times out waiting for `/health` | Deploy has not finished or service crashed | Check Render dashboard and service logs |

---

## Future improvements

- Add a lightweight non-test-tool smoke endpoint that exercises the public API only, so staging health can be validated without enabling the test tool.
- Run a subset of scenarios specifically designed for staging (shorter, no PDF) to reduce CI time.
- Integrate Sentry alerts so a failed staging smoke test pages the on-call engineer.
