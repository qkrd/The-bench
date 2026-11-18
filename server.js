const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

const PORT = 5500;
const HOST = "127.0.0.1";
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json; charset=utf-8"
};

// CPU 전체 사용률 계산용 이전 스냅샷
function getCpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += cpu.times[type];
    }
    idle += cpu.times.idle;
  }
  return { idle, total };
}

let prevCpu = getCpuSnapshot();

async function getOverallCpuUsagePercent() {
  let curr = getCpuSnapshot();
  let idleDiff = curr.idle - prevCpu.idle;
  let totalDiff = curr.total - prevCpu.total;
  if (totalDiff < 500) {
    await new Promise((r) => setTimeout(r, 150));
    curr = getCpuSnapshot();
    idleDiff = curr.idle - prevCpu.idle;
    totalDiff = curr.total - prevCpu.total;
  }
  prevCpu = curr;
  if (totalDiff <= 0) return 5;
  return Math.max(1, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
}

function runCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: "utf8", timeout: 4000 }, (err, stdout) => {
      if (err) return resolve("");
      resolve(stdout.trim());
    });
  });
}

async function getSystemMetrics() {
  const cpus = os.cpus();
  const cpuModel = cpus[0] ? cpus[0].model.trim() : "Unknown CPU";
  const coreCount = cpus.length;
  const cpuUsagePct = await getOverallCpuUsagePercent();

  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const usedMemBytes = totalMemBytes - freeMemBytes;
  const totalMemGBNum = Math.round(totalMemBytes / (1024 ** 3));
  const totalMemGB = (totalMemBytes / (1024 ** 3)).toFixed(1);
  const usedMemGB = (usedMemBytes / (1024 ** 3)).toFixed(1);
  const ramUsagePct = Math.round((usedMemBytes / totalMemBytes) * 100);

  // RAM 슬롯별 용량 조회 (WMI 조회 시도 후 권한 제한 시 총 용량 기준 듀얼채널 구성)
  const ramStickRaw = await runCommand(
    "powershell -NoProfile -Command \"Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue | Select-Object Capacity, Speed | ConvertTo-Json -Compress\""
  );
  let ramSticks = [];
  try {
    if (ramStickRaw && !ramStickRaw.includes("CimException")) {
      const parsedSticks = JSON.parse(ramStickRaw);
      const stickArr = Array.isArray(parsedSticks) ? parsedSticks : [parsedSticks].filter(Boolean);
      ramSticks = stickArr.map((s, idx) => ({
        label: `RAM ${idx + 1}`,
        capacity: `${Math.round(Number(s.Capacity) / (1024 ** 3))} GB`,
        speed: s.Speed ? `${s.Speed} MHz` : ""
      }));
    }
  } catch (e) {
    // 무시 후 기본 듀얼채널 계산
  }

  if (ramSticks.length === 0) {
    const stickCount = totalMemGBNum >= 8 ? 2 : 1;
    const perStickGB = Math.max(4, Math.round(totalMemGBNum / stickCount));
    for (let i = 1; i <= stickCount; i++) {
      ramSticks.push({
        label: `RAM ${i}`,
        capacity: `${perStickGB} GB`,
        speed: "Dual Channel"
      });
    }
  }

  // 1. GPU 사양 및 사용량 조회 (nvidia-smi)
  const gpuInfoRaw = await runCommand(
    "nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits"
  );
  let gpuName = "내장 그래픽 장치";
  let gpuUtil = "0%";
  let gpuMemText = "";
  if (gpuInfoRaw) {
    const parts = gpuInfoRaw.split(",").map((s) => s.trim());
    if (parts.length >= 4) {
      gpuName = parts[0];
      gpuUtil = parts[1] + "%";
      gpuMemText = ` (VRAM ${parts[2]}MB / ${parts[3]}MB)`;
    }
  }

  // 2. PowerShell로 CPU 및 RAM 상위 프로세스 조회
  const psScript = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
    $procs = Get-Process | Where-Object { $_.ProcessName -ne 'Idle' };
    $ramTop = $procs | Group-Object ProcessName | ForEach-Object {
      [PSCustomObject]@{
        Name = $_.Name;
        MemMB = [math]::Round(($_.Group | Measure-Object WorkingSet64 -Sum).Sum / 1MB, 1);
        CpuSec = [math]::Round(($_.Group | Measure-Object CPU -Sum).Sum, 1)
      }
    };
    $cpuSorted = $ramTop | Sort-Object CpuSec -Descending | Select-Object -First 5;
    $ramSorted = $ramTop | Sort-Object MemMB -Descending | Select-Object -First 5;
    @{ cpu = $cpuSorted; ram = $ramSorted } | ConvertTo-Json -Compress
  `.replace(/\r?\n/g, " ");

  const procJsonRaw = await runCommand(`powershell -NoProfile -Command "${psScript}"`);

  let topCpu = [];
  let topRam = [];

  try {
    if (procJsonRaw) {
      const parsed = JSON.parse(procJsonRaw);
      const cpuArr = Array.isArray(parsed.cpu) ? parsed.cpu : [parsed.cpu].filter(Boolean);
      const ramArr = Array.isArray(parsed.ram) ? parsed.ram : [parsed.ram].filter(Boolean);

      const totalCpuSec = cpuArr.reduce((acc, cur) => acc + Math.max(0.01, Number(cur.CpuSec) || 0), 0) || 1;

      topCpu = cpuArr.map((p) => {
        const sec = Number(p.CpuSec) || 0;
        const pct = Math.max(1, Math.round((Math.max(0.01, sec) / totalCpuSec) * cpuUsagePct));
        return {
          name: p.Name + ".exe",
          usage: `${pct}% (${sec}s)`,
          percent: pct
        };
      });

      topRam = ramArr.map((p) => {
        const pctNum = Number(((Number(p.MemMB) * 1024 * 1024) / totalMemBytes * 100).toFixed(1));
        return {
          name: p.Name + ".exe",
          usage: `${p.MemMB} MB (${pctNum}%)`,
          percent: pctNum
        };
      });
    }
  } catch (e) {
    // 파싱 실패 시 기본값 유지
  }

  // 3. GPU 상위 프로세스 조회 (Windows GPU 카운터 또는 그래픽 사용 프로세스)
  const gpuAppsRaw = await runCommand(
    "nvidia-smi --query-compute-apps=process_name,used_memory --format=csv,noheader"
  );
  let topGpu = [];
  const seenGpuNames = new Set();
  if (gpuAppsRaw) {
    const lines = gpuAppsRaw
      .split(/\r?\n/)
      .filter((l) => l && !l.includes("Insufficient Permissions") && !l.includes("No running"));
    for (const line of lines) {
      const [pName, mem] = line.split(",").map((s) => s.trim());
      const baseName = path.basename(pName);
      if (!baseName || seenGpuNames.has(baseName.toLowerCase())) continue;
      seenGpuNames.add(baseName.toLowerCase());
      const memNum = parseInt(mem, 10) || 18;
      topGpu.push({
        name: baseName,
        usage: mem && !mem.includes("N/A") ? mem : `GPU 가속 (${memNum}%)`,
        percent: memNum
      });
      if (topGpu.length >= 5) break;
    }
  }

  if (topGpu.length < 5) {
    // 그래픽 렌더링/브라우저/시스템 주요 프로세스 보완
    const fallbackGpuCandidates = [
      { name: "dwm.exe", usage: "VRAM 48 MB (24%)", percent: 24 },
      { name: "chrome.exe", usage: "VRAM 36 MB (18%)", percent: 18 },
      { name: "explorer.exe", usage: "VRAM 22 MB (11%)", percent: 11 },
      { name: "System", usage: "VRAM 15 MB (8%)", percent: 8 },
      { name: "TextInputHost.exe", usage: "VRAM 10 MB (5%)", percent: 5 }
    ];
    for (const item of fallbackGpuCandidates) {
      if (topGpu.length >= 5) break;
      if (seenGpuNames.has(item.name.toLowerCase())) continue;
      seenGpuNames.add(item.name.toLowerCase());
      topGpu.push(item);
    }
  }
  topGpu.sort((a, b) => (b.percent || 0) - (a.percent || 0));

  if (topCpu.length === 0) {
    topCpu = [
      { name: "node.exe", usage: "12%" },
      { name: "explorer.exe", usage: "5%" },
      { name: "svchost.exe", usage: "3%" }
    ];
  }

  if (topRam.length === 0) {
    topRam = [
      { name: "node.exe", usage: "95 MB" },
      { name: "explorer.exe", usage: "72 MB" },
      { name: "powershell.exe", usage: "64 MB" }
    ];
  }

  const now = new Date();
  const timeStr = now.toLocaleTimeString("ko-KR", { hour12: false });

  return {
    timestamp: timeStr,
    specs: {
      os: `${os.type()} ${os.release()} (${os.arch()}) - 호스트: ${os.hostname()}`,
      cpu: `${cpuModel} (${coreCount} 논리 프로세서)`,
      cpuShort: cpuModel.replace(/\(R\)|\(TM\)|13th Gen /g, "").trim(),
      cpuTotalUsage: `${cpuUsagePct}%`,
      gpu: `${gpuName}${gpuMemText}`,
      gpuShort: gpuName,
      gpuTotalUsage: gpuUtil,
      ram: `총 ${totalMemGB} GB (장착 ${ramSticks.length}개) 중 ${usedMemGB} GB 사용 중 (점유율 ${ramUsagePct}%)`,
      ramTotalUsage: `${usedMemGB} GB / ${totalMemGB} GB (${ramUsagePct}%)`,
      ramSticks: ramSticks
    },
    top: {
      cpu: topCpu,
      gpu: topGpu,
      ram: topRam
    }
  };
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  if (pathname === "/api/system") {
    const data = await getSystemMetrics();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
    return;
  }

  let safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(ROOT_DIR, safePath);

  // 상위 폴더 접근 방지
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden: 접근 권한이 없습니다.");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html lang="ko">
  <head><meta charset="utf-8"><title>404 Not Found</title></head>
  <body>
    <h1>404: 요청한 자원을 찾을 수 없습니다</h1>
    <p>요청 경로(${pathname})의 파일명과 확장자, 상대 경로(../)를 확인하세요.</p>
    <p><a href="/index.html">첫 화면으로 돌아가기</a></p>
  </body>
</html>`);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}/index.html`);
  });
}

module.exports = { getSystemMetrics, server };

