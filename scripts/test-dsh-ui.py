"""Isolated Chrome check for compaction visibility; no native configs or models."""
import json, os, pathlib, subprocess
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parents[1]
server = subprocess.Popen(['node',str(root/'test/dsh-ui-fixture.mjs')],cwd=root,
    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
    info = json.loads(server.stdout.readline())
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
        page = browser.new_page(viewport={'width':1280,'height':1050},locale='zh-CN')
        errors = []
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(info['url']+'#connect')
        page.wait_for_selector('#tools [data-dsh-check]')
        card = page.locator('#tools .tcard',has_text='DSH')
        assert 'DSH 原生压缩' in card.inner_text()
        assert card.locator('select[data-tool]').count() == 0
        assert page.locator('#tools .tcard',has_text='Codex').get_by_text('当前仅摘要和接续，尚未接管压缩').count() == 1
        page.locator('[data-dsh-check]').click()
        page.wait_for_selector('#dshTitle')
        assert '自动压缩、门槛和模型' in page.locator('.modal').inner_text()
        page.locator('.modal [data-close]').last.click()
        page.locator('.nav [data-view="settings"]').click()
        page.locator('#setNav [data-sec="compact"]').click()
        page.wait_for_selector('#compressionJobs:has-text("正在压缩")')
        server.stdin.write('ready\n');server.stdin.flush()
        page.wait_for_selector('#compressionJobs:has-text("等待替换上下文")',timeout=12000)
        server.stdin.write('committed\n');server.stdin.flush()
        page.wait_for_selector('#compressionJobs:has-text("已替换上下文")',timeout=12000)
        shot = pathlib.Path(os.environ.get('SUPERLCM_TEST_SHOT','/private/tmp/superlcm-dsh-compression.png'))
        page.screenshot(path=str(shot),full_page=True)
        assert not errors,errors
        browser.close()
    print(json.dumps({'status':'PASS','backend':'isolated fixture','browser':'installed Chrome','states':['summarizing','ready','committed'],'screenshot':str(shot)},ensure_ascii=False))
finally:
    server.terminate();server.wait(timeout=10)
