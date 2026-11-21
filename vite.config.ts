import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Vite 只负责 Web 静态包构建与配置注入。
 * 生成 __config__.js 与本地 vendor 由构建脚本在 buildStart 阶段同步完成，
 * 保证 public/ 中的产物在 Vite 复制之前已经落盘。
 */
export default defineConfig(({ mode }) => {
  const root = process.cwd();
  const env = loadEnv(mode, root, '');
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };

  const runScript = (name: string): void => {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts', name)], {
      cwd: root,
      env: childEnv,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`[vite] 预构建脚本 ${name} 失败（exit ${result.status}），请查看上方输出。`);
    }
  };

  const prebuild: Plugin = {
    name: 'personal-drive-prebuild',
    enforce: 'pre',
    buildStart() {
      runScript('gen-config.mjs');
      runScript('build-vendor.mjs');
    },
  };

  // 内核文件是 classic script / CSS，Vite 不会打包它们；按原相对路径原样复制到 dist。
  // 使用读写流而非 cpSync，避免部分平台对 unlink 的限制。
  const copyKernelFile = (from: string, to: string): void => {
    mkdirSync(resolve(to, '..'), { recursive: true });
    writeFileSync(to, readFileSync(from));
  };
  const copyKernelTree = (from: string, to: string): void => {
    for (const name of readdirSync(from)) {
      const source = resolve(from, name);
      const target = resolve(to, name);
      if (statSync(source).isDirectory()) copyKernelTree(source, target);
      else copyKernelFile(source, target);
    }
  };
  const copyKernel: Plugin = {
    name: 'personal-drive-kernel-copy',
    apply: 'build',
    closeBundle() {
      for (const rel of ['app.js', 'accel.js', 'sw.js', 'style.css', 'src']) {
        const source = resolve(root, rel);
        const target = resolve(root, 'dist', rel);
        if (statSync(source).isDirectory()) copyKernelTree(source, target);
        else copyKernelFile(source, target);
      }
    },
  };

  return {
    root,
    base: './',
    publicDir: 'public',
    clearScreen: false,
    plugins: [prebuild, copyKernel],
    define: {
      __APP_VERSION__: JSON.stringify(env.VITE_APP_VERSION || '1.0.0'),
    },
    server: {
      host: true,
      port: 5173,
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2020',
      assetsDir: 'assets',
      rollupOptions: {
        input: resolve(root, 'index.html'),
      },
    },
  };
});
