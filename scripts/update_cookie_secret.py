# 用 GH_PAT 把 data/cookies.json 回写到 ND_COOKIES Secret（Cookie 自续期）
import json, base64, os, urllib.request
import nacl.public

PAT = os.environ['GH_PAT']
O, R = 'tahanialsalm37-netizen', 'nordstrom-taskb'
cookies = json.load(open('data/cookies.json', encoding='utf-8'))
if not cookies:
    print('cookies 为空，跳过'); raise SystemExit(0)

req = urllib.request.Request(f'https://api.github.com/repos/{O}/{R}/actions/secrets/public-key',
                             headers={'Authorization': f'token {PAT}', 'Accept': 'application/vnd.github+json'})
pk = json.loads(urllib.request.urlopen(req, timeout=30).read())
sk = nacl.public.PublicKey(base64.b64decode(pk['key']))
enc = nacl.public.SealedBox(sk).encrypt(json.dumps(cookies).encode())
data = json.dumps({'encrypted_value': base64.b64encode(enc).decode(), 'key_id': pk['key_id']}).encode()
req = urllib.request.Request(f'https://api.github.com/repos/{O}/{R}/actions/secrets/ND_COOKIES', method='PUT',
                             data=data, headers={'Authorization': f'token {PAT}',
                                                 'Accept': 'application/vnd.github+json',
                                                 'Content-Type': 'application/json'})
print('refresh ND_COOKIES:', urllib.request.urlopen(req, timeout=30).status)
