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
  page=browser.new_page(viewport={'width':1440,'height':1080},color_scheme='light');errors=[];requests=[];expected_failure=[False]
  page.on('request',lambda request:requests.append(request.url))
  page.on('pageerror',lambda error:errors.append(str(error)))
  page.on('response',lambda response:errors.append('HTTP '+str(response.status)+' '+response.url) if response.status>=400 and not expected_failure[0] else None)
  page.goto(url);page.wait_for_selector('[data-detail="codex-source"]');page.wait_for_selector('#harnessRows [data-test="codex"]',state='attached')
  assert page.locator('[data-view-panel]:visible').count()==1
  page.locator('[data-detail="codex-source"]').click();page.wait_for_selector('#summaryNodes .pre');assert 'Fixture:' in page.locator('#summaryNodes').inner_text()
  page.screenshot(path='/tmp/superlcm-redesign-index.png',full_page=True)
  page.locator('[data-use-source="codex-source"]').click()
  page.wait_for_function("() => document.getElementById('source').value==='codex-source' && document.getElementById('previewtext').textContent.includes('Fixture:')")
  assert page.locator('#view-delivery #localSessions').count()==0
  assert not any('/api/local-conversations' in x or '/api/index-local' in x for x in requests),requests
  page.select_option('#sourceHarness','codex');page.wait_for_selector('#source option[value="codex-source"]',state='attached');page.select_option('#source','codex-source')
  assert '待导入本地记录' not in page.locator('#source').inner_text()
  page.select_option('#targetHarness','claude-code');page.wait_for_selector('#target option[value="target"]',state='attached');page.select_option('#target','target');page.select_option('#deliveryRoute','mcp')
  page.click('#preview');page.wait_for_function("() => document.getElementById('previewtext').textContent.includes('Fixture:')")
  assert 'lcm_context' in page.locator('#directInstruction').inner_text()
  page.click('#send');page.wait_for_function("() => document.getElementById('deliveryFeedback').textContent.includes('待领取')")
  assert '待目标 MCP 领取' in page.locator('#deliveries').inner_text()
  messages=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','clientInfo':{'name':'claude-code-browser-fixture'}}},{'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'lcm_receive_context','arguments':{'target':'target'}}}]
  received=subprocess.run(['node',str(ROOT/'src/cli.js'),'mcp'],input='\n'.join(json.dumps(x) for x in messages)+'\n',text=True,capture_output=True,env={**os.environ,'SUPERLCM_HOME':str(pathlib.Path(info['dir'])/'index')},timeout=10)
  assert received.returncode==0,received.stderr
  result=next(x for x in map(json.loads,received.stdout.splitlines()) if x.get('id')==2);assert not result['result'].get('isError'),result
  packet=json.loads(result['result']['content'][0]['text']);assert 'Fixture:' in packet['packets'][0]['content'];assert packet['target']['session']=='target'
  page.click('#refreshDeliveries');page.wait_for_function("() => document.getElementById('deliveries').textContent.includes('MCP 已领取')")
  assert '目标 MCP 已领取' in page.locator('#deliveryFeedback').inner_text()
  page.screenshot(path='/tmp/superlcm-redesign-import.png',full_page=True)
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
  expected_failure[0]=True
  page.route('**/api/setup-preview',lambda route:route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'fixture config unavailable'})))
  page.locator('[data-setup="claude-code"]').click();page.wait_for_function("() => document.getElementById('setupFeedback').textContent.includes('fixture config unavailable')")
  assert page.locator('#setupDialog').is_visible();assert page.locator('#setupFeedback').is_visible();assert page.locator('#applySetup').is_disabled()
  page.click('#closeSetup');page.unroute('**/api/setup-preview');expected_failure[0]=False
  for harness in ['codex','claude-code']:
   page.locator('[data-setup="'+harness+'"]').click()
   assert page.locator('#setupDialog').is_visible()
   page.wait_for_function("() => !document.getElementById('applySetup').disabled")
   box=page.locator('#setupDialog').bounding_box();assert 0<=box['y']<1080,box
   with page.expect_response(lambda r:'/api/setup-apply' in r.url) as setup:page.click('#applySetup')
   result=setup.value.json();assert setup.value.status==200,result;assert result['saved'];assert result['configuration_verified'];assert not result['trust_granted']
   page.wait_for_function("() => !document.getElementById('setupNext').hidden",timeout=30000)
   if harness=='claude-code':
    assert 'Claude CLI 连接验证通过' in page.locator('#setupFeedback').inner_text(),page.locator('#setupFeedback').inner_text()
    page.screenshot(path='/tmp/superlcm-claude-connect-dialog.png',full_page=True)
   assert not page.locator('#verifyConnection').is_hidden()
   page.click('#closeSetup')
   with page.expect_response(lambda r:'/api/connection-check' in r.url) as checked:page.locator('[data-test="'+harness+'"]').click()
   diagnostic=checked.value.json();print('row-check',harness,json.dumps(diagnostic,ensure_ascii=False),flush=True);assert checked.value.status==200,diagnostic
   if harness=='claude-code':assert diagnostic['ok'] and diagnostic['scope']=='claude-runtime-probe' and not diagnostic['existing_session_verified'],diagnostic
   else:assert diagnostic['protocol']['ok'] and diagnostic['hook']['adapter']['ok'],diagnostic
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
 print(json.dumps({'ok':True,'pages':4,'indexed_import_to_target_mcp':True,'claude_runtime_loaded':True,'visible_error_feedback':True,'native_collection_requests':0,'real_catalogs':['codex','claude'],'fixture_install':['codex','claude-code'],'real_user_settings_unchanged':True,'native_cli_cache_fields_excluded':['cachedGrowthBookFeatures','cachedGrowthBookFeaturesAt','cachedExperimentData'],'browser_errors':errors},ensure_ascii=False))
finally:
 server.terminate()
 try:server.wait(8)
 except subprocess.TimeoutExpired:server.kill();server.wait()
