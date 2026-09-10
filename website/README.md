# WorkLens website

Live site: https://worklens.buildwithais.com/

A standalone Chinese landing page using plain HTML and CSS. No build step,
client-side JavaScript, external fonts, analytics, or runtime server is required.
Only `public/` is uploaded; desktop app files are not included.

## Preview and deploy

From the repository root, with Node.js 24 and npm:

```sh
npx wrangler@4.127.1 dev --config website/wrangler.jsonc
npx wrangler@4.127.1 deploy --config website/wrangler.jsonc --dry-run
npx wrangler@4.127.1 deploy --config website/wrangler.jsonc
```

Deployment uses Cloudflare Workers Static Assets without a Worker script.
Wrangler must be authenticated to the account in `wrangler.jsonc` and have
permission to deploy Workers and bind custom domains in `buildwithais.com`.
Cloudflare provisions the subdomain and TLS certificate through the custom domain
route. No credentials belong in this repository. Deployment is manual; merging
the PR does not trigger another deployment.

## Content and verification

- Product claims follow the repository README and actual app capabilities.
- There are no public installers yet: primary links lead to source instructions.
- Memory and enterprise integrations are described as future direction.
- `assets/icon.png` comes from `build/icon.png`.
- `assets/worklens.png` is the actual desktop app captured with isolated test data,
  not a mockup or a real user's session.
- To refresh the screenshot, run `npm run build` then
  `node website/capture-app.mjs` from the repository root. It uses a fresh
  temporary `WORKLENS_TEST_ROOT`, no configured model account, and sends no task.
- Verify at 375px and 1280px: no horizontal overflow, readable text, working
  anchors, screenshot link, FAQ toggles, keyboard focus, and external links.
- After deployment, verify HTTPS, the screenshot, metadata, security headers,
  robots/sitemap, and a genuine HTTP 404 for an unknown path.

The page adapts Kami's landing-page typography, warm neutral palette, section
rhythm, and responsive layout to a smaller product introduction.
