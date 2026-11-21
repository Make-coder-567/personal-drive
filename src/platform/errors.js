/* NativeFs 统一错误类型（classic script，非 ESM） */
(function (global) {
  'use strict';

  var CODES = Object.freeze({
    CANCEL: 'E_NATIVEFS_CANCEL',
    PERM: 'E_NATIVEFS_PERM',
    IO: 'E_NATIVEFS_IO',
    UNSUPPORTED: 'E_NATIVEFS_UNSUPPORTED',
    IPC_TIMEOUT: 'E_IPC_TIMEOUT',
    INVALID_PATH: 'E_NATIVEFS_INVALID_PATH',
  });

  function NativeFsError(code, message, taskId, cause) {
    var error = new Error(message || code);
    error.name = 'NativeFsError';
    error.code = code || CODES.IO;
    if (taskId !== undefined) error.taskId = taskId;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function wrap(error, fallbackCode, taskId) {
    if (error instanceof Error && error.name === 'NativeFsError') return error;
    var code = fallbackCode || CODES.IO;
    var raw = String((error && error.code) || '');
    if (raw === 'E_NATIVEFS_CANCEL' || raw === 'AbortError' || raw === 'E_IPC_TIMEOUT') code = raw;
    return new NativeFsError(code, (error && error.message) || String(error), taskId, error);
  }

  global.NativeFsErrorCodes = CODES;
  global.NativeFsError = NativeFsError;
  global.NativeFsWrapError = wrap;
})(typeof window !== 'undefined' ? window : self);
