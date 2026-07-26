import 'dotenv/config'
import { chromium, type Cookie, type Page } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import type { DouyinCookie, SameSite } from './types/douyin-cookie'
import type { Yiyan } from './types/yiyan'

const DOUYIN_COOKIE_KEY = 'DOUYIN_COOKIE'
const DOUYIN_TARGET_NAMES_KEY = 'DOUYIN_TARGET_NAMES'
const DOUYIN_TARGET_IDS_KEY = 'DOUYIN_TARGET_IDS'
const YIYAN_INCLUDE_SOURCE_KEY = 'YIYAN_INCLUDE_SOURCE'
const FAILURE_SCREENSHOT_PATH = 'artifacts/failure-screenshot.png'

/**
 * 启动本机 Chrome 浏览器并携带 Cookie 访问抖音聊天页。
 *
 * @returns 页面自动化任务完成后返回。
 */
async function main(): Promise<void> {
  const browserPath = resolveBrowserPath()
  const headless = resolveHeadless()
  const pauseAfterPageOpen = resolvePauseAfterPageOpen()
  const autoClose = resolveAutoClose()
  const includeYiyanSource = resolveYiyanIncludeSource()
  const douyinCookies = resolveDouyinCookies()
  const targetNames = resolveDouyinTargets(DOUYIN_TARGET_NAMES_KEY)
  const targetIds = resolveDouyinTargets(DOUYIN_TARGET_IDS_KEY)

  if (targetNames.length === 0 && targetIds.length === 0) {
    throw new Error(`请至少配置 ${DOUYIN_TARGET_NAMES_KEY} 或 ${DOUYIN_TARGET_IDS_KEY}`)
  }

  const yiyans = await resolveYiyans()
  const browser = await chromium.launch({
    headless,
    ...(browserPath ? { executablePath: browserPath } : {}),
  })
  let page: Page | undefined

  try {
    const context = await browser.newContext()
    await context.addCookies(douyinCookies)

    page = await context.newPage()
    await page.goto('https://www.douyin.com/chat', {
      waitUntil: 'domcontentloaded',
    })

    if (pauseAfterPageOpen) {
      const readline = createInterface({
        input,
        output,
      })

      await readline.question('抖音聊天页已打开，按回车键继续执行...')
      readline.close()
    }

    await page.waitForTimeout(10000)

    const searchInput = page.locator('input.semi-input[placeholder="搜索"]').first()
    await searchInput.waitFor({ state: 'visible', timeout: 10000 })

    const names = new Set(targetNames)

    for (const targetId of targetIds) {
      const name = await getDouyinNicknameById(page, targetId)

      if (!name) {
        throw new Error(`抖音号不存在：${targetId}`)
      }

      console.log(`查询到抖音号 ${targetId} 对应昵称：${name}`)
      names.add(name)
    }

    for (const name of names) {
      console.log(`开始搜索会话：${name}`)
      await searchInput.fill('')
      await searchInput.fill(name)
      await page.waitForTimeout(1000)

      const searchResult = page
        .locator('.SearchPanelitembox')
        .filter({
          has: page.getByText(name, { exact: true }),
        })
        .first()

      if (!(await searchResult.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.log(`找不到搜索结果，已跳过：${name}`)
        continue
      }

      await searchResult.getByText(/^(发消息|发私信)$/).click({ timeout: 5000 })
      console.log(`已打开私信：${name}`)

      const editorInput = page
        .locator(
          '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]',
        )
        .first()
      await editorInput.waitFor({ state: 'visible', timeout: 10000 })
      await editorInput.click()
      const yiyan = pickRandomYiyan(yiyans)
      const message = includeYiyanSource ? `${yiyan.hitokoto}\n——「${yiyan.from}」` : yiyan.hitokoto
      await page.keyboard.insertText(message)
      await page.keyboard.press('Enter')
      console.log(`已发送消息：${name}`)
      await page.waitForTimeout(1000)
    }

    await page.waitForTimeout(5000)

    if (!autoClose) {
      const readline = createInterface({
        input,
        output,
      })

      await readline.question('Chrome 已打开抖音聊天页，按回车键关闭浏览器...')
      readline.close()
    }
  } catch (error) {
    await captureFailureScreenshot(page)
    throw error
  } finally {
    // 无论任务是否失败，都关闭浏览器以释放 Playwright 持有的进程句柄。
    await browser.close()
  }
}

/**
 * 通过抖音页面内的搜索接口精确查询抖音号对应的用户名。
 *
 * @param page 已打开并登录抖音的 Playwright 页面。
 * @param douyinId 要查询的抖音号。
 * @returns 找到完全匹配的用户时返回用户名，否则返回 null。
 */
async function getDouyinNicknameById(page: Page, douyinId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    type SearchUser = {
      nickname?: unknown
      unique_id?: unknown
      short_id?: unknown
    }
    type SearchItem = SearchUser & {
      user_info?: SearchUser
    }

    const params = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      pc_client_type: '1',
      cookie_enabled: 'true',
      keyword: id,
      search_channel: 'aweme_user_web',
      search_source: 'switch_tab',
      query_correct_type: '1',
      is_filter_search: '0',
      from_group_id: '',
      disable_rs: '0',
      offset: '0',
      count: '20',
      need_filter_settings: '1',
      list_type: 'single',
      version_code: '170400',
      version_name: '17.4.0',
    })
    const response = await fetch(`/aweme/v1/web/discover/search/?${params.toString()}`, {
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    })

    if (!response.ok) {
      throw new Error(`抖音接口请求失败：HTTP ${response.status}`)
    }

    const data = (await response.json()) as {
      status_code?: number
      status_msg?: string
      user_list?: SearchItem[]
    }

    if (data.status_code !== 0) {
      throw new Error(
        `抖音接口返回异常：${JSON.stringify({
          status_code: data.status_code,
          status_msg: data.status_msg,
        })}`,
      )
    }

    const user = (data.user_list ?? [])
      .map((item) => item.user_info ?? item)
      .find((item) => String(item.unique_id ?? '') === id || String(item.short_id ?? '') === id)

    return user ? String(user.nickname ?? '') : null
  }, douyinId)
}

