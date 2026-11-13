import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const imageInputs = [
  '.dockerignore',
  'host.json',
  'node24.Dockerfile',
  'package-lock.json',
  'package.json',
  'tsconfig.json',
  'src',
  'vendor',
];

function normalizedRelativePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function copyEntry(source, destination) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed in the image context: ${source}`);
  }

  if (stat.isDirectory()) {
    mkdirSync(destination, { mode: 0o755 });
    for (const entry of readdirSync(source, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      copyEntry(join(source, entry.name), join(destination, entry.name));
    }
    return;
  }

  if (!stat.isFile()) {
    throw new Error(`Unsupported image-context entry: ${source}`);
  }

  copyFileSync(source, destination);
  chmodSync(destination, 0o644);
}

export function hashImageContext(contextRoot) {
  const root = resolve(contextRoot);
  const hash = createHash('sha256');
  hash.update('flex-container-image-context-v1\0');

  function visit(path) {
    const stat = lstatSync(path);
    const name = normalizedRelativePath(root, path);

    if (stat.isDirectory()) {
      hash.update(`directory\0${name}\0`);
      for (const entry of readdirSync(path, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        visit(join(path, entry.name));
      }
      return;
    }

    if (!stat.isFile()) {
      throw new Error(`Unsupported image-context entry: ${path}`);
    }

    const content = readFileSync(path);
    hash.update(`file\0${name}\0${content.length}\0`);
    hash.update(content);
    hash.update('\0');
  }

  for (const entry of readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    visit(join(root, entry.name));
  }

  return hash.digest('hex');
}

export function prepareImageContext(repositoryRoot, destinationRoot) {
  const repository = resolve(repositoryRoot);
  const destination = resolve(destinationRoot);
  mkdirSync(destination, { recursive: true, mode: 0o755 });

  if (readdirSync(destination).length !== 0) {
    throw new Error(`Image-context destination must be empty: ${destination}`);
  }

  for (const input of imageInputs) {
    copyEntry(join(repository, input), join(destination, input));
  }

  return hashImageContext(destination);
}

const scriptPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';

if (invokedPath === import.meta.url) {
  try {
    const destination = process.argv[2];
    if (!destination) {
      throw new Error('Usage: node imagecontext.mjs <empty-destination-directory>');
    }

    const repositoryRoot = resolve(dirname(scriptPath), '..', '..');
    process.stdout.write(`${prepareImageContext(repositoryRoot, destination)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
