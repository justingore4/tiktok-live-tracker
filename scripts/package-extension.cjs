"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { crc32 } = require("node:zlib");
const { zipSync, unzipSync } = require("fflate");
const {
  validateArchivePath, isOsJunk, assertSafeFile, validateExtension,
} = require("./package-validation.cjs");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const DEVELOPMENT_DIRECTORIES = new Set([
  ".git", ".vscode", ".idea", "node_modules", "tests", "dist", "build",
]);
const order = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function sourceChanged() {
  return new Error("Extension source changed during testing/packaging. Finish editing and run npm run package again; no release was published.");
}

function stamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

async function requireDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Expected a real directory, not a symlink or other file: " + directory);
  }
}

async function readExtensionSnapshot(rootDir = DEFAULT_ROOT) {
  const root = await fs.realpath(rootDir);
  const extension = path.join(root, "extension");
  await requireDirectory(extension);
  const files = new Map();
  const directories = [];
  const stamps = new Map();
  const portableNames = new Set();

  async function walk(directory, relative = "", ignored = false) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => order(a.name, b.name));
    for (const entry of entries) {
      const name = relative ? relative + "/" + entry.name : entry.name;
      validateArchivePath(name);
      const folded = name.normalize("NFC").toLowerCase();
      if (portableNames.has(folded)) throw new Error("Case/Unicode filename collision: " + name);
      portableNames.add(folded);
      const fullPath = path.join(directory, entry.name);
      const before = await fs.lstat(fullPath, { bigint: true });
      if (before.isSymbolicLink()) throw new Error("Symlinks are not allowed in the extension: " + name);
      const skip = ignored || isOsJunk(entry.name);
      if (before.isDirectory()) {
        if (DEVELOPMENT_DIRECTORIES.has(entry.name.toLowerCase())) {
          throw new Error("Development/build directory found inside extension: " + name + ". Move it outside the extension before packaging.");
        }
        if (!skip) directories.push(name);
        await walk(fullPath, name, skip);
      } else if (before.isFile()) {
        if (before.size > 0xffffffffn) throw new Error("File exceeds the supported ZIP size: " + name);
        const handle = await fs.open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let bytes;
        try {
          if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) throw sourceChanged();
          bytes = await handle.readFile();
          if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) throw sourceChanged();
        } finally {
          await handle.close();
        }
        if (stamp(await fs.lstat(fullPath, { bigint: true })) !== stamp(before)) throw sourceChanged();
        assertSafeFile(name, bytes);
        if (!skip) {
          files.set(name, bytes);
          stamps.set(name, stamp(before));
        }
      } else {
        throw new Error("Unsupported special file inside extension: " + name);
      }
    }
  }

  await walk(extension);
  directories.sort(order);
  const sortedFiles = new Map([...files].sort(([a], [b]) => order(a, b)));
  const manifest = validateExtension(sortedFiles);
  return { files: sortedFiles, directories, manifest, stamps };
}

async function assertSourceUnchanged(rootDir, snapshot) {
  let current;
  try {
    current = await readExtensionSnapshot(rootDir);
  } catch (error) {
    throw new Error(sourceChanged().message + " Revalidation failed: " + error.message);
  }
  if (
    JSON.stringify(current.directories) !== JSON.stringify(snapshot.directories) ||
    current.files.size !== snapshot.files.size ||
    [...snapshot.files].some(([name, bytes]) =>
      !current.files.has(name) || !bytes.equals(current.files.get(name)) ||
      snapshot.stamps.get(name) !== current.stamps.get(name))
  ) throw sourceChanged();
}

function archiveEntries(snapshot) {
  return new Map([
    ["extension/", Buffer.alloc(0)],
    ...snapshot.directories.map(name => ["extension/" + name + "/", Buffer.alloc(0)]),
    ...[...snapshot.files].map(([name, bytes]) => ["extension/" + name, bytes]),
  ].sort(([a], [b]) => order(a, b)));
}

function buildArchive(snapshot) {
  const entries = archiveEntries(snapshot);
  if (entries.size >= 0xffff) throw new Error("Too many entries for this release ZIP.");
  const input = Object.create(null);
  for (const [name, bytes] of entries) {
    input[name] = [bytes, {
      level: 6,
      // Fixed local DOS date and Unix attributes keep ZIP metadata consistent.
      mtime: new Date(1980, 0, 1, 0, 0, 0),
      os: 3,
      attrs: name.endsWith("/") ? (0o40755 << 16) | 16 : (0o100644 << 16),
    }];
  }
  return Buffer.from(zipSync(input));
}

