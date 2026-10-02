import time, os, subprocess, shutil
# Records docs/images/takeover-{en,zh}-{light,dark}.gif from scripts/demos/takeover.html (run from the repo root; needs playwright and ffmpeg).
from playwright.sync_api import sync_playwright
URL='file://'+os.path.join(os.path.dirname(os.path.abspath(__file__)),'takeover.html'); OUT='docs/images'
ONLY='.demo-head,.caption{display:none!important} body{padding:20px!important} .demo{padding:0!important}'
def gif(frames, times, out):
    d=out+'.d'; os.makedirs(d,exist_ok=True); lst=[]
    for i,(f,t) in enumerate(zip(frames,times)):
        fn=f'{d}/{i:05d}.png'; open(fn,'wb').write(f)
        dur=(times[i+1]-t) if i+1<len(times) else 2.0
        lst.append(f"file '{os.path.abspath(fn)}'\nduration {dur:.3f}")
    lst.append(f"file '{os.path.abspath(fn)}'")
    open(d+'/list.txt','w').write('\n'.join(lst))
    vf='fps=12,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle'
    subprocess.run(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i',d+'/list.txt','-vf',vf,'-loop','0',out],check=True)
    shutil.rmtree(d)
GH={'light':'html:root{--paper:#ffffff;--card:#FBFAF9}','dark':'html:root{--paper:#0d1117;--card:#161b22;--shelf:#21262d;--line:#30363d}'}
with sync_playwright() as p:
    b=p.chromium.launch(channel='chrome')
    for theme in ['light','dark']:
        for lang,loc in [('en','en-US'),('zh','zh-CN')]:
            ctx=b.new_context(viewport={'width':1040,'height':800},locale=loc,color_scheme=theme)
            pg=ctx.new_page(); pg.goto(URL); pg.add_style_tag(content=ONLY+GH[theme]); pg.evaluate('document.fonts.ready'); pg.wait_for_timeout(1000)
            h=int(pg.locator('#takeover').bounding_box()['height']+40); pg.set_viewport_size({'width':1040,'height':h}); pg.wait_for_timeout(300)
            pg.evaluate("document.getElementById('replay3').click()"); t0=time.time(); frames=[]; times=[]
            while time.time()-t0<19.5: times.append(time.time()-t0); frames.append(pg.screenshot())
            out=f'{OUT}/takeover-{lang}-{theme}.gif'; gif(frames,times,out); ctx.close()
            print(out, len(frames),'frames', os.path.getsize(out)//1024,'KB', h)
    b.close()
