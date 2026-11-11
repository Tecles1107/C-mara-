#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "=== Instalador de VigíaLAN para Termux ==="
echo "[1/5] Actualizando repositorios y paquetes base de Termux..."
pkg update -y && pkg upgrade -y

echo "[2/5] Instalando las versiones más recientes de Node.js, FFmpeg, Nmap y Termux-API..."
pkg install -y nodejs ffmpeg nmap termux-api git

echo "[3/5] Configurando acceso al almacenamiento interno..."
termux-setup-storage || true
mkdir -p /sdcard/DCIM/VigiaLAN_Clips

echo "[4/5] Instalando y actualizando dependencias de Node.js..."
npm install --no-audit --no-fund
npm update

echo "[5/5] Instalación completada."
echo ""
echo "Para iniciar VigíaLAN en tu red local, ejecuta:"
echo "  npm run dev"
echo ""
echo "Luego abre en tu navegador:"
echo "  http://localhost:3000"
