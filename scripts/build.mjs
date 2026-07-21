import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(projectRoot, 'dist');

async function copy(relativeSource, relativeDestination = relativeSource) {
  const source = resolve(projectRoot, relativeSource);
  const destination = resolve(outputRoot, relativeDestination);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return (await stat(destination)).size;
}

async function build() {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  let totalBytes = 0;
  let fileCount = 0;

  const runtimeFiles = [
    ['doom.html', 'index.html'],
    ['doom-assets/databuddy-consent.js'],
    ['doom-assets/doom-meta.js'],
    ['doom-assets/doom.wasm'],
    ['doom-assets/music/D_E1M1.m4a'],
    ['doom-assets/sfx/index.json'],
  ];

  for (const [source, destination] of runtimeFiles) {
    totalBytes += await copy(source, destination);
    fileCount += 1;
  }

  const manifestPath = resolve(projectRoot, 'doom-assets/sfx/index.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest)) {
    throw new TypeError('doom-assets/sfx/index.json must contain an array');
  }

  const soundNames = new Set();
  for (const sound of manifest) {
    const name = sound?.name;
    if (typeof name !== 'string' || !/^[a-z0-9_-]+$/i.test(name)) {
      throw new TypeError(`Invalid sound effect name in manifest: ${String(name)}`);
    }
    if (soundNames.has(name)) {
      throw new TypeError(`Duplicate sound effect in manifest: ${name}`);
    }
    soundNames.add(name);

    totalBytes += await copy(`doom-assets/sfx/${name}.wav`);
    fileCount += 1;
  }

  console.log(
    `Built ${fileCount} static files in dist (${(totalBytes / 1024 / 1024).toFixed(1)} MiB).`,
  );
}

build().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