function verifyArchive(zipBytes, snapshot) {
  const zip = Buffer.from(zipBytes);
  const expected = archiveEntries(snapshot);
  const invalid = () => { throw new Error("ZIP verification failed: entries, headers, or extracted bytes do not match the extension snapshot."); };
  // Audit central entries too: unzipSync's name-keyed object alone hides duplicates.
  // Only the simple ZIP32 format generated above is accepted.
  const end = zip.length - 22;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) invalid();
  const count = zip.readUInt16LE(end + 10);
  const centralSize = zip.readUInt32LE(end + 12);
  const centralStart = zip.readUInt32LE(end + 16);
  if (zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) ||
      zip.readUInt16LE(end + 8) !== count || count !== expected.size ||
      centralStart + centralSize !== end || zip.readUInt16LE(end + 20)) invalid();
  const names = [];
  let cursor = centralStart;
  let localCursor = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || extraLength || commentLength) invalid();
    const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString("utf8");
    if (!nameBytes.equals(Buffer.from(name)) || !expected.has(name) || names.includes(name)) invalid();
    validateArchivePath(name.endsWith("/") ? name.slice(0, -1) : name);
    const expectedBytes = expected.get(name);
    const attributes = name.endsWith("/") ? (0o40755 << 16) | 16 : (0o100644 << 16);
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    if (zip.readUInt8(cursor + 5) !== 3 ||
        zip.readUInt32LE(cursor + 38) !== (attributes >>> 0) ||
        (flags & ~0x800) || ![0, 8].includes(method) ||
        zip.readUInt32LE(cursor + 24) !== expectedBytes.length ||
        zip.readUInt32LE(cursor + 16) !== crc32(expectedBytes) ||
        zip.readUInt16LE(cursor + 34) !== 0) invalid();
    const local = zip.readUInt32LE(cursor + 42);
    if (local !== localCursor || local + 30 > centralStart || zip.readUInt32LE(local) !== 0x04034b50) invalid();
    const localNameLength = zip.readUInt16LE(local + 26);
    const localExtraLength = zip.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (localExtraLength || dataStart + compressedSize > centralStart ||
        !zip.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes) ||
        zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method ||
        zip.readUInt32LE(local + 14) !== crc32(expectedBytes) ||
        zip.readUInt32LE(local + 18) !== compressedSize ||
        zip.readUInt32LE(local + 22) !== expectedBytes.length) invalid();
    localCursor = dataStart + compressedSize;
    names.push(name);
    cursor = next;
  }
  if (cursor !== end || localCursor !== centralStart ||
      JSON.stringify(names) !== JSON.stringify([...expected.keys()])) invalid();
  let extracted;
  try { extracted = unzipSync(zip); } catch { invalid(); }
  if (Object.keys(extracted).length !== expected.size) invalid();
  for (const [name, bytes] of expected) {
    if (!extracted[name] || !Buffer.from(extracted[name]).equals(bytes)) invalid();
  }
  return true;
}

function runFullTests(rootDir, { stdio = "inherit" } = {}) {
  return new Promise((resolve, reject) => {
    // No shell or npm recursion: Node runs the full suite in a fresh process.
    // Tiny fixture tests of this helper must not inherit Node's worker marker,
    // which would make Node silently skip the child test runner.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test"], {
      cwd: rootDir, stdio, shell: false, windowsHide: true, env,
    });
    child.once("error", () => reject(new Error("Could not start node --test. No release was created.")));
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(
      new Error("Tests failed (" + (signal ?? code) + "). No release was created."),
    ));
  });
}

async function assertOutputAbsent(outputPath) {
  try { await fs.lstat(outputPath); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Release already exists: " + outputPath + ". Move/remove that ZIP explicitly, or deliberately choose a new manifest version. It will not be overwritten.");
}

async function packageExtension(options = {}) {
  const rootDir = await fs.realpath(options.rootDir ?? DEFAULT_ROOT);
  if (typeof crc32 !== "function") throw new Error("Packaging requires Node.js 22.2 or newer.");
  const snapshot = await readExtensionSnapshot(rootDir);
  const version = snapshot.manifest.version;
  const dist = path.join(rootDir, "dist");
  const outputPath = path.join(dist, "TikTok-Live-Tracker-" + version + ".zip");
  try { await requireDirectory(dist); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await assertOutputAbsent(outputPath);
  await (options.runTests ?? runFullTests)(rootDir);
  await assertSourceUnchanged(rootDir, snapshot);
  try { await fs.mkdir(dist); } catch (error) { if (error.code !== "EEXIST") throw error; }
  await requireDirectory(dist);
  const tempDirectory = await fs.mkdtemp(path.join(dist, ".package-"));
  const tempZip = path.join(tempDirectory, "release.zip");
  try {
    const archive = await (options.buildZip ?? buildArchive)(snapshot);
    const handle = await fs.open(tempZip, "wx");
    try { await handle.writeFile(archive); await handle.sync(); } finally { await handle.close(); }
    const written = await fs.readFile(tempZip);
    await (options.verifyZip ?? verifyArchive)(written, snapshot);
    await assertSourceUnchanged(rootDir, snapshot);
    await requireDirectory(dist);
    // link atomically fails if the destination exists; rename could overwrite it.
    // Both paths are on the same volume; unsupported filesystems fail safely.
    try { await fs.link(tempZip, outputPath); } catch (error) {
      if (error.code === "EEXIST") await assertOutputAbsent(outputPath);
      throw new Error("Could not publish the verified ZIP (" + (error.code ?? "filesystem error") + "). No existing release was overwritten. Use a local filesystem supporting hard links.");
    }
    return { outputPath, version, fileCount: snapshot.files.size, archiveBytes: written.length };
  } finally {
    // Exact invocation-owned paths only; never recursively remove dist or a release.
    await fs.unlink(tempZip).catch(error => { if (error.code !== "ENOENT") throw error; });
    await fs.rmdir(tempDirectory);
  }
}

module.exports = { readExtensionSnapshot, buildArchive, verifyArchive, packageExtension, runFullTests };

if (require.main === module) {
  if (process.argv.length > 2) {
    console.error("Usage: npm run package (no test-bypass or overwrite options).");
    process.exitCode = 1;
  } else {
    console.log("Validating the current extension and running node --test before packaging...");
    packageExtension().then(result => {
      console.log("Verified ZIP: " + result.outputPath);
      console.log("Manifest version: " + result.version);
      console.log("Packaged files: " + result.fileCount);
      console.log("Archive size: " + result.archiveBytes.toLocaleString("en-US") + " bytes");
    }).catch(error => {
      console.error("Packaging failed: " + error.message);
      process.exitCode = 1;
    });
  }
}
