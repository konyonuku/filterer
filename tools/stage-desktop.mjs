import { copyFile, mkdir, chmod, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] === 'release' ? 'release' : 'debug';
const ext = process.platform === 'win32' ? '.exe' : '';
const source = path.join(root, 'src-tauri', 'target', mode, `filterer-desktop${ext}`);
const directory = path.join(root, '.desktop-build');
const target = path.join(directory, `Filterer${ext}`);
await mkdir(directory, { recursive: true });
await copyFile(source, target);
if (process.platform !== 'win32') await chmod(target, 0o755);
await writeFile(path.join(directory, 'build.json'), JSON.stringify({ version: '0.2.0', mode, builtAt: new Date().toISOString() }, null, 2));
console.log(`Desktop executable: ${target}`);
