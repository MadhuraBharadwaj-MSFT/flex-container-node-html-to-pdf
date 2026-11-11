const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

test('image context is deterministic and excludes unrelated files', async () => {
  const { hashImageContext, prepareImageContext } = await import(
    '../infra/scripts/imagecontext.mjs'
  );
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-context-test-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-context-test-'));
  const firstContext = path.join(firstRoot, 'context');
  const secondContext = path.join(secondRoot, 'context');

  try {
    const firstHash = prepareImageContext(repositoryRoot, firstContext);
    const secondHash = prepareImageContext(repositoryRoot, secondContext);

    assert.match(firstHash, /^[0-9a-f]{64}$/);
    assert.equal(secondHash, firstHash);
    assert.deepEqual(fs.readdirSync(firstContext).sort(), [
      '.dockerignore',
      'host.json',
      'node24.Dockerfile',
      'package-lock.json',
      'package.json',
      'src',
      'tsconfig.json',
      'vendor',
    ]);

    fs.appendFileSync(path.join(secondContext, 'host.json'), '\n');
    assert.notEqual(hashImageContext(secondContext), firstHash);
  } finally {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});
