# WorkLens website

Live site: https://worklens.buildwithais.com/

The Chinese homepage is plain HTML and CSS with local images. A fixed Worker
serves files from the **private worklens-site R2 bucket**. CI/CD updates static
content using S3 credentials scoped to that bucket only.

## CI/CD

`.github/workflows/website.yml` runs tests, validates assets, and performs a
Wrangler dry run on PRs. PR jobs receive no deployment credentials.
After a website change merges to `main`, the deploy job:

1. Uploads files under `releases/<full-commit-sha>/`.
2. Reads each object back and verifies its bytes. Partial uploads can resume;
   conflicting content at an existing revision fails without overwriting it.
3. Writes `current.json` only after all files pass verification.
4. Verifies the live domain's exact content, release header, security headers and 404.

Manual `workflow_dispatch` is available on `main` once merged. Production jobs
are serialized and do not cancel active uploads. Desktop dependencies are not
installed in CI.

GitHub Actions Secrets contain only these S3 credentials:

- `WORKLENS_R2_ACCESS_KEY_ID`
- `WORKLENS_R2_SECRET_ACCESS_KEY`

Token: `worklens-site-github-actions`. Permission: **Object Read & Write**, applied
to **only worklens-site**. Cloudflare resource policy:
`com.cloudflare.edge.r2.bucket.60e88110eacab548b2028b6f76e2b97f_default_worklens-site`.
Do not substitute an account-wide token. CI has no `CLOUDFLARE_API_TOKEN`.
Rotate the two S3 secrets together.

Anyone able to run privileged repository workflows may use these credentials to
read, replace, or delete this site's objects. The Cloudflare bucket policy,
not the hard-coded bucket name in the workflow, protects other resources.

## Owner-only infrastructure

Worker code, binding, fixed security headers and the domain are maintained by
the owner using local Wrangler authentication:

```sh
npx wrangler@4.127.1 deploy --config website/wrangler.jsonc --dry-run
npx wrangler@4.127.1 deploy --config website/wrangler.jsonc
```

CI never runs the second command. Changing `worker.mjs` in Git alone does not
update live serving code. The Worker accepts GET/HEAD only and exposes neither
internal manifests nor directory listings. The bucket is private with no public
R2 endpoint. Cache revalidation prevents stale content without a zone-wide
cache-purge credential. R2 operations and Worker requests use their respective
Cloudflare quotas.

Prior releases remain for rollback; CI does not delete them. The owner may clean
up old releases separately, preserving the active release.

## Local checks and manual content deployment

```sh
node --test website/worker.test.mjs
python -m unittest discover -s website -p '*_test.py'
python website/deploy.py --check
python -m pip install -r website/requirements.txt
```

Supply `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `SITE_REVISION` securely
in the environment, then run `python website/deploy.py` and
`python website/verify.py`. Use a full commit SHA and its matching checkout.
Redeploy an older checkout to roll back; never reuse a revision for different
bytes. Do not put credentials in files or shell history.

For UI preview, serve `website/public/` with a local static server. A local Worker
needs a release seeded in local R2; it does not read the remote bucket by default.

## Content and screenshots

Product claims follow the repository and app. No public installer is advertised;
memory and one-click enterprise integrations remain future work.
`public/assets/icon.png` comes from `build/icon.png`. To refresh the real desktop
screenshot, run `npm run build` then `node website/capture-app.mjs`, which uses a
fresh temporary `WORKLENS_TEST_ROOT` without real user sessions.

Check 375px and 1280px layouts, links, keyboard focus and FAQ after UI changes.
The `review/` screenshots are review evidence and are never uploaded.
