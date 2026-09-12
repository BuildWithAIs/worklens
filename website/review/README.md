# Deployment verification

The initial Static Assets deployment is recorded below. The later migration to
private R2 and bucket-scoped CI/CD is documented in `../README.md` and PR #7.

Verified on 2026-09-10 **before creating the feature branch, commit, or PR**.

- Site: https://worklens.buildwithais.com/
- Cloudflare Worker: `worklens-site`, static assets only.
- Deployment version: `19c43cf0-e372-4182-8f92-d7c16b3c04c7`.
- Real browser checks at 1280 × 900 and 375 × 812: page and images load,
  no horizontal overflow, source-start anchor reaches the installation section,
  FAQ opens by click and keyboard, no console warnings/errors.
- Live HTTP checks: home, both images, robots and sitemap return 200;
  `/missing-page-check` returns the custom 404 with HTTP 404.
- CSP, `nosniff`, and frame protection are present on the live response.
- Repository, installation instructions, issue tracker, and license links resolve.
- `npm run build`, `npm run typecheck`, Wrangler deployment dry run passed.
- Existing desktop test `npx playwright test tests/e2e/desktop.spec.ts` fails at
  `tests/e2e/desktop.spec.ts:51` because the current UI no longer contains
  `Pi 内置 · WorkLens 尚未实测`. The assertion targets unchanged desktop code;
  this PR changes no desktop runtime files. The isolated screenshot capture
  script separately launched and captured the current desktop build successfully.
- No paid model account, macOS build, or installer was tested for this change.

The two PNGs are full-page captures of the deployed website, not design mockups.
They stay outside `public/` and are not uploaded to the static site.
