#!/bin/bash

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

check_env() {
    if [ ! -f ".env" ]; then
        echo -e "${RED}Error: .env file not found${NC}"
        echo "Please copy .env.example to .env and configure it"
        exit 1
    fi
    
    # Check required variables
    source .env
    
    if [ -z "$TELEGRAM_API_ID" ] || [ "$TELEGRAM_API_ID" = "your_api_id_here" ]; then
        echo -e "${RED}Error: TELEGRAM_API_ID not configured${NC}"
        exit 1
    fi
    
    if [ -z "$TELEGRAM_API_HASH" ] || [ "$TELEGRAM_API_HASH" = "your_api_hash_here" ]; then
        echo -e "${RED}Error: TELEGRAM_API_HASH not configured${NC}"
        exit 1
    fi
    
    if [ -z "$TELEGRAM_SESSION_STRING" ] || [ "$TELEGRAM_SESSION_STRING" = "your_session_string_here" ]; then
        echo -e "${RED}Error: TELEGRAM_SESSION_STRING not configured${NC}"
        exit 1
    fi
}

start_backend() {
    echo -e "${GREEN}Starting backend...${NC}"
    cd backend
    python3 main.py &
    BACKEND_PID=$!
    cd ..
    echo $BACKEND_PID > .backend.pid
    echo "Backend started (PID: $BACKEND_PID)"
    echo "Backend running from: $(pwd)/backend"
}

start_frontend() {
    echo -e "${GREEN}Starting frontend...${NC}"
    cd frontend
    
    # Check if already built
    if [ -d "dist" ]; then
        echo "Using pre-built frontend"
        npm run preview &
    else
        npm run dev &
    fi
    
    FRONTEND_PID=$!
    cd ..
    echo $FRONTEND_PID > .frontend.pid
    echo "Frontend started (PID: $FRONTEND_PID)"
}

cleanup() {
    echo -e "${YELLOW}Stopping services...${NC}"
    
    if [ -f .backend.pid ]; then
        kill $(cat .backend.pid) 2>/dev/null || true
        rm .backend.pid
    fi
    
    if [ -f .frontend.pid ]; then
        kill $(cat .frontend.pid) 2>/dev/null || true
        rm .frontend.pid
    fi
    
    echo "Services stopped"
}

trap cleanup EXIT INT TERM

echo "=========================================="
echo "  TeleDrive Launcher"
echo "=========================================="
echo ""

check_env

echo -e "${GREEN}Starting TeleDrive...${NC}"
echo ""
echo "Backend: http://localhost:8000"
echo "Frontend: http://localhost:3000"
echo ""
echo -e "Press ${YELLOW}Ctrl+C${NC} to stop"
echo ""

start_backend
sleep 2
start_frontend

echo ""
echo -e "${GREEN}TeleDrive is running!${NC}"
echo ""

# Wait for any process to exit
wait
