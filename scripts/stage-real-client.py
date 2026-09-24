"""Stage the public real-client files and pinned model; never copy user data."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = (
    'start-real-client.py', 'start-real-client.cmd', 'desktop-main.cjs',
    'real-client-shell.cjs', 'real-client-preload.cjs', 'real-client-recovery.cjs',
)
MODEL_FILES = (
    'model.onnx', 'onnx_config.json', 'rl_agent_config.json', 'README.md',
    'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json',
)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=Path, default=ROOT)
    parser.add_argument('--models-dir', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    source = args.source_root.resolve()
    models = (args.models_dir or source/'.models/laya').resolve()
    output = (args.output or source/'.local/real-client-package/client').resolve()
    if output == source or source.is_relative_to(output):
        raise SystemExit('The staging directory must not contain or replace the source project')
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output.parent/'client-files.json'
    previous = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else []
    expected = {row['file']: row['sha256'] for row in previous}
    files = [Path('LICENSE'), Path('THIRD_PARTY_NOTICES.md'), Path('README.md'),
             Path('chatui/index.html'), Path('chatui/app.js'), Path('chatui/style.css'),
             Path('chatui/kaomoji.js'), Path('chatui/data/analysis-catalog.json'),
             Path('chatui/assets/wechatvibe-icon.png'), Path('chatui/assets/wechatvibe-icon.ico'),
             Path('electron/analysis.ts'), Path('shared/contracts.ts'), Path('src/lib/labels.ts'),
             Path('native-reader/THIRD_PARTY_NOTICES.md')]
    files.extend(Path('scripts')/name for name in SCRIPTS)
    files.extend(path.relative_to(source) for path in (source/'bridge').glob('*')
                 if path.suffix in ('.py', '.ts') and not path.name.startswith('test_'))
    files.extend(path.relative_to(source) for path in (source/'native-reader/wr').glob('*.py'))
    files.extend(path.relative_to(source) for path in (source/'electron/laya').iterdir()
                 if path.is_file() and (path.suffix in ('.ts', '.md') or path.name in ('LICENSE', 'NOTICE')))
    mappings = [(source/relative, relative) for relative in sorted(set(files))]
    mappings.extend((models/relative, Path('.models/laya')/relative) for relative in MODEL_FILES)
    for original, relative in mappings:
        if original.is_symlink() or not original.is_file():
            raise SystemExit('Missing or unsafe public input: ' + relative.as_posix())
        target = output/relative
        if not target.resolve().is_relative_to(output):
            raise SystemExit('Staging path escapes output')
        if target.exists() and digest(target) not in (digest(original), expected.get(relative.as_posix())):
            raise SystemExit('Unmanaged staged file differs: ' + relative.as_posix())
    results = []
    for original, relative in mappings:
        target = output/relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or digest(target) != digest(original):
            shutil.copy2(original, target)
        results.append({'file':relative.as_posix(), 'bytes':target.stat().st_size, 'sha256':digest(target)})
    metadata = output/'package.json'
    version = json.loads((source/'package.json').read_text(encoding='utf-8'))['version']
    content = json.dumps({'name':'wechatvibe-runtime', 'version':version, 'private':True, 'type':'module'},indent=2)+'\n'
    if (metadata.exists() and metadata.read_text(encoding='utf-8') != content and
            digest(metadata) != expected.get('package.json')):
        raise SystemExit('Unmanaged runtime package.json differs')
    metadata.write_text(content, encoding='utf-8')
    results.append({'file':'package.json','bytes':metadata.stat().st_size,'sha256':digest(metadata)})
    manifest_path.write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'publicFiles':len(results),'bytes':sum(row['bytes'] for row in results),
                      'userDataCopied':False,'output':str(output)},ensure_ascii=True))


if __name__ == '__main__':
    main()
