import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  path.join(projectRoot, 'src/app/styles/foundation.css'),
  path.join(projectRoot, 'src/app/styles/shared-base.css'),
  path.join(projectRoot, 'src/app/styles/domains/chat-base.css'),
  path.join(projectRoot, 'src/app/styles/domains/settings-base.css'),
  path.join(projectRoot, 'src/app/styles/workspace-shared.css'),
  path.join(projectRoot, 'src/app/styles/domains/chat.css'),
  path.join(projectRoot, 'src/app/styles/domains/settings.css'),
  path.join(projectRoot, 'src/app/styles/domains/automation.css'),
  path.join(projectRoot, 'src/app/styles/domains/embedded-browser.css'),
];
const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const root = postcss.parse(source);
const mediaQueries = new Set();
const containerQueries = new Set();
const selectors = new Set();

root.walkAtRules((rule) => {
  if (rule.name === 'media') mediaQueries.add(rule.params);
  if (rule.name === 'container') containerQueries.add(rule.params);
});
root.walkRules((rule) => selectors.add(rule.selector));

const requiredMediaWidths = [360, 440, 680, 1024];
const missingMediaWidths = requiredMediaWidths.filter((width) => (
  ![...mediaQueries].some((query) => query.includes(`max-width: ${width}px`))
));
const requiredContainers = [
  'automation-main (max-width: 480px)',
  'automation-main (max-width: 760px)',
  'browser-chat-main (max-width: 760px)',
];
const missingContainers = requiredContainers.filter((query) => !containerQueries.has(query));
const requiredSelectors = [
  '.ui-floating-layer',
  '.browser-chat-mobile-history-bar',
  '.browser-chat-recent-panel.is-mobile-open',
];
const missingSelectors = requiredSelectors.filter((requiredSelector) => (
  ![...selectors].some((selector) => selector.split(',').map((part) => part.trim()).includes(requiredSelector))
));

if (missingMediaWidths.length || missingContainers.length || missingSelectors.length) {
  if (missingMediaWidths.length) console.error(`Missing viewport guards: ${missingMediaWidths.join(', ')}`);
  if (missingContainers.length) console.error(`Missing container guards: ${missingContainers.join(', ')}`);
  if (missingSelectors.length) console.error(`Missing responsive selectors: ${missingSelectors.join(', ')}`);
  process.exit(1);
}

console.log('Responsive UI guards OK: 320/375/430/768/1024 widths are covered by the phone, tablet, and container rules.');
