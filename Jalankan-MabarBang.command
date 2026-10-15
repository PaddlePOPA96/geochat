#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "============================================================"
echo "  MABAR BANG - kikobooo x arvana prod"
echo "  Port: 5050 | Local Server (macOS)"
echo "============================================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js belum terinstall di Mac ini!"
    echo "Silakan install Node.js dari: https://nodejs.org"
    echo ""
    read -p "Tekan [Enter] untuk keluar..."
    exit 1
fi

if [ -f "$DIR/server.cjs" ]; then
    node "$DIR/server.cjs"
elif [ -f "$DIR/dist/server-bundle.cjs" ]; then
    node "$DIR/dist/server-bundle.cjs"
else
    npm run server
fi
