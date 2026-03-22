#!/bin/bash
set -e

echo "=========================================="
echo "  TeleDrive Installation (No Docker)"
echo "=========================================="

# Check Python version
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is not installed"
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')
echo "Python version: $PYTHON_VERSION"

# Check Node.js version
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    exit 1
fi

NODE_VERSION=$(node -v)
echo "Node.js version: $NODE_VERSION"

# Install backend dependencies
echo ""
echo "[1/2] Installing backend dependencies..."
cd backend
pip install --break-system-packages -r requirements.txt
cd ..

# Install frontend dependencies
echo ""
echo "[2/2] Installing frontend dependencies..."
cd frontend
npm install
cd ..

echo ""
echo "=========================================="
echo "  Installation Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Copy .env.example to .env and configure"
echo "2. Run ./start.sh to start the application"
