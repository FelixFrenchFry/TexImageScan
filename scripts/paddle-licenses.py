"""collect Rust dependency licenses for the bundled Paddle WASM

pass the pinned runtime checkout as the first argument
verify crate archives against the Cargo lockfile and cache them outside the package
include platform-specific and build dependencies
"""
import concurrent.futures
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import tomllib
import urllib.request
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '.cache/paddle-trial/upstream'
REVISION = 'f7d2f8aa40639497e1dbd95f2f8793e664b90758'
if subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() != REVISION:
    raise ValueError('Runtime checkout does not match the pinned source revision')
subprocess.run(['git', '-C', str(SOURCE), 'diff', '--exit-code', REVISION, '--',
                'Cargo.lock', 'Cargo.toml', 'crates/*/Cargo.toml'], check=True, stdout=subprocess.DEVNULL)
CACHE = ROOT / '.cache/paddle-licenses'
OUTPUT = ROOT / 'public/licenses/PaddleOCR-Rust-NOTICES.md'
lock_bytes = (SOURCE / 'Cargo.lock').read_bytes()
packages = tomllib.loads(lock_bytes.decode())['package']
by_name = {}
for package in packages:
    by_name.setdefault(package['name'], []).append(package)
workspace = tomllib.loads((SOURCE / 'Cargo.toml').read_text())
local = {}
for path in SOURCE.glob('crates/*/Cargo.toml'):
    meta = tomllib.loads(path.read_text())
    local[meta['package']['name']] = meta

selected = {}
visited = set()

def collect(name, version=None):
    candidates = [p for p in by_name[name] if version is None or p['version'] == version]
    if len(candidates) != 1:
        raise ValueError(f'Ambiguous locked package: {name} {version}')
    package = candidates[0]
    key = (name, package['version'])
    if key in visited:
        return
    visited.add(key)
    if name in local and 'source' not in package:
        meta = local[name]
        sections = [meta.get('dependencies', {})]
        sections.extend(t.get('dependencies', {}) for t in meta.get('target', {}).values())
        for section in sections:
            for dependency, settings in section.items():
                if isinstance(settings, dict) and settings.get('workspace'):
                    settings = workspace['workspace']['dependencies'][dependency]
                spec = settings if isinstance(settings, str) else settings.get('version')
                collect(dependency, spec.removeprefix('=') if spec else None)
    else:
        if package.get('source') != 'registry+https://github.com/rust-lang/crates.io-index':
            raise ValueError(f'Unsupported source: {package}')
        selected[key] = package
        for dependency in package.get('dependencies', []):
            parts = dependency.split()
            collect(parts[0], parts[1] if len(parts) > 1 else None)

collect('pvlc-runtime-web')
CACHE.mkdir(parents=True, exist_ok=True)

def fetch_license(item):
    (name, version), package = item
    archive_path = CACHE / f'{name}-{version}.crate'
    url = f'https://static.crates.io/crates/{name}/{name}-{version}.crate'
    if archive_path.exists():
        archive = archive_path.read_bytes()
    else:
        with urllib.request.urlopen(url, timeout=120) as response:
            archive = response.read()
        archive_path.write_bytes(archive)
    if hashlib.sha256(archive).hexdigest() != package['checksum']:
        raise ValueError(f'Archive checksum mismatch: {name} {version}')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        prefix = f'{name}-{version}/'
        metadata = tomllib.loads(tar.extractfile(prefix + 'Cargo.toml').read().decode())
        texts = []
        for member in tar.getmembers():
            relative = member.name.removeprefix(prefix)
            if member.isfile() and re.search(r'(^|/)(LICENSE[^/]*|LICENCE[^/]*|COPYING[^/]*|NOTICE[^/]*)$', relative, re.I):
                texts.append((relative, tar.extractfile(member).read().decode('utf-8', errors='replace')))
        if not texts:
            # some crates omit license files from their published archive
            # use the verified VCS record to find the upstream commit
            vcs = json.loads(tar.extractfile(prefix + '.cargo_vcs_info.json').read())
            repository = metadata['package'].get('repository', '').removesuffix('.git')
            if not repository.startswith('https://github.com/'):
                raise ValueError(f'No license text or supported source: {name} {version}')
            source_base = repository.replace('https://github.com/', 'https://raw.githubusercontent.com/')
            source_base += '/' + vcs['git']['sha1']
            for filename in ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENSE-APACHE', 'COPYING']:
                license_url = source_base + '/' + filename
                cached_text = CACHE / f'{name}-{version}-{filename}'
                try:
                    if cached_text.exists():
                        content = cached_text.read_text(encoding='utf-8')
                    else:
                        with urllib.request.urlopen(license_url, timeout=120) as response:
                            content = response.read().decode()
                        cached_text.write_text(content, encoding='utf-8')
                    texts.append((license_url, content))
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
            if not texts:
                raise ValueError(f'No license text at pinned source: {name} {version}')
    return {'name': name, 'version': version, 'checksum': package['checksum'],
            'license': metadata['package'].get('license'), 'url': url, 'texts': sorted(texts)}

with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    records = list(pool.map(fetch_license, sorted(selected.items())))

header = '# Paddle WebGPU Rust dependency notices\n\n'
header += f'Runtime source: https://github.com/glebkudr/paddleocr-vl-webgpu/tree/{REVISION}\n\n'
header += f'Cargo.lock SHA-256: `{hashlib.sha256(lock_bytes).hexdigest()}`\n\n'
header += ('Generated by `scripts/paddle-licenses.py` from the runtime dependency closure. '
           'Includes platform-specific and build dependencies conservatively; excludes workspace test-only dependencies. '
           'Every crate archive was verified against its Cargo.lock checksum.\n\n')
text = header
for record in records:
    text += f"## {record['name']} {record['version']}\n\nLicense: {record['license']}\n\n"
    text += f"Source: {record['url']}\n\nArchive SHA-256: `{record['checksum']}`\n\n"
    for name, content in record['texts']:
        text += f'### {name}\n\n{content}\n\n'
OUTPUT.write_text(text, encoding='utf-8', newline='\n')
print(f'Collected verified license texts for {len(records)} Rust dependencies')