/**
 * 在页面仍可访问时保存失败现场，且不让截图错误覆盖原始任务异常。
 */
async function captureFailureScreenshot(page: Page | undefined): Promise<void> {
  if (!page || page.isClosed()) {
    return
  }

  try {
    await mkdir('artifacts', { recursive: true })
    await page.screenshot({
      path: FAILURE_SCREENSHOT_PATH,
      fullPage: true,
    })
    console.log(`已保存失败截图：${FAILURE_SCREENSHOT_PATH}`)
  } catch (error) {
    console.error('保存失败截图失败:', error)
  }
}

/**
 * 解析 Playwright 可选的浏览器启动路径。
 */
function resolveBrowserPath(): string | undefined {
  const browserPathFromEnv = process.env.PLAYWRIGHT_BROWSER_PATH?.trim()

  if (browserPathFromEnv) {
    return browserPathFromEnv
  }

  return undefined
}

/**
 * 解析 Playwright 是否使用无头模式。
 */
function resolveHeadless(): boolean {
  const headless = process.env.PLAYWRIGHT_HEADLESS?.trim().toLowerCase()

  if (!headless) {
    return true
  }

  if (headless === 'true') {
    return true
  }

  if (headless === 'false') {
    return false
  }

  throw new Error('PLAYWRIGHT_HEADLESS 只能配置为 true 或 false')
}

/**
 * 解析打开抖音聊天页后是否暂停后续步骤。
 *
 * @returns 需要等待用户按回车键时返回 true，否则返回 false。
 */
function resolvePauseAfterPageOpen(): boolean {
  const pauseAfterPageOpen = process.env.PAUSE_AFTER_PAGE_OPEN?.trim().toLowerCase()

  if (!pauseAfterPageOpen || pauseAfterPageOpen === 'false') {
    return false
  }

  if (pauseAfterPageOpen === 'true') {
    return true
  }

  throw new Error('PAUSE_AFTER_PAGE_OPEN 只能配置为 true 或 false')
}

