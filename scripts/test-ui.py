"""Live Chrome functional test. Needs local Python Playwright, Chrome, Node and CLIs.
Writes only a temporary fixture index and temporary CLI configuration.
Queries actual model catalogs without sending a model prompt.
"""
import json,os,pathlib,subprocess,sys,hashlib
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
config_paths=[pathlib.Path.home()/'.codex/config.toml',pathlib.Path.home()/'.codex/hooks.json',pathlib.Path.home()/'.claude.json',pathlib.Path.home()/'.claude/settings.json']
def hashes():
 result={}
 for p in config_paths:
  if not p.exists():result[str(p)]=None;continue
  data=p.read_bytes()
  if p.name=='.claude.json':
   config=json.loads(data)
   # Verified native CLI metadata-probe cache refreshes, not user settings.
   for key in ['cachedGrowthBookFeatures','cachedGrowthBookFeaturesAt','cachedExperimentData']:config.pop(key,None)
   data=json.dumps(config,sort_keys=True,separators=(',',':')).encode()
  result[str(p)]=hashlib.sha256(data).hexdigest()
 return result
before=hashes()
server=subprocess.Popen(['node',str(ROOT/'test/ui-fixture.mjs')],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,cwd=ROOT)
shots=pathlib.Path(os.environ.get('SUPERLCM_TEST_SHOTS','/tmp'))
try:
 info=json.loads(server.stdout.readline());url=info['url']
 with sync_playwright() as p:
  chrome=os.environ.get('SUPERLCM_TEST_CHROME') or ('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' if sys.platform=='darwin' else None)
  browser=p.chromium.launch(**({'executable_path':chrome} if chrome else {}),headless=True)
  context=browser.new_context(viewport={'width':1440,'height':1000},color_scheme='light',locale='zh-CN')
  context.grant_permissions(['clipboard-read','clipboard-write'])
  page=context.new_page();errors=[];expected_failure=[False]
  page.on('pageerror',lambda error:errors.append(str(error)))
  page.on('console',lambda m:errors.append('console '+m.text) if m.type=='error' and not expected_failure[0] else None)
  page.on('response',lambda r:errors.append('HTTP '+str(r.status)+' '+r.url) if r.status>=400 and not expected_failure[0] else None)
  page.goto(url);page.wait_for_selector('#rows .row')

  # Conversations: the summarized source is selected, shows a merged level and a navigable tree.
  page.locator('#rows .row',has_text='Codex 架构来源').click()
  page.wait_for_selector('#detail h1:has-text("Codex 架构来源")')
  assert page.locator('#detail .seg.l1').count()==1,'merged second-level band missing'
  page.locator('#detail .seg.l1').click();page.wait_for_selector('#detail .node[aria-expanded="true"] .children .node')
  assert page.locator('#detail .node .lv.l0').count()>=4
  page.locator('#detail .children .node-h').first.click();page.locator('#detail .raw-link button').first.click()
  page.wait_for_selector('.drawer .ev');assert 'decision 0' in page.locator('.drawer-b').inner_text()
  page.keyboard.press('Escape');assert page.locator('.drawer').count()==0
  page.screenshot(path=str(shots/'superlcm-conversation.png'),full_page=True)

  # Continue in another tool: the handoff line carries the short code and the packet has the outline.
  page.click('#continue');page.wait_for_selector('.modal .targets')
  page.locator('.target[data-t="claude-code"]').click()
  code=page.locator('#detail .tag').inner_text()
  body=page.locator('.modal').inner_text();assert code in body or '接入 Claude Code' in body,body
  page.locator('.modal [data-close]').first.click()

  # Rename and search.
  page.click('#rename');page.fill('#newName','Renamed 来源');page.locator('#renameForm button[type=submit]').click()
  page.wait_for_selector('#detail h1:has-text("Renamed 来源")')
  page.fill('#q','decision 3');page.wait_for_selector('#rows .hit')
  page.locator('#rows .hit').first.click();page.wait_for_selector('.drawer .ev.focus, #detail .node.flash',timeout=5000)
  page.keyboard.press('Escape');page.fill('#q','');page.wait_for_selector('#rows .row')

  # No summary yet: one clear action opens a confirmation that names the method and its cost; cancel starts nothing.
  summarize_calls=[];page.on('request',lambda r:summarize_calls.append(r.url) if '/api/summarize' in r.url else None)
  page.locator('#rows .row',has_text='Claude 验证目标').click();page.wait_for_selector('#detail h1:has-text("Claude 验证目标")')
  page.locator('#detail [data-generate]').click();page.wait_for_selector('.modal #genOpts .target')
  body=page.locator('.modal').inner_text();assert '额度' in body or '计费' in body,body
  page.screenshot(path=str(shots/'superlcm-generate.png'))
  page.locator('.modal [data-close]').last.click();assert page.locator('.modal').count()==0 and not summarize_calls,summarize_calls

  # Connect: errors are visible, local import works, setup writes only the temporary homes.
  page.locator('.nav [data-view="connect"]').click();page.wait_for_selector('#tools .tool')
  expected_failure[0]=True
  page.route('**/api/setup-preview',lambda route:route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'fixture config unavailable'})))
  page.locator('[data-setup="claude-code"]').click();page.wait_for_selector('.modal .notice.bad:has-text("fixture config unavailable")')
  assert page.locator('#applySetup').is_disabled()
  page.locator('.modal [data-close]').first.click();page.unroute('**/api/setup-preview');expected_failure[0]=False
  page.locator('#importTools [data-import="codex"]').click();page.wait_for_selector('.local-row')
  page.locator('.local-row',has_text='待导入本地记录').locator('button').click()
  page.wait_for_selector('.local-row:has-text("待导入本地记录") [data-open]');page.locator('.modal [data-close]').first.click()
  for harness in ['codex','claude-code']:
   page.locator('[data-setup="'+harness+'"]').click()
   page.wait_for_function("() => document.getElementById('applySetup') && !document.getElementById('applySetup').disabled",timeout=30000)
   with page.expect_response(lambda r:'/api/setup-apply' in r.url) as setup:page.click('#applySetup')
   result=setup.value.json();assert setup.value.status==200,result;assert result['saved'] and result['configuration_verified'] and not result['trust_granted'],result
   page.wait_for_selector('.modal .steps li:nth-child(3).done, .modal .steps li:nth-child(3).fail',timeout=60000)
   note=page.locator('.modal .notice').inner_text();print('setup',harness,note,flush=True)
   assert page.locator('.modal .steps li:nth-child(3).done').count()==1,note
   page.screenshot(path=str(shots/('superlcm-setup-'+harness+'.png')))
   page.locator('.modal [data-close]').first.click()
  assert page.locator('#statusText').inner_text().startswith('已接入')

  # Settings: real CLI catalogs, saving, granularity and appearance.
  page.locator('.nav [data-view="settings"]').click()
  page.locator('#writer .opt[data-w="codex-cli"]').click()
  page.wait_for_function("() => document.querySelectorAll('#wModel option').length>1",timeout=30000)
  with page.expect_response(lambda r:'/api/settings' in r.url and r.request.method=='POST') as saved:page.click('#saveWriter')
  assert saved.value.status==200;page.wait_for_selector('#writerSaved:has-text("已保存")')
  page.locator('#setNav [data-sec="granularity"]').click();assert page.locator('#writer').is_hidden()
  page.select_option('#fanout','6');page.wait_for_selector('#toast:not([hidden])')
  page.locator('#setNav [data-sec="storage"]').click()
  page.locator('.sw[data-pal="teal"]').click();assert page.evaluate("document.documentElement.dataset.palette")=='teal'
  page.screenshot(path=str(shots/'superlcm-settings.png'),full_page=True)

  for width in [1440,390]:
   page.set_viewport_size({'width':width,'height':900})
   for view in ['conversations','connect','settings']:
    page.evaluate("v => location.hash = v",view);page.wait_for_selector('#view-'+view+':not([hidden])')
    assert page.evaluate('() => document.documentElement.scrollWidth<=innerWidth'),(width,view)
   if width==390:page.screenshot(path=str(shots/'superlcm-mobile.png'),full_page=True)
  # Language switch: English renders the whole shell and dynamic views without leftover Chinese labels.
  page.set_viewport_size({'width':1440,'height':900});page.evaluate("location.hash='settings'")
  page.locator('#setNav [data-sec="storage"]').click();page.select_option('#langSel','en');page.wait_for_selector('.nav [data-view="conversations"]:has-text("Conversations")')
  page.locator('#setNav [data-sec="writer"]').click();page.wait_for_selector('#writer .opt[data-w="off"]:has-text("Off")')
  page.locator('#brand').click();page.wait_for_selector('#view-conversations:not([hidden])')
  page.evaluate("location.hash='conversations'");page.wait_for_selector('#listCount:has-text("conversations")')
  page.screenshot(path=str(shots/'superlcm-english.png'),full_page=True)
  page.select_option('#langSel','zh') if page.locator('#langSel').is_visible() else None
  assert not errors,errors
  assert page.locator('#error').is_hidden(),page.locator('#error').inner_text()
  browser.close()
 assert before==hashes(),'Real user configurations changed'
 print(json.dumps({'ok':True,'views':3,'merged_levels':True,'continue':True,'local_import':True,'fixture_setup':['codex','claude-code'],'real_catalog':'codex','real_user_settings_unchanged':True},ensure_ascii=False))
finally:
 server.terminate()
 try:server.wait(8)
 except subprocess.TimeoutExpired:server.kill();server.wait()
