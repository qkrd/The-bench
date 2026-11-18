(function (global) {
  "use strict";

  var RAM_OPTIONS = [8, 16, 32, 64];

  function normalizeText(value) {
    return String(value || "")
      .replace(/\(R\)|\(TM\)|®|™/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenize(value) {
    return normalizeText(value)
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  function cleanGpuName(raw) {
    if (!raw) return "";
    var s = normalizeText(raw);

    // Unwrap ANGLE (...) wrapper
    var angleMatch = s.match(/^ANGLE\s*\(([\s\S]*)\)$/i);
    if (angleMatch) {
      s = angleMatch[1].trim();
    }

    // Handle leading vendor prefix inside ANGLE: "NVIDIA, NVIDIA GeForce ..." or "Apple, ANGLE Metal Renderer: Apple M3"
    var vendorMatch = s.match(/^(NVIDIA|AMD|ATI|Intel|Apple|Qualcomm|ARM|Microsoft)\s*,\s*(.+)$/i);
    if (vendorMatch) {
      var vendor = vendorMatch[1];
      var rest = vendorMatch[2].trim().replace(/^ANGLE\s+Metal\s+Renderer:\s*/i, "");
      if (rest.toLowerCase().indexOf(vendor.toLowerCase()) === 0) {
        s = rest;
      } else if (/^(geforce|radeon|arc|uhd|iris|hd graphics|apple)/i.test(rest)) {
        s = vendor + " " + rest;
      } else {
        s = rest;
      }
    }

    // Strip PCI device IDs and Direct3D / D3D / OpenGL / Vulkan / PCIe / trailing driver suffixes
    s = s
      .replace(/\s*\(0x[0-9a-f]+\)/gi, "")
      .replace(/\s*(?:Direct3D\d*|D3D\d*|OpenGL|Vulkan)\b[\s\S]*$/i, "")
      .replace(/\s*\/PCIe[\s\S]*$/i, "")
      .replace(/\s*,\s*(?:D3D\d*|Unspecified Version)\s*$/i, "");

    return normalizeText(s);
  }

  function detectOsName() {
    if (typeof navigator === "undefined") return "";
    var ua = navigator.userAgent || "";
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";

    if (/Windows NT 10\.0/i.test(ua)) return "Windows 10/11";
    if (/Windows NT 6\.3/i.test(ua)) return "Windows 8.1";
    if (/Windows NT 6\.2/i.test(ua)) return "Windows 8";
    if (/Windows NT 6\.1/i.test(ua)) return "Windows 7";
    if (/Windows/i.test(ua) || /Win/i.test(platform)) return "Windows";
    if (/Mac OS X|Macintosh/i.test(ua) || /Mac/i.test(platform)) return "macOS";
    if (/Android/i.test(ua)) return "Android";
    if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
    if (/Linux/i.test(ua) || /Linux/i.test(platform)) return "Linux";
    return platform || "";
  }

  function detectWebGlGpu() {
    if (typeof document === "undefined" || !document.createElement) return "";
    try {
      var canvas = document.createElement("canvas");
      var gl =
        canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl") ||
        canvas.getContext("webgl2");
      if (!gl) return "";

      var debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      var rawRenderer = debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);

      return cleanGpuName(rawRenderer);
    } catch (e) {
      return "";
    }
  }

  function detectBrowserSpecs() {
    var nav = typeof navigator !== "undefined" ? navigator : {};
    var scr = typeof screen !== "undefined" ? screen : {};

    var cpuThreads =
      typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency > 0
        ? nav.hardwareConcurrency
        : null;

    var ramGb =
      typeof nav.deviceMemory === "number" && nav.deviceMemory > 0
        ? nav.deviceMemory
        : null;

    var resolution =
      typeof scr.width === "number" && typeof scr.height === "number" && scr.width > 0 && scr.height > 0
        ? scr.width + "x" + scr.height
        : "";

    return {
      cpuName: "",
      cpuThreads: cpuThreads,
      gpuName: detectWebGlGpu(),
      ramGb: ramGb,
      osName: detectOsName(),
      resolution: resolution,
      sourceType: "browser"
    };
  }

  function cleanDxDiagCpu(raw) {
    if (!raw) return "";
    var cleaned = raw
      .replace(/\(\s*~?\s*\d+\s*(?:CPUs?|개\s*CPU|논리\s*프로세서)\s*\)/gi, "")
      .replace(/,?\s*~?\s*[\d.]+\s*GHz\b/gi, "");
    return normalizeText(cleaned);
  }

  function parseMemoryToGb(raw, roundToInt) {
    if (!raw) return null;
    var match = String(raw).replace(/,/g, "").match(/([\d.]+)\s*(MB|GB)\b/i);
    if (!match) return null;

    var num = parseFloat(match[1]);
    if (!isFinite(num) || num <= 0) return null;

    var unit = match[2].toUpperCase();
    var gb = unit === "MB" ? num / 1024 : num;
    if (roundToInt) {
      return gb >= 0.5 ? Math.round(gb) : Math.round(gb * 10) / 10;
    }
    return Math.round(gb * 10) / 10;
  }

  function getGpuPriority(name, dedicatedMb) {
    var lower = String(name || "").toLowerCase();
    if (!lower || /microsoft basic|remote|virtual|parsec|iddcx/i.test(lower)) {
      return 0;
    }
    if (/\b(?:nvidia|geforce|rtx|gtx|quadro|titan)\b/i.test(lower)) {
      return 3;
    }
    if (/\b(?:radeon\s*rx|radeon\s*pro|radeon\s*r[79]|firepro)\b/i.test(lower)) {
      return 3;
    }
    if (/\bintel\b.*\barc\b/i.test(lower)) {
      return 3;
    }
    if (typeof dedicatedMb === "number" && dedicatedMb >= 2048) {
      return 2;
    }
    if (typeof dedicatedMb === "number" && dedicatedMb >= 1024) {
      return 1.5;
    }
    return 1;
  }

  function parseDxDiagText(text) {
    var emptyResult = {
      ok: false,
      cpuName: "",
      cpuThreads: null,
      gpuName: "",
      gpuVramGb: null,
      ramGb: null,
      osName: "",
      systemModel: "",
      sourceType: "dxdiag",
      error: ""
    };

    if (typeof text !== "string" || !text.trim()) {
      emptyResult.error = "DxDiag.txt 내용이 비어 있습니다.";
      return emptyResult;
    }

    var lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

    var cpuName = "";
    var cpuThreads = null;
    var ramGb = null;
    var fallbackRamGb = null;
    var osName = "";
    var systemModel = "";
    var displayDevices = [];
    var currentDevice = null;
    var inDisplaySection = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      if (!trimmed) continue;

      if (/^(?:Display Devices|디스플레이 장치)$/i.test(trimmed)) {
        inDisplaySection = true;
        continue;
      }
      if (
        inDisplaySection &&
        /^(?:Sound Devices|DirectShow|Sound Capture Devices|DirectInput Devices|System Devices|소리 장치|사운드 장치|DirectInput 장치|시스템 장치)$/i.test(
          trimmed
        )
      ) {
        inDisplaySection = false;
        currentDevice = null;
        continue;
      }

      var kv = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
      if (!kv) continue;

      var label = kv[1].trim();
      var value = kv[2].trim();

      if (/^(?:Operating System|운영 체제)$/i.test(label) && !osName) {
        osName = normalizeText(value);
      } else if (/^(?:System Model|시스템 모델)$/i.test(label) && !systemModel) {
        systemModel = normalizeText(value);
      } else if (/^(?:Processor|프로세서)$/i.test(label) && !cpuName) {
        var threadMatch = value.match(/\(\s*~?\s*(\d+)\s*(?:CPUs?|개\s*CPU|논리\s*프로세서)\s*\)/i);
        if (threadMatch) {
          cpuThreads = parseInt(threadMatch[1], 10);
        }
        cpuName = cleanDxDiagCpu(value);
      } else if (/^(?:Memory|메모리)$/i.test(label) && ramGb === null) {
        ramGb = parseMemoryToGb(value, true);
      } else if (/^(?:Available OS Memory|사용 가능한 OS 메모리)$/i.test(label) && fallbackRamGb === null) {
        fallbackRamGb = parseMemoryToGb(value, true);
      } else if (/^(?:Card name|카드 이름)$/i.test(label)) {
        currentDevice = {
          name: normalizeText(value),
          dedicatedMb: null,
          dedicatedGb: null
        };
        displayDevices.push(currentDevice);
      } else if (currentDevice && /^(?:Dedicated Memory|전용 메모리)$/i.test(label)) {
        var vramMatch = value.replace(/,/g, "").match(/([\d.]+)\s*(MB|GB)\b/i);
        if (vramMatch) {
          var vramNum = parseFloat(vramMatch[1]);
          var vramUnit = vramMatch[2].toUpperCase();
          currentDevice.dedicatedMb = vramUnit === "GB" ? vramNum * 1024 : vramNum;
          currentDevice.dedicatedGb = parseMemoryToGb(value, false);
        }
      }
    }

    if (ramGb === null && fallbackRamGb !== null) {
      ramGb = fallbackRamGb;
    }

    var chosenGpu = null;
    if (displayDevices.length > 0) {
      var bestScore = -1;
      for (var d = 0; d < displayDevices.length; d++) {
        var dev = displayDevices[d];
        var priority = getGpuPriority(dev.name, dev.dedicatedMb);
        var vramBonus = typeof dev.dedicatedMb === "number" ? dev.dedicatedMb / 100000 : 0;
        var totalPriority = priority + vramBonus;
        if (totalPriority > bestScore) {
          bestScore = totalPriority;
          chosenGpu = dev;
        }
      }
    }

    var gpuName = chosenGpu ? chosenGpu.name : "";
    var gpuVramGb = chosenGpu ? chosenGpu.dedicatedGb : null;

    if (!cpuName && !gpuName && ramGb === null && !osName) {
      emptyResult.error =
        "올바른 DxDiag.txt 형식이 아닙니다. Windows dxdiag의 [모든 정보 저장]으로 저장한 텍스트 파일을 선택해 주세요.";
      return emptyResult;
    }

    return {
      ok: true,
      cpuName: cpuName,
      cpuThreads: cpuThreads,
      gpuName: gpuName,
      gpuVramGb: gpuVramGb,
      ramGb: ramGb,
      osName: osName,
      systemModel: systemModel,
      sourceType: "dxdiag",
      error: ""
    };
  }

  function extractModelNumbers(text) {
    var matches = normalizeText(text).toLowerCase().match(/\b[a-z]*\d{3,5}[a-z0-9]*\b/g);
    return matches || [];
  }

  function computeNameMatchScore(query, item) {
    if (!query || !item) return 0;
    var normQuery = normalizeText(query).toLowerCase();
    if (!normQuery) return 0;

    var candidates = [item.name].concat(Array.isArray(item.aliases) ? item.aliases : []).filter(Boolean);
    var best = 0;

    for (var i = 0; i < candidates.length; i++) {
      var cand = normalizeText(candidates[i]).toLowerCase();
      if (!cand) continue;

      if (normQuery === cand) {
        return 1000;
      }
      if (normQuery.indexOf(cand) !== -1 || cand.indexOf(normQuery) !== -1) {
        best = Math.max(best, 850);
      }

      var queryModels = extractModelNumbers(normQuery);
      var candModels = extractModelNumbers(cand);
      for (var m = 0; m < candModels.length; m++) {
        if (queryModels.indexOf(candModels[m]) !== -1) {
          var laptopMatch =
            /laptop|mobile/i.test(normQuery) === /laptop|mobile/i.test(cand) ? 100 : 0;
          best = Math.max(best, 700 + laptopMatch);
        }
      }

      var qTokens = tokenize(normQuery);
      var cTokens = tokenize(cand);
      var overlap = 0;
      for (var t = 0; t < cTokens.length; t++) {
        if (qTokens.indexOf(cTokens[t]) !== -1) {
          overlap++;
        }
      }
      if (cTokens.length > 0 && overlap > 0) {
        var ratioScore = Math.round((overlap / cTokens.length) * 400);
        best = Math.max(best, ratioScore);
      }
    }

    return best;
  }

  function cloneWithMeta(item, recommended, matchScore, label) {
    var copy = {};
    var keys = Object.keys(item);
    for (var i = 0; i < keys.length; i++) {
      copy[keys[i]] = item[keys[i]];
    }
    copy.recommended = Boolean(recommended);
    copy.matchScore = matchScore;
    copy.label = label;
    return copy;
  }

  function getRecommendedOptions(detected, benchmarksData) {
    var det = detected || {};
    var data = benchmarksData || {};
    var cpus = Array.isArray(data.cpus) ? data.cpus : [];
    var gpus = Array.isArray(data.gpus) ? data.gpus : [];

    var targetThreads = typeof det.cpuThreads === "number" && det.cpuThreads > 0 ? det.cpuThreads : null;
    var cpuQuery = det.cpuName || "";

    var scoredCpus = cpus.map(function (cpu) {
      var nameScore = computeNameMatchScore(cpuQuery, cpu);
      var threadDiff = targetThreads !== null && typeof cpu.threads === "number"
        ? Math.abs(cpu.threads - targetThreads)
        : 999;
      var threadScore = targetThreads !== null && typeof cpu.threads === "number"
        ? Math.max(0, 200 - threadDiff * 15)
        : 0;
      return {
        item: cpu,
        nameScore: nameScore,
        threadDiff: threadDiff,
        totalScore: nameScore + threadScore
      };
    });

    scoredCpus.sort(function (a, b) {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (a.threadDiff !== b.threadDiff) return a.threadDiff - b.threadDiff;
      return (b.item.score || 0) - (a.item.score || 0);
    });

    var cpuOptions = scoredCpus.map(function (entry, idx) {
      var c = entry.item;
      var isRec =
        entry.nameScore >= 600 ||
        (cpuQuery === "" && targetThreads !== null && idx < 3 && entry.threadDiff <= 4);
      var label = c.name + (c.cores && c.threads ? " (" + c.cores + "C/" + c.threads + "T)" : "");
      return cloneWithMeta(c, isRec, entry.totalScore, label);
    });

    var gpuQuery = det.gpuName || "";
    var targetVram = typeof det.gpuVramGb === "number" && det.gpuVramGb > 0 ? det.gpuVramGb : null;

    var scoredGpus = gpus.map(function (gpu) {
      var nameScore = computeNameMatchScore(gpuQuery, gpu);
      var vramDiff = targetVram !== null && typeof gpu.vramGb === "number"
        ? Math.abs(gpu.vramGb - targetVram)
        : 999;
      var vramScore = targetVram !== null && typeof gpu.vramGb === "number"
        ? Math.max(0, 100 - vramDiff * 15)
        : 0;
      return {
        item: gpu,
        nameScore: nameScore,
        vramDiff: vramDiff,
        totalScore: nameScore + vramScore
      };
    });

    scoredGpus.sort(function (a, b) {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (a.vramDiff !== b.vramDiff) return a.vramDiff - b.vramDiff;
      return (b.item.score || 0) - (a.item.score || 0);
    });

    var gpuOptions = scoredGpus.map(function (entry, idx) {
      var g = entry.item;
      var isRec = entry.nameScore >= 600 || (idx === 0 && entry.nameScore > 0);
      var label = g.name + (g.vramGb ? " (" + g.vramGb + "GB)" : "");
      return cloneWithMeta(g, isRec, entry.totalScore, label);
    });

    return {
      cpuOptions: cpuOptions,
      gpuOptions: gpuOptions,
      ramOptions: RAM_OPTIONS.slice()
    };
  }

  global.SpecDetector = {
    detectBrowserSpecs: detectBrowserSpecs,
    parseDxDiagText: parseDxDiagText,
    getRecommendedOptions: getRecommendedOptions
  };
})(typeof window !== "undefined" ? window : globalThis);
