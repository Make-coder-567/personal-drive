import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置：复用 Vite 产出的 dist/ 作为 Web 内核。
 * 不设置 server.url，避免打包产物依赖本地开发服务器；Android 使用 https scheme 以启用安全上下文。
 */
const config: CapacitorConfig = {
  appId: 'com.workbuddy.personaldrive',
  appName: '个人云盘',
  webDir: 'dist',
  android: {
    androidScheme: 'https',
  },
};

export default config;
