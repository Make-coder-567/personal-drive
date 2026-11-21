/* 路径与 URL 白名单校验：主进程不信任渲染层传入的参数。 */
const path = require('node:path');
const { URL } = require('node:url');

/** 额外允许的 HTTPS 主机，逗号分隔；为空时允许所有 HTTPS 外链。 */
function allowedHosts() {
  return String(process.env.ELECTRON_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/** 外链仅允许 HTTPS（可配置主机白名单），拒绝用户名密码与协议相对 URL。 */
function isAllowedExternalUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    const hosts = allowedHosts();
    return hosts.length === 0 || hosts.includes(url.hostname.toLowerCase());
  } catch (error) {
    return false;
  }
}

/** 分片 URL 必须是 HTTPS 直链；Web 端签名 URL 与公开直链均为 HTTPS。 */
function validatePartUrl(rawUrl, index) {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    throw Object.assign(new Error(`分片 ${index} 缺少 url`), { code: 'E_NATIVEFS_INVALID_PATH' });
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw Object.assign(new Error(`分片 ${index} URL 非法`), { code: 'E_NATIVEFS_INVALID_PATH' });
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw Object.assign(new Error(`分片 ${index} 仅允许 HTTPS 直链`), { code: 'E_NATIVEFS_INVALID_PATH' });
  }
  return rawUrl;
}

/**
 * 解析并校验落盘目标。
 * - pickSavePath 返回 kind:'file'，直接使用 filePath；
 * - pickFolder 返回 kind:'folder'，必须与相对路径拼装，且相对路径不得逃逸目录。
 */
function resolveTarget(target) {
  if (!target || typeof target !== 'object' || typeof target.filePath !== 'string' || !target.filePath) {
    throw Object.assign(new Error('保存目标 filePath 非法'), { code: 'E_NATIVEFS_INVALID_PATH' });
  }
  const base = path.resolve(target.filePath);
  if (target.kind !== 'folder') return base;

  const rawRelative = String(target.relativePath || '');
  if (!rawRelative) {
    throw Object.assign(new Error('目录保存缺少 relativePath'), { code: 'E_NATIVEFS_INVALID_PATH' });
  }
  const normalized = path.normalize(rawRelative).replace(/^([/\\]|\.\.[/\\])+/, '');
  if (path.isAbsolute(normalized) || normalized.split(/[/\\]/).includes('..')) {
    throw Object.assign(new Error('relativePath 不允许逃逸目标目录'), { code: 'E_NATIVEFS_INVALID_PATH' });
  }
  const resolved = path.resolve(base, normalized);
  if (!resolved.startsWith(base + path.sep)) {
    throw Object.assign(new Error('relativePath 逃逸目标目录'), { code: 'E_NATIVEFS_INVALID_PATH' });
  }
  return resolved;
}

/**
 * 校验本地读取路径。可用 ELECTRON_ALLOWED_READ_ROOTS（分号/逗号分隔）限制可读根目录；
 * 未配置时允许绝对路径（与用户通过原生对话框自选保存位置的模型一致）。
 */
function validateReadPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.indexOf('\0') !== -1) {
    throw Object.assign(new Error('读取路径非法'), { code: 'E_NATIVEFS_INVALID_PATH' });
  }
  const resolved = path.resolve(rawPath);
  const roots = String(process.env.ELECTRON_ALLOWED_READ_ROOTS || '')
    .split(/[;,]/)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));
  const allowed = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (roots.length && !allowed) {
    throw Object.assign(new Error('读取路径不在白名单目录内'), { code: 'E_NATIVEFS_INVALID_PATH' });
  }
  return resolved;
}

module.exports = { isAllowedExternalUrl, validatePartUrl, resolveTarget, validateReadPath };
