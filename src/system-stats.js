const os = require('os');
const { execFile } = require('child_process');
const { logError } = require('./logger');

// 缓存上一次 CPU 采样，用于计算使用率
let prevCpuTimes = null;
let cachedCpuUsage = 0;
let cachedStats = null;
let lastUpdate = 0;

/**
 * 计算 CPU 使用率
 * 通过对比两次采样的 idle/total 时间差来计算
 */
function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }

  if (prevCpuTimes) {
    const idleDiff = totalIdle - prevCpuTimes.idle;
    const tickDiff = totalTick - prevCpuTimes.total;
    if (tickDiff > 0) {
      cachedCpuUsage = Math.round((1 - idleDiff / tickDiff) * 100);
    }
  }

  prevCpuTimes = { idle: totalIdle, total: totalTick };
  return cachedCpuUsage;
}

// 初始化 CPU 采样
getCpuUsage();

/**
 * 执行 nvidia-smi 获取 GPU 信息
 * 返回: { utilization, memUsed, memTotal, powerDraw, powerLimit, temp, name }
 */
function queryGpu() {
  return new Promise((resolve) => {
    const fields = [
      'name',
      'utilization.gpu',
      'memory.used',
      'memory.total',
      'power.draw',
      'power.limit',
      'temperature.gpu',
    ].join(',');

    execFile(
      'nvidia-smi',
      [`--query-gpu=${fields}`, '--format=csv,noheader,nounits'],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve(null);
          return;
        }
        const parts = stdout.trim().split(',').map((s) => s.trim());
        if (parts.length < 7) {
          resolve(null);
          return;
        }
        resolve({
          name: parts[0],
          utilization: parseInt(parts[1], 10) || 0,
          memUsed: parseInt(parts[2], 10) || 0,
          memTotal: parseInt(parts[3], 10) || 0,
          powerDraw: parseFloat(parts[4]) || 0,
          powerLimit: parseFloat(parts[5]) || 0,
          temp: parseInt(parts[6], 10) || 0,
        });
      }
    );
  });
}

/**
 * 查询 Ollama 已加载的模型（判断模型是否驻留显存）
 */
async function queryOllamaModels(host) {
  try {
    const res = await fetch(`${host}/api/ps`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.models || [];
  } catch {
    return [];
  }
}

/**
 * 获取完整系统状态
 * @param {string} ollamaHost - Ollama API 地址
 * @param {string} textModel - 文本模型名称
 */
async function getSystemStats(ollamaHost, textModel) {
  const now = Date.now();

  // 每 2 秒最多更新一次缓存
  if (cachedStats && now - lastUpdate < 2000) {
    return cachedStats;
  }
  lastUpdate = now;

  const cpuUsage = getCpuUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const [gpu, loadedModels] = await Promise.all([
    queryGpu(),
    queryOllamaModels(ollamaHost),
  ]);

  const modelLoaded = loadedModels.some(
    (m) => m.name === textModel || m.model === textModel
  );

  cachedStats = {
    timestamp: new Date().toISOString(),
    cpu: {
      usage: cpuUsage,
      cores: os.cpus().length,
      modelName: os.cpus()[0]?.model || 'Unknown',
      loadAvg: os.loadavg(),
    },
    memory: {
      total: Math.round(totalMem / 1024 / 1024 / 1024 * 100) / 100,
      used: Math.round(usedMem / 1024 / 1024 / 1024 * 100) / 100,
      free: Math.round(freeMem / 1024 / 1024 / 1024 * 100) / 100,
      usage: Math.round((usedMem / totalMem) * 100),
    },
    gpu: gpu
      ? {
          name: gpu.name,
          utilization: gpu.utilization,
          memUsed: gpu.memUsed,
          memTotal: gpu.memTotal,
          memUsage: Math.round((gpu.memUsed / gpu.memTotal) * 100),
          powerDraw: gpu.powerDraw,
          powerLimit: gpu.powerLimit,
          powerUsage: gpu.powerLimit > 0 ? Math.round((gpu.powerDraw / gpu.powerLimit) * 100) : 0,
          temp: gpu.temp,
        }
      : null,
    ollama: {
      modelLoaded,
      loadedModels: loadedModels.map((m) => ({
        name: m.name || m.model,
        size: m.size ? Math.round(m.size / 1024 / 1024 / 1024 * 100) / 100 : 0,
        expiresAt: m.expires_at || null,
      })),
    },
  };

  return cachedStats;
}

module.exports = { getSystemStats };
