import type { Page } from 'playwright';

export function isBlankBrowserUrlLike(url: string) {
  return !url
    || url === 'about:blank'
    || /^(about:newtab|chrome:\/\/new-tab-page|edge:\/\/newtab)/i.test(url)
    || (
      /^data:text\/html/i.test(url)
      && /data-webpilot-embedded-browser|(?:Orbit|WebPilot)(?:%20|\+)Embedded(?:%20|\+)Browser|(?:Orbit|WebPilot) embedded browser/i.test(url)
    );
}

export function isBlankPage(page: Page) {
  return isBlankBrowserUrlLike(page.url());
}
