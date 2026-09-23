"""Live Chrome functional test. Needs local Python Playwright, Chrome, Node and CLIs.
Writes only a temporary fixture index and temporary CLI configuration.
Queries actual model catalogs without sending a model prompt.
"""
import json,os,pathlib,subprocess,sys,time,hashlib
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
try:
 info=json.loads(server.stdout.readline());url=info['url']
 with sync_playwright() as p:
  chrome=os.environ.get('SUPERLCM_TEST_CHROME') or ('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' if sys.platform=='darwin' else None)
  browser=p.chromium.launch(**({'executable_path':chrome} if chrome else {}),headless=True)
  page=browser.new_page(viewport={'width':1440,'height':1080},color_scheme='light');errors=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  page.on('response',lambda response:errors.append('HTTP '+str(response.status)+' '+response.url) if response.status>=400 else None)
  page.goto(url);page.wait_for_selector('[data-detail="codex-source"]');page.wait_for_selector('#harnessRows [data-test="codex"]',state='attached')
  assert page.locator('[data-view-panel]:visible').count()==1
  page.locator('[data-detail="codex-source"]').click();page.wait_for_selector('#summaryNodes .pre');assert 'Fixture:' in page.locator('#summaryNodes').inner_text()
  page.screenshot(path='/tmp/superlcm-redesign-index.png',full_page=True)
  page.locator('[data-view="delivery"]').click();page.wait_for_selector('#localSessions [data-index]')
  page.locator('#localSessions .record').filter(has_text='待导入本地记录').locator('button').click();page.wait_for_function("() => document.getElementById('localFeedback').textContent.includes('新增')")
  page.select_option('#sourceHarness','codex');page.wait_for_selector('#source option[value="codex-source"]',state='attached');page.select_option('#source','codex-source')
  page.select_option('#targetHarness','claude-code');page.wait_for_selector('#target option[value="target"]',state='attached');page.select_option('#target','target')
  page.click('#preview');page.wait_for_function("() => document.getElementById('previewtext').textContent.includes('Fixture:')")
  page.click('#send');page.wait_for_function("() => document.getElementById('deliveryFeedback').textContent.includes('已排队')")
  assert '待目标 hook 领取' in page.locator('#deliveries').inner_text();page.screenshot(path='/tmp/superlcm-redesign-import.png',full_page=True)
  page.locator('[data-view="summary"]').click()
  mode='[data-role="mode"][data-key="global"]';picker='[data-role="model-choice"][data-key="global"]'
  page.select_option(mode,'codex-cli');page.wait_for_function("() => document.querySelector('[data-role=hint][data-key=global]').textContent.includes('实时读取')",timeout=30000)
  ids=page.locator(picker+' option').evaluate_all('(nodes)=>nodes.map(n=>n.value)');assert any('/' in x for x in ids),ids
  chosen=next(x for x in ids if '/' in x);page.select_option(picker,chosen)
  with page.expect_response(lambda r:'/api/settings' in r.url and r.request.method=='POST') as saved:page.locator('[data-role="save"][data-key="global"]').click()
  assert saved.value.status==200
  page.wait_for_function("() => document.querySelector('[data-role=status][data-key=global]').textContent==='已保存'")
  page.select_option(mode,'cli');page.wait_for_function("() => document.querySelector('[data-role=hint][data-key=global]').textContent.includes('initialize.models')",timeout=30000)
  ids=page.locator(picker+' option').evaluate_all('(nodes)=>nodes.map(n=>n.value)');assert 'opus[1m]' in ids,ids
  page.select_option(picker,'opus[1m]')
  with page.expect_response(lambda r:'/api/settings' in r.url and r.request.method=='POST') as saved:page.locator('[data-role="save"][data-key="global"]').click()
  assert saved.value.status==200
  page.wait_for_function("() => document.querySelector('[data-role=status][data-key=global]').textContent==='已保存'")
  page.screenshot(path='/tmp/superlcm-redesign-models.png',full_page=True)
  page.locator('[data-view="connection"]').click()
  for harness in ['codex','claude-code']:
   page.locator('[data-setup="'+harness+'"]').click()
   page.wait_for_function("() => document.getElementById('setupInfo').textContent.includes('"+harness+"') && !document.getElementById('applySetup').disabled")
   with page.expect_response(lambda r:'/api/setup-apply' in r.url) as setup:page.click('#applySetup')
   result=setup.value.json();assert setup.value.status==200,result;assert result['saved'];assert not result['trust_granted']
   page.wait_for_function("() => document.getElementById('setupFeedback').textContent.includes('已写配置')")
   with page.expect_response(lambda r:'/api/harness-test' in r.url) as checked:page.locator('[data-test="'+harness+'"]').click()
   diagnostic=checked.value.json();print('row-check',harness,json.dumps(diagnostic,ensure_ascii=False),flush=True)
   assert checked.value.status==200,diagnostic
   page.wait_for_function("() => document.getElementById('check-"+harness+"').textContent.includes('临时库写入')",timeout=10000)
   assert '真实握手成功' in page.locator('#check-'+harness).inner_text()
  page.screenshot(path='/tmp/superlcm-redesign-connections.png',full_page=True)
  for width in [1440,390]:
   page.set_viewport_size({'width':width,'height':1000})
   for view in ['assets','delivery','summary','connection']:
    page.locator('[data-view="'+view+'"]').click();assert page.locator('[data-view-panel]:visible').count()==1
    assert page.evaluate('() => document.documentElement.scrollWidth<=innerWidth'),(width,view)
   if width==390:page.screenshot(path='/tmp/superlcm-redesign-mobile.png',full_page=True)
  assert not errors,errors
  assert page.locator('#error').is_hidden(),page.locator('#error').inner_text()
  browser.close()
 assert before==hashes(),'Real user configurations changed'
 print(json.dumps({'ok':True,'pages':4,'real_catalogs':['codex','claude'],'fixture_install':['codex','claude-code'],'real_user_settings_unchanged':True,'native_cli_cache_fields_excluded':['cachedGrowthBookFeatures','cachedGrowthBookFeaturesAt','cachedExperimentData'],'browser_errors':errors},ensure_ascii=False))
finally:
 server.terminate()
 try:server.wait(8)
 except subprocess.TimeoutExpired:server.kill();server.wait()
