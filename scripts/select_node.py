# 云端节点选择：下载订阅 → 起 mihomo（global）→ 逐个试美国节点 → 选一个不被 Akamai 拦的
# 环境变量: SUB_URL（订阅链接）、BARK_KEY（全挂时告警）
# 输出: 保持 mihomo 运行，ND_PROXY 用 http://127.0.0.1:7890
import os, sys, json, time, random, base64, urllib.request
import yaml

SUB_URL = os.environ.get('SUB_URL', '').strip()
BARK_KEY = os.environ.get('BARK_KEY', '').strip()
PROXY = 'http://127.0.0.1:7890'
CTRL = 'http://127.0.0.1:9090'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
US_KEYS = ('美国', '美國', 'US', 'United States', 'States')

def bark_alert(body):
    if not BARK_KEY: return
    try:
        payload = json.dumps({'device_key': BARK_KEY, 'title': '任务B·ND私促(节点全挂)',
                              'body': body[:3800], 'group': '任务B', 'level': 'active'}).encode()
        req = urllib.request.Request('https://api.day.app/push', data=payload,
                                     headers={'Content-Type': 'application/json; charset=utf-8'})
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        print('[bark] 失败', e)

def api(path, method='GET', data=None):
    req = urllib.request.Request(CTRL + path, method=method,
                                 data=json.dumps(data).encode() if data else None,
                                 headers={'Content-Type': 'application/json'})
    return urllib.request.urlopen(req, timeout=8).read().decode()

def fetch_via_proxy(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY}))
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'accept-language': 'en-US,en;q=0.9'})
    return opener.open(req, timeout=40).read().decode('utf-8', 'ignore')

if not SUB_URL:
    print('无 SUB_URL，跳过代理直连'); sys.exit(2)

# 1) 下载订阅（clash 格式）
req = urllib.request.Request(SUB_URL, headers={'User-Agent': 'clash-verge/v2.0.0'})
sub = yaml.safe_load(urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'ignore'))
proxies = sub.get('proxies') or []
print(f'订阅节点 {len(proxies)} 个')
if not proxies: bark_alert('订阅下载失败或无节点'); sys.exit(1)

us = [p['name'] for p in proxies if any(k in p['name'] for k in US_KEYS)]
others = [p['name'] for p in proxies if p['name'] not in us]
print(f'美国节点 {len(us)} 个: {us[:6]}...')

# 2) 最小配置起 mihomo
cfg = {'mixed-port': 7890, 'external-controller': '127.0.0.1:9090',
       'mode': 'global', 'log-level': 'warning', 'unified-delay': True, 'tcp-concurrent': True,
       'proxies': proxies}
with open('cfg.yaml', 'w', encoding='utf-8') as f:
    yaml.safe_dump(cfg, f, allow_unicode=True)

import subprocess
log = open('mihomo.log', 'w')
subprocess.Popen(['./mihomo', '-f', 'cfg.yaml'], stdout=log, stderr=log)
for _ in range(50):
    time.sleep(0.4)
    try: api('/version'); break
    except Exception: pass
else:
    print('mihomo 未起来'); bark_alert('mihomo 启动失败'); sys.exit(1)
print('mihomo 就绪')

# 3) 逐节点试（美国优先，随机打散；不撞本地任务固定用的「02原生」？不特判，随机即可）
cand = us + [n for n in others if '美国' not in n and '美國' not in n]
random.shuffle(cand)
cand = us[:1] + cand[1:] if us else cand  # 保底先试一个美国节点，其余随机

chosen = None
for i, name in enumerate(cand[:25]):
    try:
        api('/proxies/GLOBAL', 'PUT', {'name': name})
        time.sleep(1.2)
        body = fetch_via_proxy('https://www.nordstrom.com/browse/designer-private-sale')
        bad = 'unusual activity' in body.lower() or len(body) < 100000
        ip = fetch_via_proxy('https://api.ipify.org') if not bad else '?'
        print(f'[{i+1}/{min(25,len(cand))}] {name} -> {"被拦" if bad else "OK ip=" + ip.strip()[:20]}')
        if not bad:
            chosen = name; break
    except Exception as e:
        print(f'[{i+1}] {name} -> 异常 {str(e)[:60]}')

if not chosen:
    bark_alert('25 个候选节点全部被拦或异常，本轮未跑')
    sys.exit(1)

print(f'选定节点: {chosen}')
with open('chosen_node.txt', 'w', encoding='utf-8') as f:
    f.write(chosen)
