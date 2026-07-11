/**
 * tests/helpers/doctor-root.mjs — pin CONSTRUCT_DOCTOR_ROOT to a fresh tmpdir.
 *
 * The machine-scoped state axis (lib/config/xdg.mjs doctorRoot) resolves from
 * CONSTRUCT_DOCTOR_ROOT, then XDG_STATE_HOME/HOME — the real process env. Any
 * in-process code that writes through a doctorRoot default (the canonical
 * offender: Broker's default auditRecorder → lib/audit-trail.mjs) lands in the
 * developer's real ~/.local/state/construct unless the suite pins this var.
 * lib/audit-trail.mjs resolves its default path per call, so pinning at the
 * top of a test file — after imports — is sufficient.
 *
 * Pin process-wide per test FILE, not per test case: node --test runs each
 * file in its own process, so the pin cannot cross-pollute other suites, and
 * restore() puts the prior value back for in-file code that runs after().
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmTmpDir } from './cleanup.mjs';

/**
 * Point CONSTRUCT_DOCTOR_ROOT at a fresh mkdtemp fixture. Returns `{ root,
 * restore }`; call restore() in after() to remove the fixture and put the
 * prior env value back.
 *
 * @param {string} [prefix] tmpdir prefix naming the suite, for post-mortem triage
 * @returns {{ root: string, restore: () => void }}
 */
export function pinDoctorRoot(prefix = 'cx-doctor-root-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const prev = process.env.CONSTRUCT_DOCTOR_ROOT;
  process.env.CONSTRUCT_DOCTOR_ROOT = root;
  return {
    root,
    restore() {
      try { rmTmpDir(root); } catch { /* tmpdir recycler owns leftovers */ }
      if (prev === undefined) delete process.env.CONSTRUCT_DOCTOR_ROOT;
      else process.env.CONSTRUCT_DOCTOR_ROOT = prev;
    },
  };
}
