/**
 * lib/orchestration/signal-dimensions.mjs — registry-declared request-signal
 * dimensions consumed by requestSignals() in flow-selection.mjs.
 *
 * Each dimension is a { key, keywords } pair: a plain keyword match over the
 * lowercased request text, producing a boolean field on the requestSignals()
 * output keyed by `key`. Adding a new dimension means adding an entry here
 * (or dropping a project overlay JSON into .cx/orchestration/) — no edit to
 * requestSignals() or any other core function. Mirrors the WATCHERS overlay
 * convention in routing-tables.mjs: canonical entries first, project overlay
 * entries appended, last-writer-wins on a duplicate key.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../project-root.mjs';

const CANONICAL_DIMENSIONS = [
  {
    key: 'cost',
    keywords: ['budget', 'cost', 'pricing', 'spend', 'expense', 'financial', 'revenue', 'roi', 'billing'],
  },
  {
    key: 'compliance',
    keywords: ['compliance', 'regulation', 'regulatory', 'gdpr', 'hipaa', 'soc2', 'soc 2', 'licensing', 'legal', 'contract terms'],
  },
  {
    key: 'accessibility',
    keywords: ['accessibility', 'a11y', 'wcag', 'screen reader', 'aria', 'contrast ratio', 'keyboard navigation'],
  },
  {
    key: 'data',
    keywords: ['quantitative', 'dataset', 'sample size', 'statistical', 'data quality', 'data pipeline', 'metrics warehouse'],
  },
  {
    key: 'reliability',
    keywords: ['reliability', 'uptime', 'sla', 'p95', 'p99', 'failover', 'retry budget', 'error budget', 'incident'],
  },
  {
    key: 'privacy',
    keywords: ['privacy', 'pii', 'personal data', 'consent', 'data retention', 'anonymize', 'redact'],
  },
];

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function loadOverlay() {
  const root = findProjectRoot();
  if (!root) return [];
  const overlayPath = join(root, '.cx', 'orchestration', 'signal-dimensions.json');
  if (!existsSync(overlayPath)) return [];
  const data = readJsonSafe(overlayPath);
  if (!Array.isArray(data)) return [];
  return data.filter((entry) => entry && typeof entry.key === 'string' && Array.isArray(entry.keywords));
}

let cache = null;

export function loadSignalDimensions() {
  if (cache) return cache;
  const byKey = new Map();
  for (const dim of CANONICAL_DIMENSIONS) byKey.set(dim.key, dim);
  for (const dim of loadOverlay()) byKey.set(dim.key, dim);
  cache = Array.from(byKey.values());
  return cache;
}

export function clearSignalDimensionsCache() {
  cache = null;
}
