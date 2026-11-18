#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "=== Instalador de VigíaLAN para Termux (Android) ==="
echo "[1/5] Actualizando repositorios e instalando paquetes..."
export DEBIAN_FRONTEND=noninteractive
pkg update -y
pkg install -y nodejs ffmpeg nmap termux-api git
pkg install -y cloudflared || true

echo "[2/5] Configurando almacenamiento interno y datos..."
termux-setup-storage || true
mkdir -p /sdcard/DCIM/VigiaLAN_Clips ./data

echo "[3/5] Instalando dependencias de Node.js..."
npm install --legacy-peer-deps --no-audit --no-fund

echo "[4/5] Compilando interfaz web para modo producción ligero..."
npm run build

echo "[5/5] Creando script de inicio rápido (start-vigialan.sh)..."
cat << 'EOF' > ./start-vigialan.sh
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock || true
export NODE_ENV=production
export PORT=${PORT:-3000}
echo "Iniciando VigíaLAN en http://0.0.0.0:$PORT ..."
npx tsx server.ts
EOF
chmod +x ./start-vigialan.sh

echo ""
echo "Instalación completada."
echo ""
echo "Métodos de ejecución:"
echo "  1) Modo producción (recomendado en Termux): ./start-vigialan.sh"
echo "  2) Modo desarrollo:                         npm run dev"
echo ""
echo "Acceso remoto desde datos móviles o Wi-Fi externo:"
echo "  - Con Cloudflare Tunnel: cloudflared tunnel --url http://localhost:3000"
echo "  - Con Tailscale VPN:     accede a http://<IP-Tailscale>:3000"
echo ""
echo "Abre en tu navegador local: http://localhost:3000"
