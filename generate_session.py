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

def main():
    print("=" * 50)
    print("  Telegram Session String Generator")
    print("=" * 50)
    print()
    
    # Get API credentials
    print("Enter your Telegram API credentials from https://my.telegram.org")
    print()
    
    api_id = input("API ID: ").strip()
    api_hash = input("API Hash: ").strip()
    
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
    
    client = TelegramClient(
        session='teledrive_session',
        api_id=api_id,
        api_hash=api_hash
    )
    
    async def generate():
        await client.start(phone=phone)
        session_str = client.session.save()
        
        print()
        print("=" * 50)
        print("  Session String Generated!")
        print("=" * 50)
        print()
        print("Copy this string to your .env file:")
        print()
        print(f"TELEGRAM_SESSION_STRING={session_str}")
        print()
        print("=" * 50)
        print()
        print("Or paste it in the browser configuration panel.")
        print()
        
        # Also save to file
        with open('.session_string.txt', 'w') as f:
            f.write(session_str)
        print("Session string also saved to .session_string.txt")
        
        await client.disconnect()
    
    import asyncio
    asyncio.run(generate())

if __name__ == '__main__':
    main()
