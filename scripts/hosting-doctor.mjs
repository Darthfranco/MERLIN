import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function supportedNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor] = match.slice(1).map(Number);
  return major > 22 || (major === 22 && minor >= 16);
}

async function inspectPath(path, kind = 'file') {
  try {
    const details = await stat(path);
    const expected = kind === 'directory' ? details.isDirectory() : details.isFile();
    if (!expected) return { state: 'unexpected type' };
    return { state: 'present', mode: details.mode };
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
}

async function executableAvailable(name, environment, platform) {
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const directory of (environment.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const candidate of names) {
      try {
        const path = join(directory, candidate);
        await access(path, constants.X_OK);
        if ((await stat(path)).isFile()) return true;
      } catch { /* Report presence only; never execute discovered programs. */ }
    }
  }
  return false;
}

/** Read-only presence checks. Never reads .env/data contents or loads app code. */
export async function inspectHosting({ root = ROOT, nodeVersion = process.versions.node,
  platform = process.platform, environment = process.env } = {}) {
  const [server, ws, config, data, voicePython, voiceModel, listener, npm, git] = await Promise.all([
    inspectPath(join(root, 'src/server.js')),
    inspectPath(join(root, 'node_modules/ws/package.json')),
    inspectPath(join(root, '.env')),
    inspectPath(join(root, 'data'), 'directory'),
    inspectPath(join(root, 'local/voice-venv/bin/python')),
    inspectPath(join(root, 'local/voice-model'), 'directory'),
    inspectPath(join(root, 'local/voice-listener-model'), 'directory'),
    executableAvailable('npm', environment, platform),
    executableAvailable('git', environment, platform),
  ]);
  const checks = [
    { status: supportedNode(nodeVersion) ? 'PRESENT' : 'NEEDS ATTENTION', item: 'Node.js', detail: `Runtime ${nodeVersion}; repository requires >=22.16.0. This is not a supported-release or security-update check.` },
    { status: server.state === 'present' ? 'PRESENT' : 'NEEDS ATTENTION', item: 'Assistant entry point', detail: server.state },
    { status: ws.state === 'present' ? 'PRESENT' : 'NEEDS ATTENTION', item: 'Node dependency installation', detail: `ws package manifest ${ws.state}; version/integrity not checked. Install the lockfile with npm ci before running MERLIN.` },
    { status: npm ? 'PRESENT' : 'NOT FOUND', item: 'npm on PATH', detail: 'Executable presence only; no program was launched.' },
    { status: git ? 'PRESENT' : 'NOT FOUND', item: 'Git on PATH', detail: 'Executable presence only; no repository or remote was contacted.' },
    { status: config.state === 'present' ? 'PRESENT' : 'INFO', item: 'Local .env file', detail: `${config.state}; contents were not read. Key configuration and provider access are unverified.` },
    { status: 'INFO', item: 'Inherited Meta key', detail: (environment.META_API_KEY || environment.MODEL_API_KEY) ? 'A key variable is nonempty in this shell; value and validity were not inspected. A service may have a different environment.' : 'No nonempty key variable in this shell. This does not check the .env file or a service environment.' },
    { status: 'INFO', item: 'Private data directory', detail: `${data.state}; no data, lock PID, or directory contents were read. The server uses checkout-root data/ with one writer.` },
    { status: 'INFO', item: 'Optional voice setup', detail: `Default Python ${voicePython.state}; synthesis directory ${voiceModel.state}; detector directory ${listener.state}. Files, dependencies, overrides, audio, and hardware were not validated; see docs/VOICE.md.` },
  ];
  if (platform !== 'win32' && config.state === 'present' && (config.mode & 0o077)) {
    checks.push({ status: 'NEEDS ATTENTION', item: '.env permissions', detail: 'Group or other permission bits are set. Restrict this private configuration to its owner (chmod 600 .env).' });
  }
  if (platform !== 'win32' && data.state === 'present' && (data.mode & 0o077)) {
    checks.push({ status: 'NEEDS ATTENTION', item: 'data/ permissions', detail: 'Group or other permission bits are set. Review owner-only access to this private directory and its existing files.' });
  }
  return checks;
}

export function formatReport(checks) {
  return [
    'MERLIN hosting inspection — read-only',
    'Presence checks only: no network requests, installations, server starts, configuration content reads, or data changes.',
    ...checks.map(check => `[${check.status}] ${check.item}: ${check.detail}`),
    '',
    'Current prototype limits:',
    '- Assistant and demo servers are loopback-only. Hosting templates preserve that boundary.',
    '- Phone-to-assistant synchronization, household sign-in/pairing, and remote device permissions are not implemented.',
    '- No cloud/LAN/public deployment readiness is claimed; a VPN or proxy does not add the missing application features.',
    '- Model calls still use Meta services; hosting the app locally does not make inference offline.',
    'No readiness verdict is issued. This command does not check ports, running processes, backups, disk space, model access, or OS service behavior.',
    'See docs/HOSTING.md and deploy/README.md for options, limitations, and optional templates.',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) {
    console.error('Usage: node scripts/hosting-doctor.mjs (no arguments; does not load .env)');
    process.exitCode = 1;
  } else {
    inspectHosting().then(checks => console.log(formatReport(checks))).catch(() => {
      console.error('Inspection could not complete. No application was started or configuration changed.');
      process.exitCode = 1;
    });
  }
}
