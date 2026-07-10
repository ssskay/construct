/**
 * lib/monitor-cli.mjs — `construct monitor`: one-command setup for
 * continuous monitoring-as-a-role (construct-jvjow.1).
 *
 * Today, wiring up monitoring means hand-assembling three separate schemas
 * across three separate commands: construct.config.json `sources.targets[]`,
 * embed.yaml's `roles{}` block, and `.cx/embed/<id>.manifest.json` (written
 * by `construct embed enable`), then a fourth command `construct embed start`.
 * `runMonitorCli` does all four in one call, reusing the real modules each
 * existing command already calls rather than reimplementing any of them:
 *
 *   1. sources.targets[]  — lib/config/source-targets.mjs
 *      (validateSourceTargets/normalizeConfigTarget/targetsToEmbedSources) +
 *      lib/config/project-config.mjs (loadProjectConfig/writeProjectConfig),
 *      the same functions `construct sources add` calls.
 *   2. embed.yaml roles{} + sources: — lib/embed/config.mjs
 *      (parseEmbedYaml/writeEmbedYaml). The sources: block is regenerated
 *      from the full merged sources.targets[] set via targetsToEmbedSources
 *      so the daemon actually observes what step 1 wrote (the daemon reads
 *      embed.yaml, not construct.config.json, once embed.yaml exists);
 *      provider blocks embed.yaml already had for providers not tracked by
 *      sources.targets are left untouched.
 *   3. .cx/embed/<id>.manifest.json — lib/embed/capability-lifecycle.mjs
 *      enableCapability(), the same function `construct embed enable <id>`
 *      calls. `--as <capability-id>` must already be discoverable
 *      (`construct embed list`) — scope is wiring existing monitoring
 *      pieces together, not authoring new role intelligence (construct-jvjow.2/.3).
 *   4. daemon start — lib/embed/cli.mjs runEmbedCli(['start', ...]), the
 *      same function `construct embed start` calls. `--no-start` skips this
 *      step for dry assembly, CI, and tests. `--supervise` additionally
 *      calls lib/embed/supervision.mjs installSupervision() afterward.
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(args) {
  const flags = { targets: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--as' && args[i + 1]) flags.as = args[++i];
    else if (a === '--targets' && args[i + 1]) flags.targets.push(args[++i]);
    else if (a === '--secondary' && args[i + 1]) flags.secondary = args[++i];
    else if (a === '--config' && args[i + 1]) flags.config = args[++i];
    else if (a === '--no-start') flags.noStart = true;
    else if (a === '--supervise') flags.supervise = true;
  }
  return flags;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'target';
}

function parseTargetSpec(spec, { sourceProviders, getSourceTargetDescriptor }) {
  const parts = spec.split(':');
  const provider = parts[0];
  const value = parts[1];
  const secondary = parts[2];
  if (!provider || !sourceProviders.includes(provider)) {
    throw new Error(`--targets "${spec}": unknown provider "${provider}". Expected one of ${sourceProviders.join(', ')}`);
  }
  if (!value) {
    throw new Error(`--targets "${spec}": expected "<provider>:<value>" (e.g. "github:org/repo")`);
  }
  const descriptor = getSourceTargetDescriptor(provider);
  const selector = { [descriptor.selector.field]: value };
  if (descriptor.secondaryField && secondary) {
    selector[descriptor.secondaryField.field] = secondary;
  }
  return { id: `monitor-${provider}-${slug(value)}`, provider, selector, provenance: `monitor:${spec}` };
}

// embed.yaml provider blocks whose provider now has an entry in
// sources.targets[] are fully regenerated from that source of truth;
// provider blocks for anything not tracked there (manually authored) are
// left as-is.

function mergeEmbedSources(existing, generated) {
  const touched = new Set(generated.map((s) => s.provider));
  return [...existing.filter((s) => !touched.has(s.provider)), ...generated];
}

const USAGE =
  'Usage: construct monitor --as <capability-id> --targets <provider:value>[,<provider:value>...] ' +
  '[--targets <provider:value>...] [--secondary <role>] [--config <path>] [--no-start] [--supervise]\n' +
  'Example: construct monitor --as operations --targets github:acme/api,jira:PLAT\n';

export async function runMonitorCli(args, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const rootDir = opts.rootDir ?? cwd;
  const homeDir = opts.homeDir;
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const errOut = opts.stderr ?? ((s) => process.stderr.write(s));

  const flags = parseArgs(args);
  if (args.includes('--help') || args.includes('-h') || !flags.as || !flags.targets.length) {
    errOut(USAGE);
    process.exitCode = 1;
    return;
  }

  const { validateSourceTargets, normalizeConfigTarget, targetsToEmbedSources, SOURCE_PROVIDERS } =
    await import('./config/source-targets.mjs');
  const { getSourceTargetDescriptor } = await import('./config/source-target-registry.mjs');
  const { loadProjectConfig, writeProjectConfig, findProjectConfigPath, PROJECT_CONFIG_FILENAME } =
    await import('./config/project-config.mjs');
  const { listCapabilities, enableCapability } = await import('./embed/capability-lifecycle.mjs');
  const { parseEmbedYaml, writeEmbedYaml } = await import('./embed/config.mjs');
  const { runEmbedCli } = await import('./embed/cli.mjs');

  const { capabilities } = listCapabilities({ rootDir: cwd });
  const capability = capabilities.find((c) => c.id === flags.as);
  if (!capability) {
    const known = capabilities.map((c) => c.id).sort();
    errOut(`construct monitor: unknown capability "${flags.as}". Available: ${known.length ? known.join(', ') : '(none discovered — see construct embed list)'}\n`);
    process.exitCode = 1;
    return;
  }

  const targetSpecs = flags.targets.flatMap((t) => t.split(',').map((s) => s.trim()).filter(Boolean));
  let parsedTargets;
  try {
    parsedTargets = targetSpecs.map((spec) => parseTargetSpec(spec, { sourceProviders: SOURCE_PROVIDERS, getSourceTargetDescriptor }));
  } catch (err) {
    errOut(`construct monitor: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const normalizedNew = parsedTargets.map((t) => normalizeConfigTarget(t));

  const cfgPath = findProjectConfigPath(cwd) || path.join(cwd, PROJECT_CONFIG_FILENAME);
  const { config } = loadProjectConfig(cwd, process.env);
  const existingTargets = (config.sources?.targets ?? []).map(normalizeConfigTarget);
  const newIds = new Set(normalizedNew.map((t) => t.id));
  // Deterministic ids make re-running with the same --targets idempotent:
  // drop any existing entry sharing an id with the newly parsed set so the
  // merge upserts rather than colliding on validateSourceTargets' duplicate-id check.
  const mergedTargets = [...existingTargets.filter((t) => !newIds.has(t.id)), ...normalizedNew];

  const targetErrors = validateSourceTargets(mergedTargets);
  if (targetErrors.length) {
    errOut(`construct monitor: invalid source targets (${targetErrors.length}):\n`);
    for (const e of targetErrors) errOut(`  - ${e}\n`);
    process.exitCode = 1;
    return;
  }

  writeProjectConfig(cfgPath, { ...config, sources: { ...(config.sources ?? {}), targets: mergedTargets } });

  const embedYamlPath = flags.config ? path.resolve(flags.config) : path.join(cwd, 'embed.yaml');
  const raw = fs.existsSync(embedYamlPath) ? parseEmbedYaml(fs.readFileSync(embedYamlPath, 'utf8')) : {};
  const roleName = capability.manifest.embed.specialist.replace(/^cx-/, '');
  raw.roles = { ...(raw.roles ?? {}), primary: roleName, secondary: flags.secondary ?? raw.roles?.secondary ?? null };
  const generatedSources = targetsToEmbedSources(mergedTargets);
  raw.sources = mergeEmbedSources(raw.sources ?? [], generatedSources);
  writeEmbedYaml(embedYamlPath, raw);

  const enableResult = enableCapability(flags.as, { rootDir: cwd });
  if (!enableResult.ok) {
    errOut(`construct monitor: failed to enable capability "${flags.as}":\n`);
    for (const e of enableResult.errors) errOut(`  - ${e}\n`);
    process.exitCode = 1;
    return;
  }

  let daemon = { started: false };
  if (!flags.noStart) {
    try {
      await runEmbedCli(['start', '--config', embedYamlPath], { rootDir, homeDir });
      daemon = { started: true };
    } catch (err) {
      daemon = { started: false, error: err.message };
    }
  }

  let supervision = null;
  if (flags.supervise && !flags.noStart) {
    try {
      const { installSupervision } = await import('./embed/supervision.mjs');
      supervision = await installSupervision();
    } catch (err) {
      supervision = { error: err.message };
    }
  }

  out('construct monitor: assembled\n');
  out(`  role                   → ${roleName}${flags.secondary ? ` (secondary: ${flags.secondary})` : ''}\n`);
  out(`  capability             → ${flags.as} → .cx/embed/${flags.as}.manifest.json (enabled)\n`);
  out(`  construct.config.json  → ${cfgPath}\n`);
  for (const t of normalizedNew) {
    out(`    + sources.targets[] ${t.id} (${t.provider}: ${JSON.stringify(t.selector)})\n`);
  }
  out(`  embed.yaml             → ${embedYamlPath}\n`);
  out(`    roles.primary = ${roleName}\n`);
  out(`    sources: ${raw.sources.length} provider block(s)\n`);
  if (flags.noStart) {
    out('  daemon                  → not started (--no-start)\n');
  } else if (daemon.started) {
    out('  daemon                  → started\n');
  } else {
    out(`  daemon                  → failed to start: ${daemon.error}\n`);
  }
  if (supervision) {
    out(supervision.error
      ? `  supervision             → failed: ${supervision.error}\n`
      : `  supervision             → ${supervision.method}${supervision.file ? ` (${supervision.file})` : ''}\n`);
  }

  if (!flags.noStart && !daemon.started) {
    process.exitCode = 1;
  }
}
