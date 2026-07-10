/**
 * lib/orchestration/routing-tables.mjs — declarative routing resolver.
 *
 * Reads specialist subscriptions, doc-artifact ownership, and watch-condition
 * references from specialists/org (with optional .cx/specialists/
 * overlays) and exposes the forward lookups the orchestration layer needs.
 *
 * The resolver is the single source of truth for event/doc/watch routing.
 * Projects override routing without patching library code by dropping JSON
 * files into .cx/specialists/ — each overlay's fields apply over the
 * canonical registry entry for the same specialist.
 *
 * Watch conditions are referenced by name. The implementations live in
 * WATCHERS below — small predicates over the requestSignals shape. The
 * registry decides WHICH specialist a named watcher routes to; this file
 * decides WHAT condition triggers it. Project overlays can re-bind a
 * watcher's specialist; adding a brand-new watcher requires code.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../project-root.mjs';
import { loadRegistry, clearCache } from '../registry/loader.mjs';

// Watch-condition predicates. Each is a pure function from requestSignals
// (see orchestration-policy.requestSignals) to boolean. Registry entries
// reference these by key. Keep predicates small and side-effect free.

const WATCHERS = {
  'high-ambiguity-deep-work': (s) =>
    s.ambiguityScore > 0.5 && s.workCategory === 'deep',
  'visual-or-ui-risk': (s) =>
    Boolean(s.visualDeliverable) || Boolean(s.riskFlags?.ui),
  'auth-payments-non-narrow': (s) =>
    Boolean(s.authOrPayments) && s.blastRadius !== 'narrow',
  'architecture-without-metric': (s) =>
    Boolean(s.riskFlags?.architecture) && !s.hasSuccessMetric,
  'wide-blast-radius': (s) => s.blastRadius === 'wide',
  'named-cost-constraint': (s) => Boolean(s.hasNamedConstraints) && Boolean(s.cost),
};

let cache = null;

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function loadOverlays() {
  const root = findProjectRoot();
  if (!root) return [];
  const overlayDir = join(root, '.cx', 'specialists');
  if (!existsSync(overlayDir)) return [];
  const out = [];
  for (const name of readdirSync(overlayDir)) {
    if (!name.endsWith('.json')) continue;
    const data = readJsonSafe(join(overlayDir, name));
    if (data && typeof data === 'object') out.push(data);
  }
  return out;
}

function buildTables() {
  clearCache();
  const registry = loadRegistry();
  if (!registry || typeof registry.specialists !== 'object') {
    throw new Error('routing-tables: assembled registry missing or malformed');
  }

  // Forward maps. Last writer wins for overlays; the resolver validates
  // duplicate ownership inside the canonical registry, so a project overlay
  // is the only way to re-bind a single event/doc/watcher.

  const eventToOwner = new Map();
  const docToOwner = new Map();
  const watcherToOwner = new Map();
  const watcherToReason = new Map();

  const errors = [];

  function apply(entry, source) {
    const cxId = entry.name?.startsWith('cx-') ? entry.name : `cx-${entry.name}`;
    if (Array.isArray(entry.events || entry.subscriptions)) {
      for (const event of (entry.events || entry.subscriptions)) {
        if (eventToOwner.has(event) && eventToOwner.get(event) !== cxId && source === 'registry') {
          errors.push(`duplicate event ownership: ${event} → ${eventToOwner.get(event)} vs ${cxId}`);
        }
        eventToOwner.set(event, cxId);
      }
    }
    if (Array.isArray(entry.docArtifacts)) {
      for (const docType of entry.docArtifacts) {
        if (docToOwner.has(docType) && docToOwner.get(docType) !== cxId && source === 'registry') {
          errors.push(`duplicate doc ownership: ${docType} → ${docToOwner.get(docType)} vs ${cxId}`);
        }
        docToOwner.set(docType, cxId);
      }
    }
    if (Array.isArray(entry.watchConditions)) {
      for (const watch of entry.watchConditions) {
        const name = typeof watch === 'string' ? watch : watch.watcher;
        const reason = typeof watch === 'string' ? null : watch.reason;
        if (!WATCHERS[name]) {
          errors.push(`unknown watchCondition: ${name} (referenced by ${cxId})`);
          continue;
        }
        watcherToOwner.set(name, cxId);
        if (reason) watcherToReason.set(name, reason);
      }
    }
  }

  for (const entry of Object.values(registry.specialists)) apply(entry, 'registry');
  for (const overlay of loadOverlays()) apply(overlay, 'overlay');

  if (errors.length > 0) {
    throw new Error(`routing-tables: ${errors.join('; ')}`);
  }

  return {
    eventToOwner,
    docToOwner,
    watcherToOwner,
    watcherToReason,
  };
}

function tables() {
  if (!cache) cache = buildTables();
  return cache;
}

export function ownerForEvent(eventType) {
  if (!eventType) return null;
  return tables().eventToOwner.get(eventType) ?? null;
}

export function ownerForDoc(docType) {
  if (!docType) return null;
  return tables().docToOwner.get(docType) ?? null;
}

export function evaluateWatchConditions(signals) {
  const triggers = [];
  const t = tables();
  for (const [name, predicate] of Object.entries(WATCHERS)) {
    const owner = t.watcherToOwner.get(name);
    if (!owner) continue;
    if (!predicate(signals)) continue;
    triggers.push({
      specialist: owner,
      reason: t.watcherToReason.get(name) ?? name,
      watcher: name,
    });
  }
  return triggers;
}

export function knownEventTypes() {
  return Array.from(tables().eventToOwner.keys());
}

export function knownDocTypes() {
  return Array.from(tables().docToOwner.keys());
}

export function knownWatchers() {
  return Object.keys(WATCHERS);
}

/**
 * Get the team id for a specialist.
 * Returns the team id or null if specialist not found.
 */
export function teamForSpecialist(specialistId) {
  if (!specialistId) return null;
  const registry = loadRegistry();
  if (!registry?.specialists) return null;
  const cxId = specialistId.startsWith('cx-') ? specialistId : `cx-${specialistId}`;
  return registry.specialists[cxId]?.team || null;
}

/**
 * Get all specialists in a team.
 * Returns array of specialist ids (with cx- prefix).
 */
export function specialistsInTeam(teamId) {
  if (!teamId) return [];
  const registry = loadRegistry();
  if (!registry?.specialists) return [];
  return Object.entries(registry.specialists)
    .filter(([, s]) => s.team === teamId)
    .map(([id]) => id);
}

/**
 * Get team definition by id.
 * Returns team object or null if not found.
 */
export function getTeamById(teamId) {
  if (!teamId) return null;
  const registry = loadRegistry();
  return registry?.teams?.[teamId] || null;
}

export function _resetCache() {
  cache = null;
}
