/* 主进程流式下载写盘：按分片顺序拉取 HTTPS 流，追加写入用户选择的文件。 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { validatePartUrl, resolveTarget } = require('./path-guard');

const activeTasks = new Map();

function createIpcError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

/** 等待可写事件，保证背压不会在渲染进程/主进程堆积整文件。 */
function waitForDrain(stream) {
  return new Promise((resolve) => stream.once('drain', resolve));
}

async function streamParts(request, onProgress) {
  const taskId = String(request.taskId || `electron-${Date.now()}`);
  const parts = Array.isArray(request.parts) ? request.parts : [];
  if (parts.length === 0) throw createIpcError('E_NATIVEFS_INVALID_PATH', '没有可下载的分片');

  const checkedParts = parts.map((part, index) => {
    const source = typeof part === 'string' ? { url: part } : part || {};
    const url = validatePartUrl(source.url, index);
    const headers = {};
    if (source.headers && typeof source.headers === 'object') {
      for (const [key, value] of Object.entries(source.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
    }
    return { url, headers };
  });

  const filePath = resolveTarget(request.target);
  const totalSize = Number(request.totalSize) || 0;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  // 清空旧内容（保留后续分片统一以 'a' 追加写的语义）
  await fsp.writeFile(filePath, Buffer.alloc(0));

  const controller = new AbortController();
  const state = { controller, canceled: false, written: 0 };
  activeTasks.set(taskId, state);

  let output = null;
  try {
    output = fs.createWriteStream(filePath, { flags: 'a' });
    for (let i = 0; i < checkedParts.length; i++) {
      if (state.canceled) throw createIpcError('E_NATIVEFS_CANCEL', '已取消');
      const part = checkedParts[i];
      const response = await fetch(part.url, {
        headers: part.headers,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        throw createIpcError('E_NATIVEFS_IO', `分片 ${i} 下载失败（HTTP ${response.status}）`);
      }
      if (!response.body) throw createIpcError('E_NATIVEFS_IO', `分片 ${i} 无响应流`);

      const reader = response.body.getReader();
      while (true) {
        if (state.canceled) throw createIpcError('E_NATIVEFS_CANCEL', '已取消');
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (!output.write(chunk)) await waitForDrain(output);
        state.written += chunk.length;
        if (onProgress) onProgress(state.written, totalSize || state.written);
      }
    }
    await new Promise((resolve, reject) => {
      output.end((error) => (error ? reject(error) : resolve()));
    });
    output = null;
    return { path: filePath, bytesWritten: state.written, canceled: false };
  } catch (error) {
    if (output) {
      output.destroy();
      output = null;
    }
    if (state.canceled || error.name === 'AbortError') {
      throw createIpcError('E_NATIVEFS_CANCEL', '已取消（已保留部分文件）');
    }
    if (error.code && String(error.code).startsWith('E_NATIVEFS_')) throw error;
    throw createIpcError('E_NATIVEFS_IO', error.message || String(error), error);
  } finally {
    activeTasks.delete(taskId);
  }
}

function cancel(taskId) {
  const state = activeTasks.get(String(taskId));
  if (!state) return false;
  state.canceled = true;
  state.controller.abort();
  return true;
}

module.exports = { streamParts, cancel, activeTasks };
