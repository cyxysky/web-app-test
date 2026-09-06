/* eslint-disable @typescript-eslint/no-require-imports */
const product = require('./product.json');

/** @param {{ prefix?: string | null, text?: string | null }} [input] */
function resolveWorkspaceBrand(input = {}) {
  const prefix = String(input.prefix ?? '').trim().slice(0, 48);
  const text = String(input.text ?? '').trim().slice(0, 48);
  return {
    brandPrefix: /^domp$/i.test(prefix) ? '' : prefix,
    brandText: !text || /^webpilot(?:\s*qa)?$/i.test(text) ? product.name : text,
  };
}

module.exports = { product, resolveWorkspaceBrand };
