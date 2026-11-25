#!/usr/bin/env bash
set -euo pipefail

# Bro Radius - Zero-Config HTTPS (Let's Encrypt via Caddy)
# Usage:
#   sudo bash scripts/enable-https.sh                  # Auto-uses <PUBLIC_IP>.sslip.io
#   sudo bash scripts/enable-https.sh panel.mydomain.com

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/enable-https.sh [domain]"
  exit 1
fi

PUBLIC_IP="$(curl -4 -s --max-time 5 ifconfig.me || true)"
DOMAIN="${1:-}"

if [[ -z "$DOMAIN" ]]; then
  if [[ -z "$PUBLIC_IP" ]]; then
    read -rp "Enter domain name (e.g., radius.example.com) or VPS Public IP: " INPUT_HOST
    if [[ "$INPUT_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      DOMAIN="${INPUT_HOST//./-}.sslip.io"
    else
      DOMAIN="$INPUT_HOST"
    fi
  else
    DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  fi
fi

echo "==> Installing Caddy web server with automatic Let's Encrypt HTTPS for ${DOMAIN}..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

cat >/etc/caddy/Caddyfile <<EOF
${DOMAIN} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
EOF

echo "==> Opening ports 80/tcp & 443/tcp in iptables / UFW..."
iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
fi
netfilter-persistent save >/dev/null 2>&1 || true

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${APP_DIR}/.env" ]]; then
  sed -i "s|^APP_URL=.*|APP_URL=https://${DOMAIN}|" "${APP_DIR}/.env" || true
  systemctl restart bro-radius || true
fi

systemctl enable caddy
systemctl restart caddy

echo ""
echo "=========================================================="
echo "HTTPS Ready! Open: https://${DOMAIN}"
echo "IMPORTANT: Open TCP ports 80 and 443 in Oracle Cloud VCN -> Security List."
echo "=========================================================="
