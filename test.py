from telethon.sync import TelegramClient
from telethon.sessions import StringSession

api_id = 17595730
api_hash = '083b35d069db416b19789625a520be2c'
session_str = '1BVtsOIwBuzPpKl0qEsWRKNhnFfdgR_l162f6CA-1FYmP_M9KfzihfDzmovVAP-jQSGOgWb0nNXBTtNzkuLMt6BYdWmuDSO4uPt8vOnoe6WNLcGqDzPX4F8v1x3VPY2M_Bx6JaIthhCNCcrNIHQDguZydd7ePp_gP2-DowM1lLw-LscBD2fDU1fkMYk510E4HEIIyT6HD24ZKq8eZlleb8pAxq0e_ZxTzYy9HRQLMwf6EsWC3xjOR4mZi1pRz0P-t1XzrkRp3jMaC6rf5RiGaBVfeW6fS2E9PyhlvpdiyIwQlrn7qhzMNfBhWUxh3ADSNo8FKVLDOUYRWLnPT1s6A4Nwm3GQVGNU='

with TelegramClient(StringSession(), api_id, api_hash) as client:
    session_str = client.session.save()
    print(session_str)
    me = client.get_me()
    print(f"OK: {me.first_name} (@{me.username})")
