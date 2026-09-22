"""One-time publication of the user's already verified v0.2.3 build."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

REPOSITORY = 'lixia3987-netizen/cc-desk'
RUN = 35725728224
SOURCE = '83f3fe900b47f3065a72d7bf15f279ed9786ac34'
BRANCH = 'publish/v0.2.3-existing-35725728224'
VERSION = '0.2.3'
PREFIX = f'cc-desk-{VERSION}-'
PACKAGES = {
    'Windows-x64': ['windows-x64-setup.exe', 'windows-x64-portable.exe', 'windows-x64-portable.zip'],
    'macOS-arm64': ['macos-arm64-setup.dmg', 'macos-arm64-portable.zip'],
    'Linux-x64': ['linux-x86_64-portable.AppImage', 'linux-x64-portable.tar.gz'],
}
ARTIFACTS = [
    (10694005447, 'packages-Windows-x64'),
    (10693093630, 'packages-macOS-arm64'),
    (10692668154, 'packages-Linux-x64'),
    (10694205315, 'claude-workbench-Windows-x64'),
    (10693378349, 'claude-workbench-macOS-arm64'),
    (10692698198, 'claude-workbench-Linux-x64'),
]
PLATFORMS = {'Windows-x64': ('win32', 'x64'), 'macOS-arm64': ('darwin', 'arm64'), 'Linux-x64': ('linux', 'x64')}

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def api(endpoint):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{REPOSITORY}/{endpoint}'], text=True))

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

require(os.environ.get('GITHUB_REPOSITORY') == REPOSITORY, 'Unexpected repository')
require(os.environ.get('GITHUB_REF') == f'refs/heads/{BRANCH}', 'Unexpected publication branch')
run = api(f'actions/runs/{RUN}')
require(run['status'] == 'completed' and run['conclusion'] == 'success', 'Source build is not successful')
require(run['head_sha'] == SOURCE and run['head_branch'] == 'main', 'Source build commit mismatch')
require(run['repository']['id'] == run['head_repository']['id'] == 1379900243, 'Unexpected build repository')
jobs = api(f'actions/runs/{RUN}/jobs?per_page=100')['jobs']
for name in ['build (windows-2025, x64)', 'build (macos-15, arm64)', 'build (ubuntu-24.04, x64)']:
    matches = [job for job in jobs if job['name'] == name]
    require(len(matches) == 1 and matches[0]['conclusion'] == 'success', f'Missing successful platform job: {name}')

destination = Path('release-assets')
destination.mkdir(exist_ok=False)
manifests = {}
with tempfile.TemporaryDirectory(prefix='verified-release-') as scratch:
    def download(item):
        artifact_id, name = item
        meta = api(f'actions/artifacts/{artifact_id}')
        require(meta['id'] == artifact_id and meta['name'] == name and not meta['expired'], f'Unexpected artifact: {name}')
        require(meta['workflow_run']['id'] == RUN and meta['workflow_run']['head_sha'] == SOURCE, f'Artifact source mismatch: {name}')
        archive = Path(scratch) / f'{artifact_id}.zip'
        with archive.open('wb') as output:
            subprocess.run(['gh', 'api', f'repos/{REPOSITORY}/actions/artifacts/{artifact_id}/zip'], stdout=output, check=True)
        require(meta.get('digest') == 'sha256:' + digest(archive), f'Artifact archive checksum mismatch: {name}')
        print(f'Verified archive {artifact_id}: {name}', flush=True)
        return name, archive

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        archives = list(executor.map(download, ARTIFACTS))
    for name, archive in archives:
        with zipfile.ZipFile(archive) as bundle:
            if name.startswith('packages-'):
                platform = name.removeprefix('packages-')
                expected = {PREFIX + filename for filename in PACKAGES[platform]}
                require(set(bundle.namelist()) == expected and len(bundle.infolist()) == len(expected), f'Unexpected package files: {name}')
                for filename in sorted(expected):
                    with bundle.open(filename) as source, (destination / filename).open('xb') as output:
                        shutil.copyfileobj(source, output)
            else:
                platform = name.removeprefix('claude-workbench-')
                matches = [entry for entry in bundle.infolist() if Path(entry.filename).name == 'packaged-manifest.json']
                require(len(matches) == 1 and matches[0].file_size < 1024 * 1024, f'Missing package validation manifest: {name}')
                manifests[platform] = json.loads(bundle.read(matches[0]))

verified_names = set()
for platform, manifest in manifests.items():
    require(manifest['sourceCommit'] == SOURCE and manifest['version'] == VERSION and manifest['verified'] is True, f'Unverified package manifest: {platform}')
    require((manifest['platform'], manifest['arch']) == PLATFORMS[platform], f'Manifest architecture mismatch: {platform}')
    expected = {PREFIX + filename for filename in PACKAGES[platform] if filename != 'windows-x64-portable.exe'}
    require(len(manifest['targets']) == 2 and {target['artifact'] for target in manifest['targets']} == expected, f'Unexpected verified targets: {platform}')
    for target in manifest['targets']:
        require(digest(destination / target['artifact']) == target['sha256'], f'Package differs from tested payload: {target["artifact"]}')
        verified_names.add(target['artifact'])
require(set(manifests) == set(PLATFORMS) and len(verified_names) == 6, 'Missing platform validation')
print('Six tested payload checksums match; the portable EXE is covered by the verified Windows artifact archive.', flush=True)

# The existing publisher must tag and cite the original verified build, not this upload-only job.
publish_environment = dict(os.environ, GITHUB_SHA=SOURCE, GITHUB_RUN_ID=str(RUN))
subprocess.run(['node', 'scripts/publish-release.mjs'], env=publish_environment, check=True)
release = api(f'releases/tags/v{VERSION}')
require(not release['draft'], 'Release is still a draft')
for asset in release['assets']:
    require(asset.get('digest') == 'sha256:' + digest(destination / asset['name']), f'Uploaded release checksum mismatch: {asset["name"]}')
    print(f'Release asset verified: {asset["name"]}', flush=True)

# Remove only this task's temporary branch, and only if nobody has advanced it.
ref = api(f'git/ref/heads/{BRANCH}')
if ref['object']['sha'] == os.environ['GITHUB_SHA']:
    subprocess.run(['gh', 'api', '--method', 'DELETE', f'repos/{REPOSITORY}/git/refs/heads/{BRANCH}'], check=True)
    print('Removed the temporary publication branch.', flush=True)
else:
    print('Publication branch has advanced; leaving it untouched.', flush=True)
