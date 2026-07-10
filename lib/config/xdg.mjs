/**
 * lib/config/xdg.mjs — single source of truth for Construct's user-scope base
 * directories, following the XDG Base Directory specification.
 *
 * Keeps config (versionable settings), state (durable runtime data), and cache
 * (regenerable transients) on separate roots so each can be backed up, synced,
 * and pruned independently:
 *
 *   configDir() → $XDG_CONFIG_HOME/construct  (default ~/.config/construct)
 *   stateDir()  → $XDG_STATE_HOME/construct   (default ~/.local/state/construct)
 *   cacheDir()  → $XDG_CACHE_HOME/construct   (default ~/.cache/construct)
 *
 * Per the XDG spec, an env var is honored only when it is set AND absolute;
 * a relative or empty value is ignored and the default applies. Every helper
 * takes an optional homeDir for testability, mirroring the existing homeDir
 * params across the codebase.
 *
 * Clean break: there is no legacy `~/.construct/*` read here. Existing installs
 * re-run `construct install --footprint=user` to repopulate at the XDG paths
 * (ADR-0071 renamed --scope to --footprint; --scope keeps working).
 */
import os from 'node:os';
import path from 'node:path';

// Leaf segment appended under each resolved base.

const APP = 'construct';

// XDG honors an env override only when it names an absolute path; anything
// relative or empty falls through to the spec default so a stray cwd-relative
// value can never relocate user state under the process working directory.

function resolveBase(envValue, fallbackSegments, homeDir) {
  if (typeof envValue === 'string' && path.isAbsolute(envValue)) {
    return envValue;
  }
  return path.join(homeDir, ...fallbackSegments);
}

export function configDir(homeDir = os.homedir(), env = process.env) {
  const base = resolveBase(env.XDG_CONFIG_HOME, ['.config'], homeDir);
  return path.join(base, APP);
}

export function stateDir(homeDir = os.homedir(), env = process.env) {
  const base = resolveBase(env.XDG_STATE_HOME, ['.local', 'state'], homeDir);
  return path.join(base, APP);
}

// The global doctor/telemetry/runtime axis (formerly rooted at ~/.cx) now
// resolves to the XDG state dir. CONSTRUCT_DOCTOR_ROOT, shared by the
// telemetry/doctor/oracle ecosystem for test isolation, still wins when set to
// a non-empty value; otherwise stateDir() supplies the durable default.

export function doctorRoot(homeDir = os.homedir(), env = process.env) {
  const override = env.CONSTRUCT_DOCTOR_ROOT;
  if (typeof override === 'string' && override.trim()) return override;
  return stateDir(homeDir, env);
}

export function cacheDir(homeDir = os.homedir(), env = process.env) {
  const base = resolveBase(env.XDG_CACHE_HOME, ['.cache'], homeDir);
  return path.join(base, APP);
}
