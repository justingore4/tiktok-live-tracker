const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { crc32 } = require('node:zlib');
const { unzipSync, zipSync } = require('fflate');
const {
  packageExtension,
  readExtensionSnapshot,
  buildArchive,
  verifyArchive,
  runFullTests,
} = require('../scripts/package-extension.cjs');

const FIXTURE_PREFIX = 'tiktok-package-test-';
const VERSION = '1.2.3';
const OUTPUT_NAME = `TikTok-Live-Tracker-${VERSION}.zip`;
const manifest = {
  manifest_version: 3,
  name: 'Fixture',
  version: VERSION,
  background: { service_worker: 'service-worker.js' },
  side_panel: { default_path: 'panel.html' },
};

async function writeFixtureFile(rootDir, relativePath, content) {
  const target = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function fixture(t, extraFiles = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), FIXTURE_PREFIX));
  t.after(async () => {
    // Only remove the exact directory this test allocated, never a broad temp root.
    assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(rootDir).startsWith(FIXTURE_PREFIX));
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const files = {
    'package.json': JSON.stringify({ name: 'fixture-root', version: '9.9.9' }),
    'README.md': 'This repository file must not enter the ZIP.\n',
    'extension/manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'extension/service-worker.js': '// current working-tree worker\r\n',
    'extension/panel.html': '<!doctype html><title>Fixture</title>\n',
    ...extraFiles,
  };
  await Promise.all(Object.entries(files).map(([name, bytes]) => writeFixtureFile(rootDir, name, bytes)));
  return rootDir;
}

async function diskTree(directory) {
  const result = {};
  async function visit(current, prefix) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result[`${relative}/`] = null;
        await visit(absolute, `${relative}/`);
      } else if (entry.isSymbolicLink()) {
        result[relative] = `link:${await fs.readlink(absolute)}`;
      } else {
        result[relative] = await fs.readFile(absolute);
      }
    }
  }
  await visit(directory, '');
  return result;
}

