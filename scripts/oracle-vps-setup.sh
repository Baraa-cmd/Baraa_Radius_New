#!/usr/bin/env bash
set -euo pipefail

# Bro Radius - Oracle Cloud (Ubuntu/Debian) VPS Setup Script
# Installs Node.js 22+, WireGuard (wg0 on 10.77.0.1/16), opens Oracle iptables,
# builds the app, and registers a systemd service on port 3000.

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/oracle-vps-setup.sh"
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_IP="${WG_SERVER_ENDPOINT:-$(curl -4 -s --max-time 5 ifconfig.me || true)}"

if [[ -z "$PUBLIC_IP" ]]; then
  read -rp "Enter your Oracle VPS Public IP: " PUBLIC_IP
fi

echo "==> Installing WireGuard & Node.js 22 LTS..."
export DEBIAN_FRONTEND=noninteractive
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections || true
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections || true
apt-get update -y
apt-get install -y wireguard wireguard-tools curl iptables-persistent

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Configuring WireGuard interface wg0 (10.77.0.1/16, UDP 51820)..."
mkdir -p /etc/wireguard
chmod 700 /etc/wireguard
if [[ ! -f /etc/wireguard/privatekey ]]; then
  wg genkey | tee /etc/wireguard/privatekey | wg pubkey > /etc/wireguard/publickey
  chmod 600 /etc/wireguard/privatekey
fi
WG_PRIV_KEY="$(cat /etc/wireguard/privatekey)"

if [[ ! -f /etc/wireguard/wg0.conf ]]; then
  cat >/etc/wireguard/wg0.conf <<EOF
[Interface]
Address = 10.77.0.1/16
ListenPort = 51820
PrivateKey = ${WG_PRIV_KEY}
SaveConfig = false
EOF
  chmod 600 /etc/wireguard/wg0.conf
fi

sysctl -w net.ipv4.ip_forward=1 >/dev/null
grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf

systemctl enable wg-quick@wg0
systemctl restart wg-quick@wg0

echo "==> Opening Oracle Ubuntu iptables for WireGuard (51820/udp) & HTTP (3000/tcp)..."
iptables -C INPUT -p udp --dport 51820 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p udp --dport 51820 -j ACCEPT
iptables -C INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 3000 -j ACCEPT
iptables -C INPUT -i wg0 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i wg0 -j ACCEPT
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 51820/udp >/dev/null || true
  ufw allow 3000/tcp >/dev/null || true
fi
netfilter-persistent save >/dev/null 2>&1 || true

echo "==> Writing .env and building Bro Radius..."
cd "$APP_DIR"
SECRET_HEX="$(openssl rand -hex 32)"
cat >.env <<EOF
NODE_ENV=production
PORT=3000
APP_URL=http://${PUBLIC_IP}:3000
WG_SERVER_ENDPOINT=${PUBLIC_IP}
WG_SERVER_PORT=51820
SESSION_SECRET=${SECRET_HEX}
EOF

npm install --legacy-peer-deps --include=dev
npm install -g tsx >/dev/null 2>&1 || true
npm run build

echo "==> Creating systemd service (bro-radius)..."
TSX_BIN="$(command -v tsx || echo "${APP_DIR}/node_modules/.bin/tsx")"
if [[ ! -x "$TSX_BIN" ]]; then
  TSX_BIN="$(command -v node) ${APP_DIR}/node_modules/tsx/dist/cli.mjs"
fi

cat >/etc/systemd/system/bro-radius.service <<EOF
[Unit]
Description=Bro Radius MikroTik Management Server
After=network.target wg-quick@wg0.service

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${TSX_BIN} server.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now bro-radius

echo ""
echo "=========================================================="
echo "Bro Radius is running on: http://${PUBLIC_IP}:3000"
echo "WireGuard Endpoint: ${PUBLIC_IP}:51820"
echo "IMPORTANT: In Oracle Cloud Console -> VCN -> Security List,"
echo "add Ingress Rules for:"
echo "  1) UDP port 51820 (0.0.0.0/0)"
echo "  2) TCP port 3000 (or 80/443 if using Nginx/Caddy)"
echo "=========================================================="
