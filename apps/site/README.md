# Salidium site

This app is the public landing page for Salidium. It explains the product, links to the CLI and documentation, and shares the same brand and theme behavior as the local review UI.

## Requirements

- Node.js `>=22.13.0`
- npm

## Local development

```bash
npm ci
npm run dev
```

The development server uses the Cloudflare-compatible vinext runtime. Site content and metadata live under `app/`; static files live under `public/`.

## Checks

```bash
npm run lint
npm test
```

`npm test` builds the deployable worker and verifies the rendered page. The root GitHub Actions workflow runs both checks on every change.

## Hosting

`.openai/hosting.json` identifies the existing OpenAI Sites project. Hosting, publishing, and access-policy changes are managed separately from this repository workflow.
