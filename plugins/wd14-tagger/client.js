/**
 * WD14 Python 标签服务 HTTP 客户端
 * 调用 wd14/wd14_service.py（FastAPI，默认端口 9898）
 */
const http = require('http');

/** 调用 Python 标签服务，返回 { available, rating, general, character } */
function tagImage(imageBase64, host = 'http://127.0.0.1:9898', timeout = 8000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ image: imageBase64 });
    let url;
    try {
      url = new URL('/tag', host);
    } catch {
      resolve({ available: false, error: 'WD14 服务地址无效: ' + host });
      return;
    }
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: '/tag',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.success) {
            resolve({ available: true, rating: data.rating, general: data.general, character: data.character });
          } else {
            // warming_up：模型仍在预热，属「暂时未就绪」而非服务故障。
            //   调用方据此跳过熔断计数，避免正常启动被误判成服务挂掉。
            resolve({ available: false, error: data.error, warmingUp: data.warming_up === true });
          }
        } catch {
          resolve({ available: false, error: 'WD14 返回解析失败' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ available: false, error: 'WD14 服务超时' }); });
    req.on('error', (e) => { resolve({ available: false, error: e.message }); });
    req.write(payload);
    req.end();
  });
}

/**
 * 健康检查。
 *
 * `available` 只表示**服务进程应答了**；模型是否就绪看 `ready` / `status`。
 * 旧版服务不返回 `ready` 字段，此时按「服务应答即可用」处理，保持向后兼容。
 * @param {string} host 服务地址
 * @param {number} timeout 超时（毫秒）
 * @returns {Promise<{available: boolean, ready?: boolean, status?: string, model?: string, loading?: boolean}>}
 */
function healthCheck(host = 'http://127.0.0.1:9898', timeout = 3000) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/health', host);
    } catch {
      resolve({ available: false });
      return;
    }
    const req = http.get({
      hostname: url.hostname,
      port: url.port || 80,
      path: '/health',
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve({
            available: true,
            ready: data.ready === undefined ? true : data.ready === true,
            status: data.status || '',
            phase: data.phase || '',
            model: data.model || '',
            loading: data.loading === true,
            warmupSeconds: data.warmup_seconds,
          });
        } catch {
          resolve({ available: true, ready: true });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ available: false }); });
    req.on('error', () => resolve({ available: false }));
  });
}

module.exports = { tagImage, healthCheck };
