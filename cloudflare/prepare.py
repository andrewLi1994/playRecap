from pathlib import Path
import shutil
root=Path(__file__).resolve().parents[1]
public=root/'cloudflare/public';public.mkdir(exist_ok=True)
for name in ['index.html','script.js','styles.css','icon.svg']:
    shutil.copy2(root/name,public/name)
print('Prepared 4 public UI assets; no audio files or credentials included.')
