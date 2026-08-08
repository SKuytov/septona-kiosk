'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { sha256, isPdf, httpError } = require('./util');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

/** Content-addressed: data/files/ab/cd/<sha>.pdf — dedupes bytes for free. */
function pathForHash(hash) {
  const dir = path.join(FILES_DIR, hash.slice(0, 2), hash.slice(2, 4));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${hash}.pdf`);
}

function store(buffer) {
  const hash = sha256(buffer);
  const abs = pathForHash(hash);
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buffer);
  return { hash, storedPath: path.relative(DATA_DIR, abs), sizeBytes: buffer.length };
}

/**
 * Deletes a stored blob, and prunes the two directory levels it lived in if they are now
 * empty. Never throws: a missing file means the job is already done, and a delete that
 * cannot reach the disk must not roll back a database transaction that already committed.
 *
 * The caller is responsible for checking that no other version still points at these bytes
 * — storage is content-addressed, so two documents holding an identical file share one blob.
 * @param {string} storedPath path relative to DATA_DIR @returns {boolean} whether a file went
 */
function removeStored(storedPath) {
  try {
    const abs = path.join(DATA_DIR, storedPath);
    if (!fs.existsSync(abs)) return false;
    fs.unlinkSync(abs);
    for (const dir of [path.dirname(abs), path.dirname(path.dirname(abs))]) {
      if (path.relative(FILES_DIR, dir).startsWith('..')) break;
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      else break;
    }
    return true;
  } catch (e) {
    console.error('[storage] could not remove', storedPath, e.message);
    return false;
  }
}

const readStored = (storedPath) => fs.readFileSync(path.join(DATA_DIR, storedPath));
const absPath = (storedPath) => path.join(DATA_DIR, storedPath);
const existsStored = (storedPath) => fs.existsSync(absPath(storedPath));

/** Headless LibreOffice → PDF. Used by the one-off archive importer only; uploads through
 *  the interface are PDF-only. */
async function convertToPdf(buffer, originalName) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sepconv-'));
  const src = path.join(work, path.basename(originalName));
  fs.writeFileSync(src, buffer);
  try {
    await execFileP(
      'soffice',
      ['--headless', '--norestore', `-env:UserInstallation=file://${work}/profile`,
       '--convert-to', 'pdf:writer_pdf_Export', '--outdir', work, src],
      { timeout: 120000, maxBuffer: 32 * 1024 * 1024 }
    );
    const out = path.join(work, path.basename(originalName).replace(/\.[^.]+$/, '') + '.pdf');
    if (!fs.existsSync(out))
      throw httpError(422, 'CONVERSION_FAILED', `Неуспешно преобразуване на ${originalName}.`);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Normalise an upload into PDF bytes, honouring the PDF-only policy.
 * @param {Buffer} buffer @param {string} originalName @param {boolean} allowConversion
 */
async function toPdfBuffer(buffer, originalName, allowConversion) {
  if (isPdf(buffer)) return { buffer, converted: false };
  if (!allowConversion)
    throw httpError(415, 'UNSUPPORTED_FILE_TYPE', 'Приемат се само PDF файлове.');
  return { buffer: await convertToPdf(buffer, originalName), converted: true };
}

module.exports = {
  DATA_DIR, FILES_DIR, store, readStored, removeStored, absPath, existsStored,
  convertToPdf, toPdfBuffer,
};
