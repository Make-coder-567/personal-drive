/* 分享文件流式下载 Service Worker
 * 作用：把多个分片 URL 拼成一个普通的 HTTP 下载响应，交给浏览器/手机的原生下载管理器，
 *      从而绕过移动端没有 File System Access API、JS 拼 Blob 会 OOM 的限制。
 * 只拦截 /__dl__/<token>，其余请求一律放行。
 */
const downloads = new Map();

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'set-download' && d.token && d.file) {
    downloads.set(d.token, d.file);
    if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: true });
  } else if (d.type === 'clear-download' && d.token) {
    downloads.delete(d.token);
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/__dl__/')) return;
  const token = url.pathname.slice('/__dl__/'.length);
  const file = downloads.get(token);
  if (!file) {
    event.respondWith(new Response('下载任务不存在或已过期，请重新点击下载。', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }));
    return;
  }
  event.respondWith(streamFile(token, file));
});

function streamFile(token, file) {
  const base = String(file.name || 'download').split('/').pop();
  const encoded = encodeURIComponent(base);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="download"; filename*=UTF-8\'\'' + encoded,
    'Cache-Control': 'no-store',
  };
  if (file.size > 0) headers['Content-Length'] = String(file.size);
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (let i = 0; i < file.parts.length; i++) {
          const r = await fetch(file.parts[i], { cache: 'no-store' });
          if (!r.ok) throw new Error('分片 ' + i + ' 下载失败 (' + r.status + ')');
          const reader = r.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        downloads.delete(token);
      }
    },
    cancel() { downloads.delete(token); },
  });
  return new Response(stream, { headers });
}
