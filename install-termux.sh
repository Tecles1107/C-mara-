#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "=== Instalador de VigíaLAN para Termux ==="
echo "[1/4] Actualizando repositorios e instalando paquetes..."
export DEBIAN_FRONTEND=noninteractive
pkg update -y
pkg install -y nodejs ffmpeg nmap termux-api git

echo "[2/4] Configurando almacenamiento interno..."
termux-setup-storage || true
mkdir -p /sdcard/DCIM/VigiaLAN_Clips

echo "[3/4] Instalando dependencias de Node.js..."
npm install --legacy-peer-deps --no-audit --no-fund

echo "[4/4] Instalación completada."
echo ""
echo "Para iniciar VigíaLAN, ejecuta:"
echo "  npm run dev"
echo ""
echo "Luego abre en tu navegador:"
echo "  http://localhost:3000"
