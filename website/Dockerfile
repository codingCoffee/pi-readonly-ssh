# syntax=docker/dockerfile:1
# Minimal static-site container for pi-readonly-ssh.codingcoffee.dev
FROM nginx:1.29.8-alpine3.23

# Drop the default nginx site and swap in our tiny config.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static assets.
COPY index.html   /usr/share/nginx/html/index.html
COPY robots.txt   /usr/share/nginx/html/robots.txt
COPY sitemap.xml  /usr/share/nginx/html/sitemap.xml

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
