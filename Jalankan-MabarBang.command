#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "==============================================="
echo "🎮 Menjalankan MabarBang Standalone Server..."
echo "==============================================="

# Berikan izin executable jika belum
chmod +x ./bin/MabarBang-macos 2>/dev/null

# Jalankan server binary MabarBang
./bin/MabarBang-macos
