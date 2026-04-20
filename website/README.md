# website/

Marketing site for **pi-readonly-ssh**, served at
<https://pi-readonly-ssh.codingcoffee.dev/>.

This directory is **not** shipped with the npm package. The root
`package.json` `files` array only allows `index.ts`, `src/**/*.ts`,
`commands.yaml`, `README.md`, and `LICENSE`, so anything here is
automatically excluded from `npm publish`. `.npmignore` also lists it
as belt-and-suspenders.

## Files

- `index.html`  – single-page landing site (inline CSS, no JS, no build step)
- `robots.txt`  – allow all, points at sitemap
- `sitemap.xml` – single URL
- `nginx.conf`  – tiny static-file server config with sensible cache / security headers
- `Dockerfile`  – `nginx:alpine` image that serves the above

## Local preview

Any static server works:

```bash
cd website
python3 -m http.server 8080
# → http://localhost:8080
```

## Build & run the container

```bash
cd website
docker build -t pi-readonly-ssh-site .
docker run --rm -p 8080:80 pi-readonly-ssh-site
# → http://localhost:8080
```

## Deploy

Point `pi-readonly-ssh.codingcoffee.dev` at whatever runs the container
(Fly, Railway, a VPS behind Caddy/Traefik, etc.). TLS is assumed to be
terminated upstream — the container only speaks plain HTTP on `:80`.