/**
 * 解析脚本结束后是否自动关闭浏览器。
 */
function resolveAutoClose(): boolean {
  const autoClose = process.env.AUTO_CLOSE?.trim().toLowerCase()

  if (!autoClose) {
    return true
  }

  if (autoClose === 'true') {
    return true
  }

  if (autoClose === 'false') {
    return false
  }

  throw new Error('AUTO_CLOSE 只能配置为 true 或 false')
}

/**
 * 解析发送一言时是否携带出处。
 */
function resolveYiyanIncludeSource(): boolean {
  const includeSource = process.env[YIYAN_INCLUDE_SOURCE_KEY]?.trim().toLowerCase()

  if (!includeSource || includeSource === 'true') {
    return true
  }

  if (includeSource === 'false') {
    return false
  }

  throw new Error(`${YIYAN_INCLUDE_SOURCE_KEY} 只能配置为 true 或 false`)
}

/**
 * 解析抖音访问需要携带的 Cookie。
 */
function resolveDouyinCookies(): Cookie[] {
  const douyinCookieText = process.env[DOUYIN_COOKIE_KEY]?.trim()

  if (!douyinCookieText) {
    throw new Error(`请设置环境变量 ${DOUYIN_COOKIE_KEY}，或在 .env 中配置 ${DOUYIN_COOKIE_KEY}`)
  }

  const douyinCookies = JSON.parse(douyinCookieText) as DouyinCookie[]

  if (!Array.isArray(douyinCookies)) {
    throw new Error(`${DOUYIN_COOKIE_KEY} 必须是 Cookie 数组 JSON 字符串`)
  }

  return douyinCookies.map(toPlaywrightCookie)
}

/**
 * 解析可选的抖音目标数组。
 *
 * @param key 环境变量名称。
 * @returns 未配置时返回空数组，否则返回去除首尾空白后的非空字符串数组。
 */
function resolveDouyinTargets(key: string): string[] {
  const targetsText = process.env[key]?.trim()

  if (!targetsText) {
    return []
  }

  const targets = JSON.parse(targetsText) as string[]

  if (
    !Array.isArray(targets) ||
    targets.some((target) => typeof target !== 'string' || !target.trim())
  ) {
    throw new Error(`${key} 必须是字符串数组 JSON`)
  }

  return targets.map((target) => target.trim())
}

/**
 * 解析一言数据列表。
 */
async function resolveYiyans(): Promise<Yiyan[]> {
  const yiyanText = await readFile('assets/yiyan.json', 'utf8')
  const yiyans = JSON.parse(yiyanText) as Yiyan[]

  if (!Array.isArray(yiyans) || yiyans.length === 0) {
    throw new Error('assets/yiyan.json 必须是非空数组')
  }

  return yiyans
}

/**
 * 从一言数据中随机挑选一条。
 */
function pickRandomYiyan(yiyans: Yiyan[]): Yiyan {
  return yiyans[Math.floor(Math.random() * yiyans.length)]
}

/**
 * 将抖音 Cookie 数据转换为 Playwright Cookie 数据。
 */
function toPlaywrightCookie(cookie: DouyinCookie): Cookie {
  const playwrightCookie: Cookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session ? -1 : (cookie.expirationDate ?? -1),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: toPlaywrightSameSite(cookie.sameSite),
  }

  return playwrightCookie
}

/**
 * 将抖音 Cookie 的 SameSite 值转换为 Playwright Cookie 值。
 */
function toPlaywrightSameSite(sameSite: SameSite | null): Cookie['sameSite'] {
  if (sameSite === 'no_restriction') {
    return 'None'
  }

  return 'Lax'
}

main().catch((error: unknown) => {
  console.error('启动 Chrome 访问抖音聊天页失败:', error)
  process.exitCode = 1
})
