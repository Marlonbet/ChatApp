#!/usr/bin/env bash
# ChatApp Server — instalación en un VPS nuevo (Ubuntu/Debian).
# Uso: sudo ./deploy.sh [dominio]
#   Sin dominio: sirve por HTTP en la IP (solo para pruebas; el login
#   debería ir siempre por HTTPS en producción).
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="/opt/chatapp"
SERVICE_USER="chatapp"

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta como root: sudo ./deploy.sh [dominio]"
  exit 1
fi

echo "==> Instalando Node.js 22 y Caddy..."
apt-get update -qq
apt-get install -y -qq curl debian-keyring debian-archive-keyring apt-transport-https > /dev/null
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
apt-get update -qq
apt-get install -y -qq nodejs caddy > /dev/null
echo "    node $(node --version)"

echo "==> Creando usuario y carpeta de la app..."
id -u "$SERVICE_USER" &>/dev/null || useradd -r -m -s /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR/data"
cp -r "$(dirname "$0")/package.json" "$(dirname "$0")/server.js" "$(dirname "$0")/public" "$APP_DIR/"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo "==> Instalando dependencias..."
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund > /dev/null 2>&1

echo "==> Servicio systemd..."
cat > /etc/systemd/system/chatapp.service <<EOF
[Unit]
Description=ChatApp Server
After=network.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=PORT=3000
Environment=DATA_DIR=$APP_DIR/data
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now chatapp

echo "==> Configurando Caddy (proxy inverso)..."
if [ -n "$DOMAIN" ]; then
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:3000
}
EOF
  echo "    HTTPS automático para $DOMAIN"
else
  cat > /etc/caddy/Caddyfile <<EOF
:80 {
	reverse_proxy 127.0.0.1:3000
}
EOF
  echo "    ATENCIÓN: sin dominio solo hay HTTP (no apto para producción)."
fi
systemctl reload caddy

echo ""
echo "==> Listo. Comprueba: curl http://127.0.0.1:3000/api/health"
echo "    Datos SQLite en: $APP_DIR/data/chatapp.sqlite"
echo "    Respaldo sugerido: cp $APP_DIR/data/chatapp.sqlite /root/chatapp-\$(date +%F).sqlite"
