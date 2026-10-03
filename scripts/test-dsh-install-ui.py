"""Fresh-user installation with installed DSH + Chrome; temp profiles, no models."""
import json,pathlib,subprocess
from playwright.sync_api import sync_playwright
root=pathlib.Path(__file__).resolve().parents[1]
server=subprocess.Popen(['node',str(root/'test/dsh-install-ui-fixture.mjs')],cwd=root,
    stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
    info=json.loads(server.stdout.readline());folder=pathlib.Path(info['dir'])
    untouched=(folder/'dsh/profiles/acp/cordis.patch.yml').read_bytes()
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
        page=browser.new_page(viewport={'width':1280,'height':1050},locale='zh-CN');errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(info['url']+'#connect');page.wait_for_selector('[data-dsh-connect]')
        card=page.locator('#tools .tcard',has_text='DSH')
        assert card.locator('.hmark svg').count()==1
        assert '仅导入' not in card.inner_text()
        assert card.locator('[data-dsh-connect]').inner_text()=='接入'
        page.screenshot(path='/private/tmp/superlcm-dsh-public-card.png',full_page=True)
        card.locator('[data-dsh-connect]').click();page.wait_for_selector('#dshApply:not([disabled])')
        assert page.locator('#dshProfile').input_value()=='web'
        assert page.locator('#dshModel').input_value()=='deterministic'
        page.screenshot(path='/private/tmp/superlcm-dsh-install-preview.png',full_page=True)
        with page.expect_response(lambda r:'/api/setup-apply' in r.url) as installed:
            page.locator('#dshApply').click()
        assert installed.value.status==200,installed.value.text()
        page.wait_for_selector('.modal:has-text("接入完成。重新加载")',timeout=30000)
        assert (folder/'dsh/profiles/acp/cordis.patch.yml').read_bytes()==untouched
        manifest=json.loads((folder/'dsh/profiles/web/package.json').read_text())
        assert 'superlcm-mcp' in manifest['dsh']['profile']['bundles']
        text=(folder/'dsh/profiles/web/cordis.patch.yml').read_text()
        assert '# Keep this comment' in text and 'auto: true' in text and info['archive'] in text
        page.locator('.modal [data-close]').last.click()
        page.wait_for_selector('[data-dsh-connect]:has-text("更新接入")')
        page.locator('[data-dsh-connect]').click();page.wait_for_selector('#dshApply:not([disabled])')
        with page.expect_response(lambda r:'/api/setup-apply' in r.url) as updated:
            page.locator('#dshApply').click()
        assert updated.value.status==200,updated.value.text()
        page.wait_for_selector('.modal:has-text("接入完成。重新加载")',timeout=30000)
        text=(folder/'dsh/profiles/web/cordis.patch.yml').read_text()
        assert text.count('# BEGIN SuperLcm managed DSH integration')==1
        assert not errors,errors
        browser.close()
    print(json.dumps({'status':'PASS','scenario':'fresh user + repeat update','modelsCalled':0,'profilesTouched':['web'],'screenshots':['/private/tmp/superlcm-dsh-public-card.png','/private/tmp/superlcm-dsh-install-preview.png']},ensure_ascii=False))
finally:
    server.terminate();server.wait(timeout=10)
