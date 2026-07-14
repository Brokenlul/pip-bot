# pip marketing site

Static marketing site for pip ("Your AI Market Analyst"). Plain HTML/CSS/vanilla
JS — no build step, no framework. Implemented from the Claude Design project
`PIP: Your AI Market Analyst` (`PIP Marketing Site v2.dc.html` + `Pricing.dc.html`,
merged into one page with the pricing section wired to the interactive
audience/billing toggle + fake checkout modal from the Pricing design).

All CTAs (`Add to Discord`, `Add to Telegram`, plan buttons) currently point to
`#` — wire them up to the real invite links / checkout flow before launch.

## Run locally

Any static file server works, e.g.:
```
npx http-server . -p 8934
```

## Deploy (from this folder)
```
cd pip-site
npx vercel            # first run links/creates the project
npx vercel --prod     # deploy to production
```
