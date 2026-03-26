#!/usr/bin/env python3
"""
Generate Telegram Session String

This script helps generate a session string for MTProto authentication.
Run this once to get your session string, then use it in the frontend or .env

Usage:
    python generate_session.py
"""

import os
import sys
from pathlib import Path

def load_env():
    """Load environment variables from .env file"""
    env_path = Path(__file__).parent / '.env'
    env_vars = {}
    
    if env_path.exists():
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    env_vars[key.strip()] = value.strip()
    
    return env_vars, env_path

def write_env(env_path, env_vars):
    """Write environment variables to .env file"""
    with open(env_path, 'w', encoding='utf-8') as f:
        for key, value in env_vars.items():
            f.write(f"{key}={value}\n")

def main():
    print("=" * 50)
    print("  Telegram Session String Generator")
    print("=" * 50)
    print()
    
    # Load API credentials from .env
    env_vars, env_path = load_env()
    
    api_id = env_vars.get('TELEGRAM_API_ID', '').strip()
    api_hash = env_vars.get('TELEGRAM_API_HASH', '').strip()
    
    # Get API credentials - from .env or interactive input
    print("Enter your Telegram API credentials from https://my.telegram.org")
    print()
    
    if not api_id:
        api_id = input("API ID: ").strip()
    else:
        print(f"API ID: {api_id} (loaded from .env)")
    
    if not api_hash:
        api_hash = input("API Hash: ").strip()
    else:
        print(f"API Hash: {api_hash[:8]}... (loaded from .env)")
    
    if not api_id or not api_hash:
        print("Error: API ID and Hash are required")
        sys.exit(1)
    
    try:
        api_id = int(api_id)
    except ValueError:
        print("Error: API ID must be a number")
        sys.exit(1)
    
    phone = input("\nPhone number (with country code, e.g. +886...): ").strip()
    
    if not phone:
        print("Error: Phone number is required")
        sys.exit(1)
    
    print()
    print("=" * 50)
    print()
    
    # Import and run telethon
    from telethon import TelegramClient
    from telethon.session import StringSession
    
    # Create session without connecting - just need phone to initialize
    client = TelegramClient(
        session=StringSession(),
        api_id=api_id,
        api_hash=api_hash
    )
    
    async def generate():
        # Initialize with phone (doesn't actually connect)
        await client.start(phone=phone)
        session_str = client.session.save()
        
        print()
        print("=" * 50)
        print("  Session String Generated!")
        print("=" * 50)
        print()
        
        # Update .env file with TELEGRAM_SESSION_STRING
        env_vars['TELEGRAM_SESSION_STRING'] = session_str
        write_env(env_path, env_vars)
        print(f"Session string saved to .env file")
        print()
        print("=" * 50)
        print()
        print("Or paste it in the browser configuration panel.")
        print()
        
        # Also save to file (backup)
        with open('.session_string.txt', 'w') as f:
            f.write(session_str)
        print("Session string also saved to .session_string.txt (backup)")
        
        await client.disconnect()
    
    import asyncio
    asyncio.run(generate())

if __name__ == '__main__':
    main()
