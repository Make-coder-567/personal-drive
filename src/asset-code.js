    // 平台访问码：优先 URL，其次本地记住的；子资源（css/js/sw）都要带上，避免微信/非默认浏览器丢 Cookie 后 403
    window.__ASSET_CODE__ = '';
    (function () {
      try {
        var c = new URLSearchParams(location.search).get('sharecode') || '';
        if (c) { window.__ASSET_CODE__ = c; try { localStorage.setItem('drive_sharecode', c); } catch (e) {} }
        else { try { window.__ASSET_CODE__ = localStorage.getItem('drive_sharecode') || ''; } catch (e) {} }
      } catch (e) {}
    })();
    (function () {
      var c = window.__ASSET_CODE__ || '';
      var q = c ? ('&sharecode=' + encodeURIComponent(c)) : '';
      document.write('<link rel="stylesheet" href="style.css?v=20261119a' + q + '">');
    })();
