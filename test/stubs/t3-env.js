// test/stubs/t3-env.js — T3 测试共用的临时环境工具（CONTRACT §11.2：只写 os.tmpdir()，前缀 qbank-t3-）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolvePaths } from '../../config.js';

export function makeTmpEnv(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-t3-'));
  const cfg = loadConfig({
    cwd: dir,
    env: { QBANK_DATA_DIR: dir, QBANK_LOGS_DIR: dir, QBANK_PORT: '0', ...extraEnv },
  });
  const paths = resolvePaths(cfg, { cwd: dir });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  return { dir, cfg, paths };
}

export function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, doc) {
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
}