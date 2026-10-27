import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const git = (...args) => execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024 });
const lines = (buffer) => buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
const paths = [
  ...new Set(
    git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
      .toString()
      .split('\0')
      .filter(Boolean),
  ),
];
const findings = [];
const personalPaths = [];
let scannedText = 0,
  scannedCompressed = 0,
  binaryFiles = 0;
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{40,255})\b/g],
  ['hugging-face-token', /\bhf_[A-Za-z0-9]{30,}\b/g],
  ['openai-token', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['credential-in-url', /\b(?:https?|postgres(?:ql)?|mysql):\/\/[^\s/:<>"']+:[^\s/@<>"']{8,}@/g],
  [
    'assigned-credential',
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b["']?\s*[:=]\s*["']([A-Za-z0-9_+\/-]{20,})["']/gi,
  ],
];

function scan(bytes, source, file) {
  if (file.endsWith('.gz')) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
      scannedCompressed++;
    } catch {
      findings.push({ kind: 'unreadable-compressed-file', source, file });
      return;
    }
  }
  if (bytes.includes(0)) {
    binaryFiles++;
    return;
  }
  scannedText++;
  const value = bytes.toString('utf8');
  for (const [kind, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      findings.push({ kind, source, file, line: value.slice(0, match.index).split('\n').length });
    }
  }
  const pattern =
    /(?:[A-Z]:[\\/]+Users[\\/]+[^\s"'<>\\/]+|\/Users\/[^\s"'<>/]+|\/home\/[^\s"'<>/]+)/gi;
  for (const match of value.matchAll(pattern)) {
    personalPaths.push({ source, file, line: value.slice(0, match.index).split('\n').length });
  }
}

const inventory = [];
for (const file of paths) {
  if (!existsSync(file)) continue; // skip staged deletions and files removed during the scan
  const bytes = readFileSync(file);
  inventory.push({ file, bytes: bytes.length });
  scan(bytes, 'working-tree', file);
}

// scan index contents as well as working files
const indexed = lines(git('ls-files', '--stage')).map((line) => {
  const match = line.match(/^\d+ ([a-f0-9]+) \d+\t(.+)$/);
  if (!match) throw new Error('Cannot parse Git index entry');
  return { oid: match[1], file: match[2], source: 'index' };
});
const reachable = lines(git('rev-list', '--objects', '--all')).map((line) => {
  const space = line.indexOf(' ');
  return {
    oid: space < 0 ? line : line.slice(0, space),
    file: space < 0 ? '(commit metadata)' : line.slice(space + 1),
    source: 'history',
  };
});
const objects = new Map();
for (const entry of [...reachable, ...indexed]) {
  const previous = objects.get(entry.oid);
  if (previous)
    previous.source = [...new Set([...previous.source.split('+'), entry.source])].join('+');
  else objects.set(entry.oid, { ...entry });
}
const batch = gitWithInput([...objects.keys()].join('\n') + '\n');
let offset = 0,
  historyBlobs = 0,
  historyBytes = 0;
const largeGitBlobs = [];
while (offset < batch.length) {
  const end = batch.indexOf(10, offset);
  const [oid, type, sizeText] = batch.subarray(offset, end).toString().split(' ');
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size)) throw new Error('Unexpected git cat-file output');
  const entry = objects.get(oid);
  const bytes = batch.subarray(end + 1, end + 1 + size);
  if (type === 'blob' || type === 'commit' || type === 'tag') scan(bytes, entry.source, entry.file);
  if (type === 'blob' && entry.source.includes('history')) {
    historyBlobs++;
    historyBytes += size;
  }
  if (type === 'blob' && size > 10 * 1024 * 1024)
    largeGitBlobs.push({ file: entry.file, bytes: size, source: entry.source });
  offset = end + 1 + size + 1;
}

function gitWithInput(input) {
  return execFileSync('git', ['cat-file', '--batch'], { input, maxBuffer: 256 * 1024 * 1024 });
}

const sensitivePath =
  /(?:^|\/)(?:\.env(?:\..+)?|id_rsa|id_ed25519|credentials(?:\.json)?|[^/]+\.(?:pem|p12|pfx|key|sqlite|db))$/i;
const packageMetadata = JSON.parse(readFileSync('package.json', 'utf8'));
const report = {
  head: git('rev-parse', 'HEAD').toString().trim(),
  scope:
    'Non-ignored working files, Git index, and all locally reachable refs. Includes gzip source snapshots and commit/tag metadata. No network, mutations, entropy scan, OCR of images, or unreachable/reflog objects.',
  commits: Number(git('rev-list', '--all', '--count').toString().trim()),
  workingFiles: inventory.length,
  workingBytes: inventory.reduce((sum, item) => sum + item.bytes, 0),
  historyBlobs,
  historyBytes,
  scannedText,
  scannedCompressed,
  binaryFiles,
  projectLicense: inventory
    .filter((item) => /^(?:LICENSE|COPYING)(?:\.[^/]+)?$/i.test(item.file))
    .map((item) => item.file),
  packageLicense: packageMetadata.license ?? null,
  githubFiles: inventory
    .filter((item) => item.file.startsWith('.github/'))
    .map((item) => item.file),
  sensitivePaths: [
    ...new Set(
      [...paths, ...reachable.map((entry) => entry.file)].filter((file) =>
        sensitivePath.test(file),
      ),
    ),
  ],
  largeGitBlobs,
  largestWorkingFiles: inventory.sort((a, b) => b.bytes - a.bytes).slice(0, 12),
  personalPathLocations: [
    ...new Map(personalPaths.map((item) => [JSON.stringify(item), item])).values(),
  ],
  credentialCandidates: [...new Map(findings.map((item) => [JSON.stringify(item), item])).values()],
};
console.log(JSON.stringify(report, null, 2));
if (report.credentialCandidates.length) process.exitCode = 1;
