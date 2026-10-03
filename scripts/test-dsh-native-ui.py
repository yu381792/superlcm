"""Real DSH web UI, isolated profile/archive, synthetic model catalog; no prompts."""
import json,pathlib,subprocess,tempfile,time,os,re
from playwright.sync_api import sync_playwright
root=pathlib.Path(__file__).resolve().parents[1]
folder=pathlib.Path(tempfile.mkdtemp(prefix='superlcm-native-ui-'));profile=folder/'dsh/profiles/web';profile.mkdir(parents=True)
env={**os.environ,'DSH_HOME':str(folder/'dsh'),'SUPERLCM_HOME':str(folder/'archive')}
(profile/'package.json').write_text(json.dumps({'name':'native-ui-fixture','private':True,'dsh':{'profile':{'bundles':['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}},'dependencies':{}}))
legacy=profile/'node_modules/superlcm';legacy.mkdir(parents=True)
(legacy/'package.json').write_text(json.dumps({'name':'SuperLcm','repository':{'url':'git+https://github.com/ygc3817922006-sketch/SuperLcm-Lossless-Context.git'}}))
(profile/'cordis.patch.yml').write_text('''- id: llm-pi-ai
  config:
    providers:
      sample-ai:
        displayName: Sample AI
        api: openai-responses
        baseURL: http://127.0.0.1:9/v1
        models:
          - id: cheap-model
            contextWindow: 128000
          - id: alternate-model
            contextWindow: 128000
''')
preview=json.loads(subprocess.check_output(['node',str(root/'src/cli.js'),'setup','dsh'],cwd=root,env=env,text=True,stderr=subprocess.DEVNULL))
ref=preview['catalog']['providers'][0]['ref']
subprocess.run(['node',str(root/'src/cli.js'),'setup','dsh','--provider-ref',ref,'--model','cheap-model','--apply'],cwd=root,env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
assert list((folder/'archive/config-backups').glob('dsh-global-*/web-ui-link.before/package.json')),'legacy package was retained in backup'
logfile=folder/'dsh.log';log=logfile.open('w');server=subprocess.Popen(['dsh','--profile','web','--port','0','--host','127.0.0.1','--no-open'],cwd=folder,env=env,stdout=log,stderr=log)
try:
 url=None
 for _ in range(160):
  if server.poll() is not None:raise RuntimeError('Fixture DSH exited; log '+str(logfile))
  found=re.findall(r'dsh web: (http://127\.0\.0\.1:\d+/\?token=[^\s]+)',logfile.read_text())
  if found:url=found[-1];break
  time.sleep(.25)
 if not url:raise RuntimeError('Fixture DSH did not expose web startup URL; log '+str(logfile))
 import urllib.request,urllib.error
 try:
  urllib.request.urlopen(urllib.request.Request(url.split('?')[0]+'api/superlcm/read',data=b'{}',headers={'Content-Type':'application/json'}))
  raise AssertionError('unauthenticated settings route accepted')
 except urllib.error.HTTPError as error:
  assert error.code==401,error.code
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
  page=browser.new_page(viewport={'width':1400,'height':1050},locale='zh-CN');errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('response',lambda response: print('HTTP '+str(response.status)+' '+response.url.split('?')[0],flush=True) if response.status>=400 else None)
  page.goto(url);page.wait_for_timeout(1000);page.screenshot(path='/private/tmp/superlcm-native-start.png')
  notice=page.get_by_role('dialog').filter(has_text='预览版说明')
  if notice.count():notice.get_by_role('button',name='继续',exact=True).click();page.wait_for_timeout(300)
  later=page.get_by_role('button',name='稍后配置',exact=True)
  if later.count() and later.is_visible():later.click()
  page.get_by_role('button',name='插件',exact=True).click()
  card=page.locator('[data-plugin-package="superlcm"]');card.wait_for()
  print('Fixture card: '+json.dumps({'text':card.inner_text(),'images':card.locator('img').count(),'buttons':card.get_by_role('button').all_text_contents()},ensure_ascii=False),flush=True)
  page.screenshot(path='/private/tmp/superlcm-native-card.png')
  assert card.get_by_role('button',name='查看 SuperLcm',exact=True).count()==1
  assert card.locator('img').count()==1 and card.locator('img').get_attribute('src').startswith('data:image/svg+xml')
  assert page.locator('[data-plugin-package="superlcm-mcp"]').count()==0
  card.get_by_role('button',name='查看 SuperLcm',exact=True).click()
  page.wait_for_timeout(1500);page.screenshot(path='/private/tmp/superlcm-native-detail.png')
  print('Fixture detail loaded',flush=True)
  print('Fixture errors: '+str(errors),flush=True)
  form=page.locator('[data-superlcm-settings]');form.wait_for()
  assert form.locator('[data-superlcm-model]').input_value()=='cheap-model','inherited model'
  assert form.get_by_role('radio',name='300K',exact=True).count()==1,'window preset'
  assert form.get_by_role('radio',name='40K',exact=True).count()==1,'retention preset'
  assert not form.locator('details').evaluate('(e)=>e.open')
  form.get_by_role('radio',name='300K',exact=True).click();form.get_by_role('radio',name='80K',exact=True).click()
  form.locator('[data-superlcm-model]').select_option('alternate-model')
  form.get_by_role('switch',name='由 SuperLcm 接管压缩').uncheck()
  with page.expect_response(lambda response: response.url.endswith('/api/superlcm/save')) as saved_response:
   form.locator('[data-superlcm-save]').click()
  assert saved_response.value.json()['result']['ok'],saved_response.value.json()['result']
  form.get_by_role('status').filter(has_text='设置已生效').wait_for(timeout=20000)
  controls=json.loads((folder/'archive/dsh-compression.json').read_text())['config']
  assert controls['auto']==False and controls['summarizationModel']=='alternate-model'
  assert controls['softActiveTokens']==300000 and controls['minRetainTokens']==80000
  page.screenshot(path='/private/tmp/superlcm-native-plugin-settings.png',full_page=True)
  page.reload()
  page.get_by_role('button',name='插件',exact=True).click()
  page.locator('[data-plugin-package="superlcm"]').get_by_role('button',name='查看 SuperLcm',exact=True).click()
  form=page.locator('[data-superlcm-settings]');form.wait_for()
  assert form.locator('[data-superlcm-model]').input_value()=='alternate-model'
  assert not form.get_by_role('switch',name='由 SuperLcm 接管压缩').is_checked()
  assert not errors,errors;browser.close()
 print(json.dumps({'status':'PASS','nativeDSHUI':True,'brand':'SuperLcm','matchingIcon':True,'authenticatedSettingsRoute':True,'claudeStyleControls':True,'modelsInherited':True,'saveAndReload':True,'appliedInRunningDSH':True,'noDuplicateLegacyCard':True,'modelCalls':0,'fixture':str(folder)},ensure_ascii=False))
except Exception as e:
 import traceback
 print(re.sub(r'token=[^\s\)]+','token=REDACTED',traceback.format_exc()));raise SystemExit(1)
finally:
 server.terminate();server.wait(timeout=10);log.close()
