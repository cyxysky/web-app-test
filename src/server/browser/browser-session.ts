import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Locator, Page } from 'playwright';

function allowedHost(url: string) {
  const allowed = (process.env.ALLOWED_TEST_DOMAINS || 'localhost,127.0.0.1,example.com')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const host = new URL(url).hostname;
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitHints(selectorHint?: string) {
  return (selectorHint || '')
    .split(/[|,;/\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function looksLikeSelector(value: string) {
  return (
    value.startsWith('#') ||
    value.startsWith('.') ||
    value.startsWith('[') ||
    value.startsWith('//') ||
    value.includes('=') ||
    /^[a-z][\w-]*(\[|\.|#|:|\s)/i.test(value)
  );
}

export type BrowserActionResult = {
  ok: boolean;
  actual: string;
};

export class BrowserSession {
  private browser?: Browser;
  private page?: Page;
  private consoleErrors: string[] = [];
  private networkErrors: string[] = [];

  async start() {
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({
      headless: process.env.HEADLESS_BROWSER !== 'false',
    });
    this.page = await this.browser.newPage({ viewport: { width: 1440, height: 960 } });
    this.page.setDefaultTimeout(8000);
    this.page.on('console', (message) => {
      if (message.type() === 'error') this.consoleErrors.push(message.text());
    });
    this.page.on('requestfailed', (request) => {
      this.networkErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
    });
  }

  private get activePage() {
    if (!this.page) throw new Error('Browser session has not started');
    return this.page;
  }

  async open(url: string) {
    if (!allowedHost(url)) {
      throw new Error(`Navigation blocked by domain allowlist: ${url}`);
    }
    await this.activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  async readPageText() {
    return this.activePage.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  }

  async takeScreenshot(runId: string, stepIndex: number) {
    const dir = path.join(process.cwd(), 'artifacts', runId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `step-${stepIndex}.png`);
    await this.activePage.screenshot({ path: filePath, fullPage: true });
    return filePath;
  }

  async click(selectorHint?: string): Promise<BrowserActionResult> {
    const target = await this.findInteractiveLocator(selectorHint, ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem']);
    if (!target) return { ok: false, actual: `没有找到可点击元素：${selectorHint || '未提供选择器'}` };
    await target.click();
    await this.waitAfterAction();
    return { ok: true, actual: `已点击元素：${selectorHint || '自动识别的可点击元素'}` };
  }

  async fill(selectorHint: string | undefined, input: string): Promise<BrowserActionResult> {
    const target = await this.findInteractiveLocator(selectorHint, ['textbox', 'combobox', 'searchbox']);
    if (!target) return { ok: false, actual: `没有找到可输入元素：${selectorHint || '未提供选择器'}` };
    await target.fill(input);
    await this.waitAfterAction();
    return { ok: true, actual: `已输入文本：${input}` };
  }

  async select(selectorHint: string | undefined, input: string): Promise<BrowserActionResult> {
    const target = await this.findLocator(selectorHint);
    if (!target) return { ok: false, actual: `没有找到下拉元素：${selectorHint || '未提供选择器'}` };
    await target.selectOption({ label: input }).catch(async () => target.selectOption(input));
    await this.waitAfterAction();
    return { ok: true, actual: `已选择选项：${input}` };
  }

  async press(selectorHint: string | undefined, input: string): Promise<BrowserActionResult> {
    const target = (await this.findLocator(selectorHint)) || this.activePage.locator('body');
    await target.press(input);
    await this.waitAfterAction();
    return { ok: true, actual: `已按键：${input}` };
  }

  async assertVisibleText(expected: string): Promise<BrowserActionResult> {
    const pageText = await this.readPageText();
    const ok = pageText.toLowerCase().includes(expected.toLowerCase());
    return {
      ok,
      actual: ok ? `页面包含预期文本：${expected}` : `页面未找到预期文本。当前可读文本约 ${pageText.length} 字符。`,
    };
  }

  async waitForPage(): Promise<BrowserActionResult> {
    await this.activePage.waitForLoadState('domcontentloaded');
    await this.activePage.waitForTimeout(500);
    return { ok: true, actual: '页面等待完成' };
  }

  getConsoleErrors() {
    return this.consoleErrors;
  }

  getNetworkErrors() {
    return this.networkErrors;
  }

  async close() {
    await this.browser?.close();
  }

  private async waitAfterAction() {
    await this.activePage.waitForLoadState('domcontentloaded').catch(() => undefined);
    await this.activePage.waitForTimeout(350);
  }

  private async findInteractiveLocator(selectorHint: string | undefined, roles: string[]) {
    const byHint = await this.findLocator(selectorHint);
    if (byHint) return byHint;

    for (const role of roles) {
      const locator = this.activePage.getByRole(role as never).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }

    return undefined;
  }

  private async findLocator(selectorHint?: string) {
    const hints = splitHints(selectorHint);

    for (const hint of hints) {
      const locator = await this.locatorFromHint(hint);
      if (locator && (await locator.isVisible().catch(() => false))) return locator;
    }

    return undefined;
  }

  private async locatorFromHint(hint: string): Promise<Locator | undefined> {
    const page = this.activePage;
    const candidates: Locator[] = [];
    const name = new RegExp(escapeRegExp(hint), 'i');

    if (looksLikeSelector(hint)) {
      candidates.push(page.locator(hint).first());
    }

    candidates.push(
      page.getByLabel(name).first(),
      page.getByPlaceholder(name).first(),
      page.getByText(name).first(),
      page.getByRole('button', { name }).first(),
      page.getByRole('link', { name }).first(),
      page.getByRole('textbox', { name }).first(),
      page.getByRole('checkbox', { name }).first(),
      page.getByRole('combobox', { name }).first(),
    );

    for (const locator of candidates) {
      if ((await locator.count().catch(() => 0)) > 0) return locator;
    }

    return undefined;
  }
}
