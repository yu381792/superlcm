"""Fresh global installation in Chrome and installed DSH; no model calls."""
import json,pathlib,subprocess
from playwright.sync_api import sync_playwright
root=pathlib.Path(__file__).resolve().parents[1]
server=subprocess.Popen(['node',str(root/'test/dsh-install-ui-fixture.mjs')],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 info=json.loads(server.stdout.readline());folder=pathlib.Path(info['dir']);original={name:(folder/('dsh/profiles/'+name+'/cordis.patch.yml')).read_bytes() for name in ['web','acp']}
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
  page=browser.new_page(viewport={'width':1280,'height':1000},locale='zh-CN');errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(info['url']+'#connect');page.wait_for_selector('[data-dsh-connect]')
  card=page.locator('#tools .tcard',has_text='dsh harness');assert card.locator('.hmark svg').count()==1
  card.locator('[data-dsh-connect]').click();page.wait_for_selector('#dshProvider')
  assert page.locator('#dshProfile').count()==0
  assert page.locator('#dshProvider').evaluate('(el)=>el.tagName')=='SELECT'
  assert page.locator('#dshModel').evaluate('(el)=>el.tagName')=='SELECT'
  page.locator('#dshProvider').select_option(label='Sample AI')
  page.wait_for_selector('#dshModel:not([disabled])')
  assert set(page.locator('#dshModel option').all_inner_texts())=={'选择模型','cheap-summary','long-context','alternate-model'}
  page.locator('#dshModel').select_option('cheap-summary');page.wait_for_selector('#dshApply:not([disabled])')
  assert 'fixture-private-key' not in page.locator('.modal').inner_text()
  assert 'acp' not in page.locator('.modal').inner_text() and '使用界面' not in page.locator('.modal').inner_text()
  page.screenshot(path='/private/tmp/superlcm-dsh-global-models.png',full_page=True)
  with page.expect_response(lambda r:'/api/setup-apply' in r.url) as installed:page.locator('#dshApply').click()
  assert installed.value.status==200,installed.value.text();assert installed.value.json()['scope']=='global'
  try:page.wait_for_selector('.modal:has-text("全局接入完成")',timeout=12000)
  except Exception:
   print('UI failure',page.locator('.modal').inner_text(),errors,flush=True);raise
  for name in original:assert (folder/('dsh/profiles/'+name+'/cordis.patch.yml')).read_bytes()==original[name]
  global_file=folder/'dsh/cordis.patch.yml';assert global_file.exists()
  assert 'superlcm-global-compaction' in global_file.read_text() and info['archive'] in global_file.read_text()
  page.locator('.modal [data-close]').last.click();page.wait_for_selector('[data-dsh-connect]:has-text("更新接入")')
  page.locator('[data-dsh-connect]').click();page.wait_for_selector('#dshApply:not([disabled])')
  with page.expect_response(lambda r:'/api/setup-apply' in r.url) as updated:page.locator('#dshApply').click()
  assert updated.value.status==200,updated.value.text();page.wait_for_selector('.modal:has-text("全局接入完成")',timeout=30000)
  assert global_file.read_text().count('# BEGIN SuperLcm global DSH integration')==1
  page.locator('.modal [data-close]').last.click()
  page.locator('[data-view="settings"]').click();page.locator('#setNav [data-sec="compact"]').click()
  page.wait_for_selector('#dshControlsSave:not([disabled])')
  assert page.locator('#dshControlsModel').input_value()=='cheap-summary'
  page.locator('[data-dsh-window="200000"]').click()
  page.locator('#dshKeepPercent').fill('30');page.locator('#dsh-tailCount').fill('8')
  page.locator('#dshControlsModel').select_option('alternate-model');page.locator('#dshControlsOn').uncheck()
  with page.expect_response(lambda r:'/api/dsh-compression' in r.url and r.request.method=='POST') as saved:page.locator('#dshControlsSave').click()
  assert saved.value.status==200,saved.value.text();value=saved.value.json()
  assert value['enabled']==False and value['model']=='alternate-model'
  assert value['softActiveTokens']==200000 and value['minRetainTokens']==60000 and value['tailCount']==8
  page.wait_for_selector('#dshControlsSave:not([disabled])')
  page.screenshot(path='/private/tmp/superlcm-dsh-controls.png',full_page=True)
  page.locator('#dshControlsRead').click();page.wait_for_selector('#dshControlsModel option[value="alternate-model"]:checked',state='attached')
  assert not page.locator('#dshControlsOn').is_checked()
  assert 'fixture-private-key' not in page.locator('#dshCompressionSettings').inner_text()
  assert not errors,errors;browser.close()
 print(json.dumps({'status':'PASS','scope':'global','noLegacyPluginRequired':True,'allConfiguredModels':True,'providerAndModelDropdowns':True,'originalModelSettingsUnchanged':True,'dailyCompressionControls':True,'modelCalls':0,'screenshot':'/private/tmp/superlcm-dsh-global-models.png'},ensure_ascii=False))
finally:
 server.terminate();server.wait(timeout=10)
