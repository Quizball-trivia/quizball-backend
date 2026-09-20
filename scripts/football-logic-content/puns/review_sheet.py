"""Build a self-contained review page of every Football Logic riddle (both pictures embedded)."""
import json, base64, html, os, collections, random
SP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
qs = json.load(open(f'{SP}/questions.json')) + json.load(open(f'{SP}/puns/puns_questions.json'))
random.seed(7); random.shuffle(qs)
def local_path(url):
    name = url.split('/')[-1]
    if 'openmoji' in url: return f'{SP}/puns/icons/{name}'
    return f'{SP}/imgs/{name}'
cache = {}
def data_uri(url):
    if url in cache: return cache[url]
    p = local_path(url); b = open(p, 'rb').read()
    mime = 'image/svg+xml' if p.endswith('.svg') else 'image/png' if p.endswith('.png') else 'image/webp'
    cache[url] = f'data:{mime};base64,' + base64.b64encode(b).decode(); return cache[url]
FAM = {'transfer': 'Transfer', 'only_one': 'Only one', 'picture_pun': 'Picture pun'}
cards = []
for i, q in enumerate(qs):
    cards.append(f'''<figure class="card" data-fam="{q['family']}" data-diff="{q['difficulty']}">
<div class="pics"><img data-k="{q['image_a_url'].split('/')[-1]}" alt=""><img data-k="{q['image_b_url'].split('/')[-1]}" alt=""></div>
<figcaption><span class="tags"><b class="fam {q['family']}">{FAM[q['family']]}</b><b class="diff">{q['difficulty']}</b>{'<b class="conf">' + html.escape(str(q['facts'].get('confidence'))) + '</b>' if q['family']=='picture_pun' else ''}</span>
<p class="q">{html.escape(q['prompt']['en'])}</p><p class="a">{html.escape(q['display_answer']['en'])} <span>· {html.escape(q['display_answer']['ka'])}</span></p>
<p class="why">{html.escape(q['explanation']['en'])}</p></figcaption></figure>''')
c = collections.Counter(q['family'] for q in qs); d = collections.Counter(q['difficulty'] for q in qs)
page = f'''<title>Football Logic Riddles</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500;600&display=swap">
<style>
:root{{--bg:#f3f5f9;--surface:#fff;--ink:#101528;--muted:#5b6478;--line:#d9deea;--accent:#1f3cff;--art:#fff;--yellow:#ffe500}}
@media (prefers-color-scheme: dark){{:root:not([data-theme="light"]){{--bg:#0e1220;--surface:#171c2e;--ink:#eef1fa;--muted:#98a2ba;--line:#2a3148;--accent:#6b82ff;--art:#f6f7fb}}}}
:root[data-theme="dark"]{{--bg:#0e1220;--surface:#171c2e;--ink:#eef1fa;--muted:#98a2ba;--line:#2a3148;--accent:#6b82ff;--art:#f6f7fb}}
body{{margin:0;background:var(--bg);color:var(--ink);font-family:Barlow,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.4}}
.wrap{{max-width:1240px;margin:0 auto;padding:28px 20px 60px}}
h1{{font-family:"Barlow Condensed",sans-serif;font-size:40px;font-weight:700;margin:0;line-height:1}} h1 small{{display:block;font-family:Barlow;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:500;margin-bottom:8px}}
.stats{{display:flex;gap:18px;margin:14px 0 4px;font-variant-numeric:tabular-nums;flex-wrap:wrap}} .stats div{{display:flex;flex-direction:column}} .stats b{{font-family:"Barlow Condensed",sans-serif;font-size:26px;line-height:1}} .stats span{{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}}
.tools{{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 16px}} .tools button{{font:inherit;font-size:12px;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer}} .tools button[aria-pressed="true"]{{background:var(--accent);color:#fff;border-color:var(--accent)}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}}
.card{{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}} .card[hidden]{{display:none}}
.pics{{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:10px;background:var(--art)}} .pics img{{width:100%;aspect-ratio:1;object-fit:contain;display:block}}
figcaption{{padding:10px 12px 12px}} .tags{{display:flex;gap:6px;margin-bottom:6px}} .tags b{{font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:var(--line)}} .fam.picture_pun{{background:var(--yellow);color:#111}} .fam.transfer{{background:#dbe4ff;color:#1f3cff}} .fam.only_one{{background:#e6f4ea;color:#1a7f37}}
.q{{margin:0;font-weight:500}} .a{{margin:4px 0 0;font-weight:600}} .a span{{color:var(--muted);font-weight:400}} .why{{margin:4px 0 0;font-size:12px;color:var(--muted)}}
</style>
<div class="wrap"><h1><small>Football Logic · review before publish</small>Every riddle, both pictures</h1>
<div class="stats"><div><b>{len(qs)}</b><span>riddles</span></div><div><b>{c.get('picture_pun',0)}</b><span>picture puns</span></div><div><b>{c.get('transfer',0)}</b><span>transfers</span></div><div><b>{c.get('only_one',0)}</b><span>only one</span></div><div><b>{d.get('easy',0)} / {d.get('medium',0)} / {d.get('hard',0)}</b><span>easy / medium / hard</span></div></div>
<div class="tools"><button data-f="all" aria-pressed="true">All</button><button data-f="picture_pun">Picture puns</button><button data-f="transfer">Transfers</button><button data-f="only_one">Only one</button></div>
<div class="grid">{''.join(cards)}</div></div>
<script>const IMG={json.dumps({u.split('/')[-1]: data_uri(u) for u in sorted({u for q in qs for u in (q['image_a_url'], q['image_b_url'])})})};document.querySelectorAll('img[data-k]').forEach(i=>{{i.src=IMG[i.dataset.k];}});const bs=[...document.querySelectorAll('.tools button')],cs=[...document.querySelectorAll('.card')];bs.forEach(b=>b.addEventListener('click',()=>{{bs.forEach(x=>x.setAttribute('aria-pressed',x===b));const f=b.dataset.f;cs.forEach(c=>c.hidden=f!=='all'&&c.dataset.fam!==f);}}));</script>'''
open(f'{SP}/puns/review.html', 'w').write(page); print('review page', len(qs), 'riddles', round(len(page)/1e6, 1), 'MB')
