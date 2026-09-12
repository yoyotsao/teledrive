from pathlib import Path

path = Path('frontend/src/lib/gramjs.ts')
text = path.read_text()

old = """        await sendWithDeadline(async () => {
          sender = await (client as any).getSender((client.session as any).dcId);
        }, CHUNK_SEND_TIMEOUT_MS, label);
"""
new = """        await sendWithDeadline(async () => {
          sender = await (client as any).getSender();
        }, CHUNK_SEND_TIMEOUT_MS, label);
"""

if old not in text:
    raise SystemExit('home-DC upload sender marker not found or already patched')

text = text.replace(old, new, 1)

old_comment = """   * Both the sender handoff and the send itself run under a deadline. Neither
   * can be trusted to settle on its own: getSender's _connectSender retries in
   * an unbounded while(true), and MTProtoSender.send() returns a promise that
   * gramjs abandons — never rejects — when the connection breaks. The caller
   * holds an uploadSemaphore slot for this whole call, so an unbounded wait
   * here costs the account that slot permanently.
"""
new_comment = """   * New uploads target the session's home DC, so request the already-connected
   * main sender with getSender() and do not pass session.dcId. Passing the home
   * dcId asks GramJS for an exported same-DC sender; its release/reconnect
   * lifecycle can collide with pending file parts and cause a reconnect storm.
   * The sender lookup and send still run under deadlines so a broken transport
   * cannot hold an uploadSemaphore slot forever.
"""

if old_comment not in text:
    raise SystemExit('upload sender comment marker not found')
text = text.replace(old_comment, new_comment, 1)

path.write_text(text)