async function assertArtifacts(rootDir, expected = []) {
  const rootEntries = await fs.readdir(rootDir);
  assert.deepEqual(rootEntries.filter((entry) => entry !== 'dist').sort(), ['README.md', 'extension', 'package.json']);
  let distEntries = [];
  try {
    distEntries = await fs.readdir(path.join(rootDir, 'dist'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert.deepEqual(distEntries.sort(), [...expected].sort(), 'no unfinished or unexpected archives remain');
}

async function successfulTests() {}

function centralEntries(bytes) {
  const entries = [];
  const end = bytes.length - 22;
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let index = 0; index < count; index += 1) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    entries.push({
      name: bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      offset,
      localOffset: bytes.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('packages the complete current extension tree with manifest version and exact bytes', async (t) => {
  const rootDir = await fixture(t, {
    'extension/assets/fonts/nested/font.woff2': Buffer.from([0, 255, 13, 10, 128, 42]),
    'extension/assets/fonts/LICENSE.txt': 'Font license\r\nAll terms preserved.\r\n',
    'extension/arbitrary/deep/new-uncommitted-file.dat': Buffer.from([254, 0, 127, 1]),
    'extension/arbitrary/deep/read me.txt': 'Spaces and Unicode: café 日本語\n',
  });
  await fs.mkdir(path.join(rootDir, 'extension', 'assets', 'empty'), { recursive: true });
  const before = await diskTree(path.join(rootDir, 'extension'));
  let testCalls = 0;
  const result = await packageExtension({
    rootDir,
    runTests: async (testRoot) => {
      assert.equal(testRoot, rootDir);
      testCalls += 1;
    },
  });

  assert.equal(testCalls, 1);
  assert.equal(result.version, VERSION, 'the extension manifest supplies the version, not package.json');
  assert.equal(result.outputPath, path.join(rootDir, 'dist', OUTPUT_NAME));
  assert.equal(path.relative(path.join(rootDir, 'extension'), result.outputPath).split(path.sep)[0], '..');
  const zipBytes = await fs.readFile(result.outputPath);
  assert.equal(result.archiveBytes, zipBytes.length);
  const archive = unzipSync(zipBytes);
  const sourceFiles = Object.keys(before).filter((name) => !name.endsWith('/'));
  assert.equal(result.fileCount, sourceFiles.length);
  assert.deepEqual(Object.keys(archive).filter((name) => !name.endsWith('/')).sort(), sourceFiles.map((name) => `extension/${name}`).sort());
  for (const [name, bytes] of Object.entries(before)) {
    assert.ok(Object.hasOwn(archive, `extension/${name}`), `ZIP contains ${name}`);
    assert.deepEqual(Buffer.from(archive[`extension/${name}`]), bytes === null ? Buffer.alloc(0) : bytes);
  }
  assert.ok(Object.keys(archive).every((name) => name.startsWith('extension/')));
  assert.deepEqual(await diskTree(path.join(rootDir, 'extension')), before, 'packaging never edits source files or directories');
  await verifyArchive(zipBytes, await readExtensionSnapshot(rootDir));
  await assertArtifacts(rootDir, [OUTPUT_NAME]);
});

test('snapshot and ZIP omit OS junk without removing it from the extension', async (t) => {
  const rootDir = await fixture(t, {
    'extension/.DS_Store': 'Finder metadata',
    'extension/assets/Thumbs.db': 'Explorer metadata',
    'extension/assets/desktop.ini': 'Explorer settings',
    'extension/__MACOSX/ignored.txt': 'AppleDouble metadata',
    'extension/assets/keep.txt': 'real extension asset',
  });
  const before = await diskTree(path.join(rootDir, 'extension'));
  const snapshot = await readExtensionSnapshot(rootDir);
  assert.ok(snapshot.files instanceof Map);
  assert.ok(Array.isArray(snapshot.directories));
  assert.equal(snapshot.manifest.version, VERSION);
  assert.ok(snapshot.files.has('assets/keep.txt'));
  for (const name of ['.DS_Store', 'assets/Thumbs.db', 'assets/desktop.ini', '__MACOSX/ignored.txt']) {
    assert.equal(snapshot.files.has(name), false, `${name} is not a packaged asset`);
  }
  const result = await packageExtension({ rootDir, runTests: successfulTests });
  const archive = unzipSync(await fs.readFile(result.outputPath));
  assert.ok(Object.keys(archive).every((name) => !/\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX/.test(name)));
  assert.deepEqual(await diskTree(path.join(rootDir, 'extension')), before);
  await assertArtifacts(rootDir, [OUTPUT_NAME]);
});

test('failed tests produce no archive, leave no temporary ZIP, and preserve the extension', async (t) => {
  const rootDir = await fixture(t);
  const before = await diskTree(path.join(rootDir, 'extension'));
  let builds = 0;
  await assert.rejects(packageExtension({
    rootDir,
    runTests: async () => { throw new Error('synthetic test suite failure'); },
    buildZip: async (snapshot) => { builds += 1; return buildArchive(snapshot); },
  }), /synthetic test suite failure/);
  assert.equal(builds, 0, 'build only starts after tests pass');
  assert.deepEqual(await diskTree(path.join(rootDir, 'extension')), before);
  await assertArtifacts(rootDir);
});

test('invalid manifest versions fail before tests and cannot choose an output path', async (t) => {
  const rootDir = await fixture(t, {
    'extension/manifest.json': JSON.stringify({ ...manifest, version: '../outside' }),
  });
  const before = await diskTree(path.join(rootDir, 'extension'));
  let testCalls = 0;
  await assert.rejects(packageExtension({ rootDir, runTests: async () => { testCalls += 1; } }));
  assert.equal(testCalls, 0);
  assert.deepEqual(await diskTree(path.join(rootDir, 'extension')), before);
  await assertArtifacts(rootDir);
});

for (const [description, mutate] of [
  ['file content change', (rootDir) => writeFixtureFile(rootDir, 'extension/service-worker.js', '// changed during tests\n')],
  ['file addition', (rootDir) => writeFixtureFile(rootDir, 'extension/new-file.txt', 'added during tests')],
  ['file removal', (rootDir) => fs.unlink(path.join(rootDir, 'extension', 'panel.html'))],
  ['file rename', (rootDir) => fs.rename(path.join(rootDir, 'extension', 'service-worker.js'), path.join(rootDir, 'extension', 'renamed-worker.js'))],
  ['empty directory addition', (rootDir) => fs.mkdir(path.join(rootDir, 'extension', 'new-empty-directory'))],
  ['manifest version change', (rootDir) => writeFixtureFile(rootDir, 'extension/manifest.json', JSON.stringify({ ...manifest, version: '1.2.4' }))],
]) {
  test(`rejects a ${description} made while tests run`, async (t) => {
    const rootDir = await fixture(t);
    let changedSource;
    await assert.rejects(packageExtension({
      rootDir,
      runTests: async () => {
        await mutate(rootDir);
        changedSource = await diskTree(path.join(rootDir, 'extension'));
      },
    }));
    assert.deepEqual(await diskTree(path.join(rootDir, 'extension')), changedSource, 'packager does not undo outside source changes');
    await assertArtifacts(rootDir);
  });
}

test('rejects source changes after building, before publication', async (t) => {
  const rootDir = await fixture(t);
  await assert.rejects(packageExtension({
    rootDir,
    runTests: successfulTests,
    buildZip: async (snapshot) => {
      const bytes = await buildArchive(snapshot);
      await writeFixtureFile(rootDir, 'extension/service-worker.js', '// source changed while ZIP was built\n');
      return bytes;
    },
  }));
  await assertArtifacts(rootDir);
});

test('rechecks source after archive verification and before publication', async (t) => {
  const rootDir = await fixture(t);
  await assert.rejects(packageExtension({
    rootDir,
    runTests: successfulTests,
    verifyZip: async (bytes, snapshot) => {
      await verifyArchive(bytes, snapshot);
      await writeFixtureFile(rootDir, 'extension/late-file.txt', 'introduced during verification');
    },
  }));
  await assertArtifacts(rootDir);
});

test('a ZIP-building error leaves no output or temporary files', async (t) => {
  const rootDir = await fixture(t);
  await assert.rejects(packageExtension({
    rootDir,
    runTests: successfulTests,
    buildZip: async () => { throw new Error('synthetic ZIP builder failure'); },
  }), /synthetic ZIP builder failure/);
  await assertArtifacts(rootDir);
});

test('a ZIP-verification error cleans its temporary file without publishing', async (t) => {
  const rootDir = await fixture(t);
  const before = await diskTree(path.join(rootDir, 'extension'));
  await assert.rejects(packageExtension({
    rootDir,
    runTests: successfulTests,
    verifyZip: async () => { throw new Error('synthetic ZIP verification failure'); },
  }), /synthetic ZIP verification failure/);
  assert.deepEqual(await diskTree(path.join(rootDir, 'extension')), before);
  await assertArtifacts(rootDir);
});

for (const [description, corrupt] of [
  ['wrong file bytes', (archive) => { archive['extension/service-worker.js'] = Buffer.from('not the original worker'); }],
  ['missing file', (archive) => { delete archive['extension/panel.html']; }],
  ['unexpected file', (archive) => { archive['extension/extra.txt'] = Buffer.from('unexpected'); }],
  ['missing empty directory', (archive) => { delete archive['extension/empty/']; }],
  ['path traversal entry', (archive) => { archive['extension/../outside.txt'] = Buffer.from('unsafe'); }],
]) {
  test(`rejects a generated archive containing ${description}`, async (t) => {
    const rootDir = await fixture(t);
    await fs.mkdir(path.join(rootDir, 'extension', 'empty'));
    const before = await diskTree(path.join(rootDir, 'extension'));
    await assert.rejects(packageExtension({
      rootDir,
      runTests: successfulTests,
      buildZip: async (snapshot) => {
        const archive = unzipSync(await buildArchive(snapshot));
        corrupt(archive);
        return zipSync(archive);
      },
    }));
    assert.deepEqual(await diskTree(path.join(rootDir, 'extension')), before);
    await assertArtifacts(rootDir);
  });
}

test('rejects truncated ZIP data and leaves no temporary archive', async (t) => {
  const rootDir = await fixture(t);
  await assert.rejects(packageExtension({
    rootDir,
    runTests: successfulTests,
    buildZip: async (snapshot) => {
      const bytes = await buildArchive(snapshot);
      return bytes.subarray(0, Math.floor(bytes.length / 2));
    },
  }));
  await assertArtifacts(rootDir);
});

for (const [description, corrupt] of [
  ['central CRC mismatch', (bytes, entry) => { bytes.writeUInt32LE(0, entry.offset + 16); }],
  ['local CRC mismatch', (bytes, entry) => { bytes.writeUInt32LE(0, entry.localOffset + 14); }],
  ['symlink file attributes', (bytes, entry) => { bytes.writeUInt32LE((0o120777 << 16) >>> 0, entry.offset + 38); }],
]) {
  test(`rejects ZIP metadata corruption: ${description}`, async (t) => {
    const rootDir = await fixture(t);
    await assert.rejects(packageExtension({
      rootDir,
      runTests: successfulTests,
      buildZip: async (snapshot) => {
        const bytes = Buffer.from(await buildArchive(snapshot));
        const entry = centralEntries(bytes).find((item) => item.name === 'extension/service-worker.js');
        assert.ok(entry);
        corrupt(bytes, entry);
        return bytes;
      },
    }));
    await assertArtifacts(rootDir);
  });
}

test('rejects duplicate ZIP central-directory names even when extraction hides a duplicate', async (t) => {
  const rootDir = await fixture(t, {
    'extension/a.txt': 'identical asset bytes',
    'extension/b.txt': 'identical asset bytes',
  });
  await assert.rejects(packageExtension({
    rootDir,
    runTests: successfulTests,
    buildZip: async (snapshot) => {
      const bytes = Buffer.from(await buildArchive(snapshot));
      const entry = centralEntries(bytes).find((item) => item.name === 'extension/b.txt');
      assert.ok(entry);
      const duplicateName = Buffer.from('extension/a.txt');
      duplicateName.copy(bytes, entry.offset + 46);
      duplicateName.copy(bytes, entry.localOffset + 30);
      return bytes;
    },
  }));
  await assertArtifacts(rootDir);
});

test('rejects ZIP extra fields that could override the audited extraction path', async (t) => {
  const rootDir = await fixture(t);
  await assert.rejects(packageExtension({
    rootDir,
    runTests: successfulTests,
    buildZip: async (snapshot) => {
      const archive = unzipSync(await buildArchive(snapshot));
      const input = Object.create(null);
      for (const [name, bytes] of Object.entries(archive)) {
        const options = {
          os: 3,
          attrs: name.endsWith('/') ? (0o40755 << 16) | 16 : (0o100644 << 16),
        };
        if (name === 'extension/service-worker.js') {
          const alternate = Buffer.from('extension/../../outside.txt');
          const unicodePath = Buffer.alloc(5 + alternate.length);
          unicodePath[0] = 1;
          unicodePath.writeUInt32LE(crc32(Buffer.from(name)), 1);
          alternate.copy(unicodePath, 5);
          options.extra = { 0x7075: unicodePath };
        }
        input[name] = [bytes, options];
      }
      return zipSync(input);
    },
  }));
  await assertArtifacts(rootDir);
});

test('refuses to overwrite an existing versioned archive', async (t) => {
  const rootDir = await fixture(t);
  const original = Buffer.from('Existing archive bytes must remain unchanged.');
  await writeFixtureFile(rootDir, `dist/${OUTPUT_NAME}`, original);
  await assert.rejects(packageExtension({ rootDir, runTests: successfulTests }));
  assert.deepEqual(await fs.readFile(path.join(rootDir, 'dist', OUTPUT_NAME)), original);
  await assertArtifacts(rootDir, [OUTPUT_NAME]);
});

test('refuses to replace an existing directory at the destination', async (t) => {
  const rootDir = await fixture(t);
  await writeFixtureFile(rootDir, `dist/${OUTPUT_NAME}/keep.txt`, 'preserve this directory');
  await assert.rejects(packageExtension({ rootDir, runTests: successfulTests }));
  assert.equal(await fs.readFile(path.join(rootDir, 'dist', OUTPUT_NAME, 'keep.txt'), 'utf8'), 'preserve this directory');
  await assertArtifacts(rootDir, [OUTPUT_NAME]);
});

test('does not overwrite an archive created concurrently during verification', async (t) => {
  const rootDir = await fixture(t);
  const concurrent = Buffer.from('A different publisher arrived first.');
  await assert.rejects(packageExtension({
    rootDir,
    runTests: successfulTests,
    verifyZip: async (bytes, snapshot) => {
      await verifyArchive(bytes, snapshot);
      await writeFixtureFile(rootDir, `dist/${OUTPUT_NAME}`, concurrent);
    },
  }));
  assert.deepEqual(await fs.readFile(path.join(rootDir, 'dist', OUTPUT_NAME)), concurrent);
  await assertArtifacts(rootDir, [OUTPUT_NAME]);
});

test('concurrent package publishers produce one verified output without clobbering or temp leaks', { timeout: 10000 }, async (t) => {
  const rootDir = await fixture(t);
  let arrivals = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const runTests = async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await barrier;
  };
  const outcomes = await Promise.allSettled([
    packageExtension({ rootDir, runTests }),
    packageExtension({ rootDir, runTests }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
  const published = await fs.readFile(path.join(rootDir, 'dist', OUTPUT_NAME));
  await verifyArchive(published, await readExtensionSnapshot(rootDir));
  await assertArtifacts(rootDir, [OUTPUT_NAME]);
});

test('rejects linked extension directories rather than following them into the archive', async (t) => {
  const rootDir = await fixture(t);
  const linkedTarget = path.join(rootDir, 'linked-target');
  await fs.mkdir(linkedTarget);
  await fs.writeFile(path.join(linkedTarget, 'private.txt'), 'must not enter an archive');
  try {
    await fs.symlink(linkedTarget, path.join(rootDir, 'extension', 'linked-assets'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`OS does not permit creating a test link: ${error.code}`);
      return;
    }
    throw error;
  }
  let testCalls = 0;
  await assert.rejects(packageExtension({ rootDir, runTests: async () => { testCalls += 1; } }));
  assert.equal(testCalls, 0, 'unsafe trees fail before tests run');
  assert.equal(await fs.readFile(path.join(linkedTarget, 'private.txt'), 'utf8'), 'must not enter an archive');
  await fs.unlink(path.join(rootDir, 'extension', 'linked-assets'));
  await fs.unlink(path.join(linkedTarget, 'private.txt'));
  await fs.rmdir(linkedTarget);
  await assertArtifacts(rootDir);
});

test('rejects a linked dist directory without publishing outside the fixture root', async (t) => {
  const rootDir = await fixture(t);
  const outsideRoot = await fixture(t);
  const outsideBefore = await diskTree(outsideRoot);
  const linkPath = path.join(rootDir, 'dist');
  try {
    await fs.symlink(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`OS does not permit creating a test link: ${error.code}`);
      return;
    }
    throw error;
  }
  let testCalls = 0;
  await assert.rejects(packageExtension({ rootDir, runTests: async () => { testCalls += 1; } }));
  assert.equal(testCalls, 0);
  assert.deepEqual(await diskTree(outsideRoot), outsideBefore);
  assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true, 'the existing link is not replaced');
  await fs.unlink(linkPath);
  await assertArtifacts(rootDir);
});

test('the real test runner executes all tests in an isolated synthetic repository', async (t) => {
  const rootDir = await fixture(t, {
    'tests/first.test.cjs': "const test = require('node:test'); const fs = require('node:fs'); test('[fixture] first discovered test', () => fs.writeFileSync('first-ran.txt', process.cwd()));\n",
    'tests/nested/second.test.cjs': "const test = require('node:test'); const fs = require('node:fs'); test('[fixture] nested discovered test', () => fs.writeFileSync('second-ran.txt', process.cwd()));\n",
  });
  await runFullTests(rootDir, { stdio: 'ignore' });
  assert.equal(await fs.readFile(path.join(rootDir, 'first-ran.txt'), 'utf8'), rootDir);
  assert.equal(await fs.readFile(path.join(rootDir, 'second-ran.txt'), 'utf8'), rootDir);
});

test('the real test runner rejects a nonzero test process exit in an isolated fixture', async (t) => {
  const rootDir = await fixture(t, {
    'tests/failure.test.cjs': "const test = require('node:test'); test('[fixture] intentional failure to exercise runner rejection', () => { throw new Error('expected synthetic failure'); });\n",
  });
  await assert.rejects(runFullTests(rootDir, { stdio: 'ignore' }), /tests failed/i);
});
