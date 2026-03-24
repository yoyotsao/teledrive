import asyncio
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

session_str = '1BVtsOIwBuxL0tmv6hcI3QTzBEopFsdX9kj9G9OolJwUJNF0q5RFwgS_evBeWNhmVqmCWwEwyfPEfsZY0-QfEFwZ9uMmn53EuSdklGcnOaGCuD2hA_3fi-JX1Uw0W3QXrL4iGiD28V25bpZVfkcpqO61dVbVN2hX8L73wxXitQXpPOaElBNB180_gJ8krqrKo3gIQ5hOfDB6P1wRSxMUqCmypo7ECxuj09wFTfvOt1PGp4Tx84eLH8HmkNaMm4Y2rK92TYGEfstL9EJ69429WsJ_PdiyrITxtRW_AAof5vBDg-S111Uk79V-1rOiTuWm061m621tTltUI7jYpOuXIs9lLwZ43oh8='
api_id = 17595730
api_hash = '083b35d069db416b19789625a520be2c'

with TelegramClient(StringSession(session_str), api_id, api_hash) as client:
    message_id = 179183
    message = client.get_messages('me', ids=message_id)
    
    if message:
        print(f"Message found: {message.text}")
        print(f"Has photo: {hasattr(message, 'photo') and message.photo is not None}")
        print(f"Has document: {hasattr(message, 'document') and message.document is not None}")
        
        if hasattr(message, 'photo') and message.photo:
            photo = message.photo
            print(f"Photo ID: {photo.id}")
            sizes = photo.sizes if hasattr(photo, 'sizes') else []
            print(f"Photo sizes count: {len(sizes)}")
            for s in sizes:
                print(f"  Size type: {getattr(s, 'type', 'unknown')}")
    else:
        print("Message not found")
