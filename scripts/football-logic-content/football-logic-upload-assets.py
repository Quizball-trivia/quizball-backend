"""Upload local files to a Supabase storage bucket (upsert). Usage:
python upload.py <SUPABASE_URL> <SERVICE_ROLE_KEY> <bucket> <object-prefix> <file>..."""
import sys, os, mimetypes, urllib.request, ssl, certifi
url, key, bucket, prefix, *files = sys.argv[1:]
ctx = ssl.create_default_context(cafile=certifi.where())
for f in files:
    name = os.path.basename(f); ctype = mimetypes.guess_type(name)[0] or 'application/octet-stream'
    if name.endswith('.svg'): ctype = 'image/svg+xml'
    req = urllib.request.Request(f"{url.rstrip('/')}/storage/v1/object/{bucket}/{prefix.strip('/')}/{name}", data=open(f, 'rb').read(), method='POST',
                                 headers={'Authorization': f'Bearer {key}', 'Content-Type': ctype, 'x-upsert': 'true', 'cache-control': 'max-age=31536000'})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=60) as r: print('ok', r.status, name)
    except urllib.error.HTTPError as e: print('FAIL', e.code, name, e.read()[:200])
