"""ローカルサイトのUI検証。エラー状態だけ模擬し、実サイトへの認証はしない。"""
import asyncio
import copy
import json
import os
import sys
from pathlib import Path
from datetime import date, timedelta
from playwright.async_api import async_playwright, expect
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from smile_zemi import launch_options, install_verified_transport

BASE = os.environ.get("MANABI_WEB_URL", "http://127.0.0.1:8000")


async def main():
    checks = []
    async with async_playwright() as p:
        options = launch_options() if BASE.startswith('https://') else {'executable_path': '/usr/bin/chromium'}
        browser = await p.chromium.launch(**options, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = await browser.new_context(viewport={"width": 1440, "height": 1000}, device_scale_factor=1, locale='ja-JP', timezone_id='Asia/Tokyo')
        if BASE.startswith('https://'):
            # 公開ダッシュボードのGETのみ。既存CAでTLSを検証し、認証情報は渡さない。
            await install_verified_transport(context)
        page = await context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(type(error).__name__))
        real_state = await (await page.request.get(BASE + '/api/dashboard')).json()
        assert real_state['record'] is not None, '保存された実取得結果が必要です'
        expected_total = str(real_state['record']['total_minutes'])
        day = real_state['record']['date']
        title = '今日の学習' if day == real_state['today'] else '最近の学習'
        await page.goto(BASE)
        await expect(page.locator('.total-number')).to_have_text(expected_total)
        assert len(real_state['history']) >= 1
        checks.append('保存済み実データと元の取得日時を表示')
        await page.screenshot(path='/tmp/manabi-desktop.png', full_page=True)
        await page.get_by_role('button', name='すべて見る', exact=True).click()
        await expect(page.get_by_role('heading', name='取得履歴', exact=True)).to_be_visible()
        await page.get_by_role('button', name='今日の学習に戻る', exact=True).click()
        await expect(page.get_by_role('heading', name=title, exact=True)).to_be_visible()
        checks.append('履歴ナビ・すべて見る・戻るが動作')

        for width in [390, 320]:
            await page.set_viewport_size({'width': width, 'height': 844})
            assert await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            await expect(page.locator('.subject-row')).to_have_count(len(real_state['record']['subjects'] or {}))
            if width == 390:
                await page.screenshot(path='/tmp/manabi-mobile.png', full_page=True)
        checks.append('390px・320pxの画面に横はみ出しがない')

        await page.set_viewport_size({'width': 1440, 'height': 1000})
        test_state = copy.deepcopy(real_state)
        test_state.update(retry_after_seconds=0, next_refresh_at=None, error=None, refreshing=False, credentials_ready=True, refresh_mode='manual')
        get_count = 0
        async def dashboard(route):
            nonlocal get_count
            get_count += 1
            await route.fulfill(json=test_state)
        await page.route('**/api/dashboard', dashboard)
        post_count = 0
        async def failed_refresh(route):
            nonlocal post_count
            post_count += 1
            await asyncio.sleep(0.5)
            failed = {**test_state, 'error': {'title': 'ログインを確認できませんでした', 'message': '時間をおいて更新してください。', 'stage': 'authentication'}, 'retry_after_seconds': 600}
            await route.fulfill(status=502, json=failed)
        await page.route('**/api/refresh', failed_refresh)
        await page.reload()
        button = page.get_by_role('button', name='学習時間を更新', exact=True)
        await expect(button).to_be_enabled()
        await button.click()
        await expect(page.get_by_role('button', name='学習時間を取得中', exact=True)).to_be_disabled()
        # DOMから重複clickを送ってもdisabledとフックの排他で再送されない。
        await page.locator('.refresh-button').evaluate('(button) => {button.click();button.click();}')
        await expect(page.get_by_text('ログインを確認できませんでした', exact=True)).to_be_visible()
        await expect(page.locator('.total-number')).to_have_text(expected_total)
        await expect(page.get_by_role('button', name='学習時間を更新', exact=True)).to_be_disabled()
        assert post_count == 1
        checks.append('模擬502後も前回値・日時を保持し、連打でもPOST1回だけ')
        await page.unroute('**/api/refresh', failed_refresh)

        test_state['record'] = None
        test_state['history'] = []
        await page.reload()
        await expect(page.locator('.total-number')).to_have_text('—')
        await expect(page.get_by_text('取得した記録はまだありません。', exact=True)).to_be_visible()
        checks.append('空記録で架空の0分・履歴を表示しない')

        test_state['record'] = {**real_state['record'], 'subjects': None}
        await page.reload()
        await expect(page.locator('.subjects-empty')).to_contain_text('教科別の情報は取得されていません。')
        assert await page.locator('.subject-row').count() == 0
        checks.append('教科nullを0分の内訳に変換しない')

        test_state['today'] = (date.fromisoformat(day) + timedelta(days=1)).isoformat()
        await page.reload()
        await expect(page.get_by_role('heading', name='最近の学習', exact=True)).to_be_visible()
        await expect(page.locator('.notice')).to_contain_text('前回取得した')
        checks.append('翌日の表示で過去の記録を今日と誤表示しない')

        test_state['today'] = day
        test_state['credentials_ready'] = False
        await page.reload()
        await expect(page.get_by_role('button', name='学習時間を更新', exact=True)).to_be_disabled()
        await expect(page.get_by_text('更新の準備が必要です', exact=True)).to_be_visible()
        checks.append('認証情報未設定は更新無効と設定案内')
        test_state.update(refresh_mode='saved_records', collection_status='passed', credentials_ready=False)
        await page.reload()
        await expect(page.get_by_role('button', name='表示を更新', exact=True)).to_be_enabled()
        await expect(page.get_by_text('定期的に記録を取得します', exact=True)).to_be_visible()
        previous_gets, previous_posts = get_count, post_count
        await page.route('**/api/refresh', failed_refresh)
        await page.get_by_role('button', name='表示を更新', exact=True).click()
        await expect(page.get_by_role('button', name='表示を更新', exact=True)).to_be_enabled()
        assert get_count == previous_gets + 1
        assert post_count == previous_posts
        await expect(page.locator('.total-number')).to_have_text(expected_total)
        checks.append('無料版の表示更新はGET1回で、認証POSTを送らない')
        assert not errors
        checks.append('ブラウザのJavaScript例外0件')
        await browser.close()
    result = {'method': 'local Playwright Chromium', 'base_url': BASE, 'desktop_viewport': [1440, 1000], 'mobile_viewports': [[390, 844], [320, 844]], 'checks': checks, 'live_authentication_attempts': 0}
    output = 'cloudflare-public-browser.json' if BASE.startswith('https://') else 'web-browser.json' if BASE == 'http://127.0.0.1:8000' else 'cloudflare-browser.json'
    Path('verification-results', output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    asyncio.run(main())
