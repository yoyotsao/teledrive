from pathlib import Path

for name in ('backend/app/api/routes.py',):
    path = Path(name)
    text = path.read_text(encoding='utf-8')
    had_final_newline = text.endswith('\n')
    cleaned = '\n'.join(line.rstrip() for line in text.splitlines())
    if had_final_newline:
        cleaned += '\n'
    path.write_text(cleaned, encoding='utf-8')
