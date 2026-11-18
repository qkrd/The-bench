(function (global) {
  "use strict";

  var QUALIFIER_TOKENS = {
    ti: true,
    super: true,
    xt: true,
    xtx: true,
    x3d: true,
    laptop: true,
    mobile: true,
    hx: true,
    k: true,
    kf: true,
    ks: true,
    f: true
  };

  function basicNormalize(value) {
    return String(value || "")
      .replace(/\(R\)|\(TM\)|®|™/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function cleanHardwareQuery(value) {
    return basicNormalize(value)
      .replace(/^(?:1[0-4]th|9th|8th)\s+gen\s+/i, "")
      .replace(/\(\s*~?\s*\d+\s*(?:cpus?|개\s*cpu|논리\s*프로세서)\s*\)/gi, "")
      .replace(/@\s*[\d.]+\s*ghz\b/gi, "")
      .replace(/\b(?:processor|graphics|cpu)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenize(value) {
    var spaced = basicNormalize(value).replace(/\b(rtx|gtx|rx|arc)(\d)/gi, "$1 $2");
    return spaced
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  function extractModelTokens(tokens) {
    return tokens.filter(function (tok) {
      return /\d{3,5}/.test(tok);
    });
  }

  function hasAnyOverlap(listA, listB) {
    for (var i = 0; i < listA.length; i++) {
      if (listB.indexOf(listA[i]) !== -1) return true;
    }
    return false;
  }

  function scoreCandidate(queryRaw, item) {
    if (!queryRaw || !item) return 0;

    var qBasic = basicNormalize(queryRaw);
    var qClean = cleanHardwareQuery(queryRaw);
    if (!qBasic && !qClean) return 0;

    var candidates = [item.name].concat(Array.isArray(item.aliases) ? item.aliases : []).filter(Boolean);
    var qTokens = tokenize(qClean || qBasic);
    var qModels = extractModelTokens(qTokens);
    var bestScore = 0;

    for (var i = 0; i < candidates.length; i++) {
      var cBasic = basicNormalize(candidates[i]);
      var cClean = cleanHardwareQuery(candidates[i]);
      if (!cBasic) continue;

      if (qBasic === cBasic || qClean === cBasic || (cClean && qClean === cClean)) {
        return 10000;
      }

      var cTokens = tokenize(cClean || cBasic);
      var cModels = extractModelTokens(cTokens);

      // Prevent matching unrelated generation/model numbers (e.g., i7-10700K vs i7-14700K)
      if (qModels.length > 0 && cModels.length > 0 && !hasAnyOverlap(qModels, cModels)) {
        continue;
      }

      var overlap = 0;
      for (var t = 0; t < cTokens.length; t++) {
        if (qTokens.indexOf(cTokens[t]) !== -1) {
          overlap++;
        }
      }

      if (overlap === 0) continue;

      var cCoverage = overlap / cTokens.length;
      var qCoverage = qTokens.length > 0 ? overlap / qTokens.length : 0;

      // Without a matching model code, require strong multi-token coverage
      if (qModels.length === 0 && (overlap < 2 || cCoverage < 0.5)) {
        continue;
      }

      var score = cCoverage * 600 + qCoverage * 200;

      if (qModels.length > 0 && hasAnyOverlap(qModels, cModels)) {
        score += 500;
      }

      if (qClean.indexOf(cBasic) !== -1 || cBasic.indexOf(qClean) !== -1) {
        score += 150;
      }

      // Penalize mismatched variant qualifiers (Ti, SUPER, XT, X3D, Laptop, etc.)
      var extraPenalties = 0;
      for (var j = 0; j < cTokens.length; j++) {
        if (qTokens.indexOf(cTokens[j]) === -1) {
          extraPenalties += QUALIFIER_TOKENS[cTokens[j]] ? 120 : 25;
        }
      }
      for (var k = 0; k < qTokens.length; k++) {
        if (cTokens.indexOf(qTokens[k]) === -1 && QUALIFIER_TOKENS[qTokens[k]]) {
          extraPenalties += 90;
        }
      }

      score = Math.max(0, Math.round(score - extraPenalties));
      if (score > bestScore) {
        bestScore = score;
      }
    }

    return bestScore;
  }

  function pickMidpointItem(items, fallbackItem) {
    if (!Array.isArray(items) || items.length === 0) {
      return fallbackItem;
    }
    var sorted = items.slice().sort(function (a, b) {
      return (a.score || 0) - (b.score || 0);
    });
    var midIdx = Math.floor((sorted.length - 1) / 2);
    return sorted[midIdx];
  }

  function matchHardware(queryName, items, kindLabel, fallbackItem) {
    var list = Array.isArray(items) ? items : [];
    var trimmed = String(queryName || "").trim();

    if (list.length === 0) {
      return {
        item: fallbackItem,
        matched: false,
        note: kindLabel + " 벤치마크 데이터가 비어 있어 기본 기준으로 비교합니다."
      };
    }

    if (!trimmed) {
      var defaultMid = pickMidpointItem(list, fallbackItem);
      return {
        item: defaultMid,
        matched: false,
        note: kindLabel + " 모델명이 없어 중간 기준 모델(" + defaultMid.name + ")로 비교합니다."
      };
    }

    var bestItem = null;
    var bestScore = 0;

    for (var i = 0; i < list.length; i++) {
      var score = scoreCandidate(trimmed, list[i]);
      if (score > bestScore) {
        bestScore = score;
        bestItem = list[i];
      }
    }

    if (bestItem && bestScore >= 400) {
      var matchType = bestScore >= 10000 ? "정확히 일치" : "모델명 매칭";
      return {
        item: bestItem,
        matched: true,
        note: matchType + ": " + bestItem.name
      };
    }

    var mid = pickMidpointItem(list, fallbackItem);
    return {
      item: mid,
      matched: false,
      note: "'" + trimmed + "' 모델을 찾지 못해 중간 기준 모델(" + mid.name + ")로 대체 비교합니다."
    };
  }

  function matchCpu(cpuName, benchmarksData) {
    var cpus = benchmarksData && Array.isArray(benchmarksData.cpus) ? benchmarksData.cpus : [];
    var fallbackCpu = {
      id: "fallback-cpu",
      name: "기준 CPU",
      aliases: [],
      brand: "Unknown",
      cores: 8,
      threads: 16,
      cacheMb: 32,
      boostGhz: 4.5,
      score: 23000,
      singleScore: 3500,
      tier: "mainstream"
    };
    return matchHardware(cpuName, cpus, "CPU", fallbackCpu);
  }

  function matchGpu(gpuName, benchmarksData) {
    var gpus = benchmarksData && Array.isArray(benchmarksData.gpus) ? benchmarksData.gpus : [];
    var fallbackGpu = {
      id: "fallback-gpu",
      name: "기준 GPU",
      aliases: [],
      brand: "Unknown",
      vramGb: 8,
      boostGhz: 2.4,
      score: 17000,
      tier: "mainstream"
    };
    return matchHardware(gpuName, gpus, "GPU", fallbackGpu);
  }

  function parsePositiveNumber(value, defaultVal) {
    var num = typeof value === "number" ? value : parseFloat(value);
    return isFinite(num) && num > 0 ? num : defaultVal;
  }

  function clampPct(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function findTierById(tiers, id, fallback) {
    for (var i = 0; i < tiers.length; i++) {
      if (tiers[i] && tiers[i].id === id) return tiers[i];
    }
    return fallback;
  }

  function resolveTier(cpuScore, gpuScore, ramGb, tiers) {
    if (!Array.isArray(tiers) || tiers.length === 0) {
      return {
        id: "mainstream",
        label: "FHD/QHD 주류 게이밍",
        minCpuScore: 23000,
        minGpuScore: 17000,
        minRamGb: 16,
        targetRes: "1440p 144Hz"
      };
    }

    var sorted = tiers.slice().sort(function (a, b) {
      return (a.minCpuScore + a.minGpuScore) - (b.minCpuScore + b.minGpuScore);
    });

    for (var i = sorted.length - 1; i >= 0; i--) {
      var t = sorted[i];
      if (
        cpuScore >= (t.minCpuScore || 0) &&
        gpuScore >= (t.minGpuScore || 0) &&
        ramGb >= (t.minRamGb || 0)
      ) {
        return t;
      }
    }

    return sorted[0];
  }

  function diagnoseBottleneck(cpuScore, gpuScore, ramGb, mainstreamTier, cpuItem, gpuItem) {
    if (ramGb < 16) {
      return {
        status: "RAM 보강 권장",
        message:
          "현재 메모리(" +
          ramGb +
          "GB)가 2026년 게이밍 권장 기준(16GB 이상)보다 부족하여 스터터링이 발생할 수 있습니다. 16GB~32GB 증설을 권장합니다."
      };
    }

    var cpuNorm = cpuScore / (mainstreamTier.minCpuScore || 23000);
    var gpuNorm = gpuScore / (mainstreamTier.minGpuScore || 17000);

    if (gpuNorm < cpuNorm * 0.75) {
      return {
        status: "GPU 병목",
        message:
          cpuItem.name +
          " 대비 " +
          gpuItem.name +
          " 그래픽 성능 비중이 낮아 고해상도·고옵션에서 GPU가 먼저 한계에 도달합니다."
      };
    }

    if (cpuNorm < gpuNorm * 0.75) {
      return {
        status: "CPU 병목",
        message:
          gpuItem.name +
          " 대비 " +
          cpuItem.name +
          " 연산 비중이 낮아 고주사율·대규모 멀티플레이 환경에서 CPU 병목이 발생할 수 있습니다."
      };
    }

    var ramNote =
      cpuScore >= 34000 && gpuScore >= 28000 && ramGb < 32
        ? " (하이엔드 환경에서는 32GB RAM 확장 시 더욱 여유롭습니다.)"
        : "";

    return {
      status: "균형",
      message:
        cpuItem.name +
        "와(과) " +
        gpuItem.name +
        "의 게이밍 성능 균형이 안정적이며, RAM " +
        ramGb +
        "GB 구성과 잘 어울립니다." +
        ramNote
    };
  }

  function evaluateGames(games, cpuScore, gpuScore, ramGb) {
    if (!Array.isArray(games)) return [];

    return games.map(function (game) {
      var reqCpu = game.reqCpuScore || 1;
      var reqGpu = game.reqGpuScore || 1;
      var reqRam = game.reqRamGb || 8;

      var cpuRatio = cpuScore / reqCpu;
      var gpuRatio = gpuScore / reqGpu;
      var minRatio = Math.min(cpuRatio, gpuRatio);
      var ramOk = ramGb >= reqRam;

      var verdict;
      var summary;

      if (minRatio >= 1.15 && ramOk) {
        verdict = "원활";
        summary = "권장 사양 상회 · 높음~울트라 옵션 쾌적";
      } else if ((minRatio >= 0.85 && ramOk) || (minRatio >= 0.95 && ramGb >= 16)) {
        verdict = "보통";
        summary = ramOk
          ? "권장 사양 근접 · 중간 옵션 또는 업스케일링 권장"
          : "CPU/GPU는 근접하나 RAM " + reqRam + "GB 권장";
      } else {
        verdict = "부족";
        summary = !ramOk && minRatio >= 0.85
          ? "RAM " + reqRam + "GB 이상 권장 · 메모리 증설 필요"
          : "권장 사양 미달 · 낮음 옵션 타협 또는 업그레이드 필요";
      }

      return {
        id: game.id,
        title: game.title,
        genre: game.genre,
        verdict: verdict,
        detail:
          "CPU " +
          cpuRatio.toFixed(2) +
          "x · GPU " +
          gpuRatio.toFixed(2) +
          "x · RAM " +
          ramGb +
          "GB/" +
          reqRam +
          "GB — " +
          summary
      };
    });
  }

  function getMaxScore(items, fallback) {
    if (!Array.isArray(items) || items.length === 0) return fallback;
    var max = 0;
    for (var i = 0; i < items.length; i++) {
      if ((items[i].score || 0) > max) {
        max = items[i].score;
      }
    }
    return max > 0 ? max : fallback;
  }

  function buildComparisonRows(spec, cpuMatch, gpuMatch, totalScore, effectiveVram, data) {
    var cpus = Array.isArray(data.cpus) ? data.cpus.slice() : [];
    var gpus = Array.isArray(data.gpus) ? data.gpus.slice() : [];
    var tiers = Array.isArray(data.tiers) ? data.tiers : [];

    cpus.sort(function (a, b) {
      return (b.score || 0) - (a.score || 0);
    });
    gpus.sort(function (a, b) {
      return (b.score || 0) - (a.score || 0);
    });

    function tierBadge(tierId) {
      var found = findTierById(tiers, tierId, null);
      if (!found) return tierId || "기준";
      if (found.id === "enthusiast") return "플래그십";
      if (found.id === "high") return "하이엔드";
      if (found.id === "mainstream") return "주류";
      return "입문";
    }

    var cpuItem = cpuMatch.item;
    var gpuItem = gpuMatch.item;
    var displayCpu = cpuMatch.matched
      ? cpuItem.name
      : (spec.cpuName ? String(spec.cpuName).trim() : cpuItem.name + " (추정)");
    var displayGpu = gpuMatch.matched
      ? gpuItem.name
      : (spec.gpuName ? String(spec.gpuName).trim() : gpuItem.name + " (추정)");

    var userThreads = parsePositiveNumber(spec.cpuThreads, cpuItem.threads || 16);
    var userRow = {
      label: displayCpu + " + " + displayGpu,
      badge: "내 PC",
      isUser: true,
      cores: cpuItem.cores || "-",
      threads: userThreads,
      cacheOrVram: "L3 " + (cpuItem.cacheMb || 0) + "MB / VRAM " + effectiveVram + "GB",
      boostGhz: cpuItem.boostGhz || "-",
      score: totalScore
    };

    var rows = [userRow];
    var topCpus = cpus.slice(0, 3);
    var topGpus = gpus.slice(0, 2);

    for (var i = 0; i < topCpus.length; i++) {
      var c = topCpus[i];
      rows.push({
        label: c.name,
        badge: "CPU · " + tierBadge(c.tier),
        isUser: false,
        cores: c.cores,
        threads: c.threads,
        cacheOrVram: c.cacheMb + "MB L3",
        boostGhz: c.boostGhz,
        score: c.score
      });
    }

    for (var j = 0; j < topGpus.length; j++) {
      var g = topGpus[j];
      rows.push({
        label: g.name,
        badge: "GPU · " + tierBadge(g.tier),
        isUser: false,
        cores: "-",
        threads: "-",
        cacheOrVram: g.vramGb + "GB VRAM",
        boostGhz: g.boostGhz,
        score: g.score
      });
    }

    return rows.slice(0, 6);
  }

  function analyzeSpec(userSpec, benchmarksData) {
    var spec = userSpec || {};
    var data = benchmarksData || {};
    var tiers = Array.isArray(data.tiers) ? data.tiers : [];

    var cpuMatch = matchCpu(spec.cpuName, data);
    var gpuMatch = matchGpu(spec.gpuName, data);

    var cpuScore = cpuMatch.item.score || 0;
    var gpuScore = gpuMatch.item.score || 0;
    var totalScore = Math.round(cpuScore * 0.4 + gpuScore * 0.6);

    var ramGb = parsePositiveNumber(spec.ramGb, 16);
    var effectiveVram = parsePositiveNumber(spec.gpuVramGb, gpuMatch.item.vramGb || 8);

    var mainstreamTier = findTierById(tiers, "mainstream", {
      id: "mainstream",
      label: "FHD/QHD 주류 게이밍",
      minCpuScore: 23000,
      minGpuScore: 17000,
      minRamGb: 16,
      targetRes: "1440p 144Hz"
    });

    var enthusiastTier = findTierById(tiers, "enthusiast", {
      id: "enthusiast",
      label: "4K 플래그십",
      minCpuScore: 44000,
      minGpuScore: 39000,
      minRamGb: 32,
      targetRes: "4K Ultra"
    });

    var maxCpuScore = getMaxScore(data.cpus, enthusiastTier.minCpuScore || 44000);
    var maxGpuScore = getMaxScore(data.gpus, enthusiastTier.minGpuScore || 39000);

    var tier = resolveTier(cpuScore, gpuScore, ramGb, tiers);

    var vsMainstream = {
      cpuRatioText: (cpuScore / (mainstreamTier.minCpuScore || 23000)).toFixed(2) + "x",
      gpuRatioText: (gpuScore / (mainstreamTier.minGpuScore || 17000)).toFixed(2) + "x",
      cpuPct: clampPct((cpuScore / maxCpuScore) * 100),
      gpuPct: clampPct((gpuScore / maxGpuScore) * 100),
      ramPct: clampPct((ramGb / (enthusiastTier.minRamGb || 32)) * 100)
    };

    var bottleneck = diagnoseBottleneck(
      cpuScore,
      gpuScore,
      ramGb,
      mainstreamTier,
      cpuMatch.item,
      gpuMatch.item
    );

    var gameResults = evaluateGames(data.games, cpuScore, gpuScore, ramGb);
    var comparisonRows = buildComparisonRows(
      spec,
      cpuMatch,
      gpuMatch,
      totalScore,
      effectiveVram,
      data
    );

    return {
      cpuMatch: cpuMatch,
      gpuMatch: gpuMatch,
      totalScore: totalScore,
      tier: tier,
      vsMainstream: vsMainstream,
      bottleneck: bottleneck,
      gameResults: gameResults,
      comparisonRows: comparisonRows
    };
  }

  global.BenchmarkEngine = {
    matchCpu: matchCpu,
    matchGpu: matchGpu,
    analyzeSpec: analyzeSpec
  };
})(typeof window !== "undefined" ? window : globalThis);
