# Shepherds Pi Publisher Setup (npm + GHCR + GitHub Actions)

This is the maintainer checklist for publishing:

1. the **CLI package** to npm
2. the **agent image** to GitHub Container Registry (GHCR)

---

## Publish targets (recommended)

- **npm package:** `shepherds-pi` (current) or `@counterpointconsulting/shepherds-pi` (scoped)
- **container image:** `ghcr.io/counterpointconsulting/shepherds-pi-agent`

> Note: current repo templates already point to `ghcr.io/counterpointconsulting/shepherds-pi-agent:latest`.

---

## 1) One-time account + credential setup

## 1.1 npm setup (publisher)

1. Create/sign in to npm account: https://www.npmjs.com/
2. Verify your npm email.
3. Login locally (for manual publishing):
   ```bash
   npm login
   npm whoami
   ```
4. Decide package naming:
   - Keep current unscoped name: `shepherds-pi`
   - Or switch to scoped name: `@counterpointconsulting/shepherds-pi`
5. Create an npm token for CI:
   - npm web UI → Access Tokens → **Generate New Token**
   - Token type: **Automation** (recommended for GitHub Actions)
   - Save it immediately (shown once)

If switching to scoped package name, update `package.json`:
```json
{
  "name": "@counterpointconsulting/shepherds-pi"
}
```

---

## 1.2 GHCR setup (publisher)

No separate GHCR account is needed (it uses GitHub identity).

You need:
- GitHub org/repo access (`CounterpointConsulting/shepherds-pi`)
- For local/manual image push: GitHub PAT (recommended classic token) with:
  - `write:packages`
  - `read:packages`
  - optionally `delete:packages`

Local login for manual image publish:
```bash
echo <YOUR_GITHUB_PAT> | docker login ghcr.io -u <github-username> --password-stdin
```

---

## 2) GitHub repository settings (once)

In `CounterpointConsulting/shepherds-pi`:

1. **Add Actions secret**
   - Settings → Secrets and variables → Actions → New repository secret
   - Name: `NPM_TOKEN`
   - Value: npm automation token from step 1.1

2. **Actions permissions**
   - Settings → Actions → General
   - Ensure workflows are allowed to run.
   - Keep default token permissions compatible with workflow-level permissions.

3. **Package visibility (GHCR image)**
   - After first image push, open package page in GitHub Packages.
   - Ensure image is **Public** if end users should pull without auth.

---

## 3) Minimal GitHub Actions release workflow

Create `.github/workflows/release.yml`:

```yaml
name: release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: read
  packages: write

jobs:
  publish:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: 'https://registry.npmjs.org'

      - name: Install deps
        run: npm ci

      - name: Build
        run: npm run build

      - name: Publish npm
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/counterpointconsulting/shepherds-pi-agent
          tags: |
            type=ref,event=tag
            type=raw,value=latest

      - name: Build and push image
        uses: docker/build-push-action@v6
        with:
          context: ./docker
          file: ./docker/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

---

## 4) First publish (manual smoke path)

Use this once to validate everything before trusting CI:

```bash
npm run typecheck
npm run build
npm run pack:dry-run
```

### 4.1 Publish npm manually

```bash
npm whoami
npm publish --access public
```

### 4.2 Publish GHCR image manually

```bash
docker build -t ghcr.io/counterpointconsulting/shepherds-pi-agent:v0.1.0 -f docker/Dockerfile docker
docker push ghcr.io/counterpointconsulting/shepherds-pi-agent:v0.1.0
docker tag ghcr.io/counterpointconsulting/shepherds-pi-agent:v0.1.0 ghcr.io/counterpointconsulting/shepherds-pi-agent:latest
docker push ghcr.io/counterpointconsulting/shepherds-pi-agent:latest
```

Then verify image visibility is Public in GitHub Packages.

---

## 5) Normal release flow (recommended)

1. Ensure `package.json` version is correct.
2. Create git tag that matches version (`vX.Y.Z`):
   ```bash
   npm version patch   # or minor/major
   git push --follow-tags
   ```
3. GitHub Actions publishes npm + GHCR automatically.

---

## 6) End-user authentication expectations

End users generally do **not** need registry credentials to install/pull public artifacts.

They still need runtime credentials for Shepherds Pi usage:
- `OPENROUTER_API_KEY`
- `GIT_TOKEN` (only for clone/container git modes)

---

## 7) Troubleshooting

- **npm publish 403**
  - Check package name ownership and npm token validity/expiry.
- **GHCR push denied**
  - Confirm workflow has `packages: write` permission.
- **Users cannot pull image**
  - Ensure GHCR package visibility is Public.
- **Tag push did not release**
  - Ensure tag pattern matches `v*` and workflow is on default branch.

---

## 8) Security hygiene

- Rotate `NPM_TOKEN` periodically and update GitHub secret.
- Prefer CI publish over local manual publish.
- Keep PAT scopes minimal (`read/write:packages` for GHCR local push).
- Never commit tokens to repo or `.env.example`.
