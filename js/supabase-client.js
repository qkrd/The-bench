(function (global) {
  "use strict";

  var CONFIG_STORAGE_KEY = "hw_supabase_config";
  var USER_STORAGE_PREFIX = "hw_user_";
  var SPEC_STORAGE_PREFIX = "hw_spec_";
  var memoryStorage = Object.create(null);

  function readStorage(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (e) {
      return Object.prototype.hasOwnProperty.call(memoryStorage, key) ? memoryStorage[key] : null;
    }
  }

  function writeStorage(key, value) {
    try {
      global.localStorage.setItem(key, value);
    } catch (e) {
      memoryStorage[key] = String(value);
    }
  }

  function normalizeUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function normalizeString(val) {
    return val === null || val === undefined ? "" : String(val).trim();
  }

  function toNullableNumber(val) {
    if (val === null || val === undefined || val === "") return null;
    var num = Number(val);
    return Number.isFinite(num) ? num : null;
  }

  function toNullableInt(val) {
    var num = toNullableNumber(val);
    return num === null ? null : Math.round(num);
  }

  function getConfig() {
    var raw = readStorage(CONFIG_STORAGE_KEY);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          var storedUrl = normalizeUrl(parsed.url);
          var storedKey = normalizeString(parsed.anonKey);
          if (storedUrl || storedKey) {
            return { url: storedUrl, anonKey: storedKey };
          }
        }
      } catch (e) {
        // 잘못된 JSON은 무시하고 window.SUPABASE_CONFIG로 폴백
      }
    }

    var fallback = global.SUPABASE_CONFIG || {};
    return {
      url: normalizeUrl(fallback.url),
      anonKey: normalizeString(fallback.anonKey)
    };
  }

  function saveConfig(url, anonKey) {
    var nextConfig = {
      url: normalizeUrl(url),
      anonKey: normalizeString(anonKey)
    };
    writeStorage(CONFIG_STORAGE_KEY, JSON.stringify(nextConfig));
    return nextConfig;
  }

  function isConfigured() {
    var cfg = getConfig();
    return Boolean(cfg.url && cfg.anonKey);
  }

  function getMode() {
    return isConfigured() ? "supabase" : "local";
  }

  function getModeLabel() {
    return isConfigured() ? "Supabase Cloud" : "로컬 폴백(Supabase 미연결)";
  }

  // SHA-256 해시 (Web Crypto 미지원 환경용 동기 폴백 포함)
  function sha256Fallback(ascii) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    var mathPow = Math.pow;
    var maxWord = mathPow(2, 32);
    var result = "";
    var words = [];
    var asciiBitLength = ascii.length * 8;
    var hash = [];
    var k = [];
    var primeCounter = 0;
    var isComposite = {};

    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (var i = 0; i < 313; i += candidate) {
          isComposite[i] = candidate;
        }
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }

    ascii += "\x80";
    while ((ascii.length % 64) - 56) ascii += "\x00";
    for (var idx = 0; idx < ascii.length; idx++) {
      var code = ascii.charCodeAt(idx);
      words[idx >> 2] |= code << (((3 - idx) % 4) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;

    for (var j = 0; j < words.length; ) {
      var w = words.slice(j, (j += 16));
      var oldHash = hash.slice(0);
      for (var round = 0; round < 64; round++) {
        var w15 = w[round - 15];
        var w2 = w[round - 2];
        var a = hash[0];
        var e = hash[4];
        var temp1 =
          hash[7] +
          (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
          ((e & hash[5]) ^ (~e & hash[6])) +
          k[round] +
          (w[round] =
            round < 16
              ? w[round]
              : (w[round - 16] +
                  (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                  w[round - 7] +
                  (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
                0);
        var temp2 =
          (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
          ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
        hash.pop();
      }
      for (var h = 0; h < 8; h++) {
        hash[h] = (hash[h] + oldHash[h]) | 0;
      }
    }

    for (var n = 0; n < 8; n++) {
      for (var byteIdx = 3; byteIdx + 1; byteIdx--) {
        var b = (hash[n] >> (byteIdx * 8)) & 255;
        result += (b < 16 ? "0" : "") + b.toString(16);
      }
    }
    return result;
  }

  async function hashPassword(password) {
    var input = String(password || "");
    if (global.crypto && global.crypto.subtle && global.TextEncoder) {
      var bytes = new global.TextEncoder().encode(input);
      var digest = await global.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest))
        .map(function (b) {
          return b.toString(16).padStart(2, "0");
        })
        .join("");
    }
    var utf8 = unescape(encodeURIComponent(input));
    return sha256Fallback(utf8);
  }

  async function restRequest(path, options) {
    var cfg = getConfig();
    var opts = options || {};
    var headers = {
      apikey: cfg.anonKey,
      Authorization: "Bearer " + cfg.anonKey,
      Accept: "application/json"
    };

    if (opts.prefer) {
      headers.Prefer = opts.prefer;
    }
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    var response = await global.fetch(cfg.url + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });

    var text = await response.text();
    var payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (e) {
        payload = { message: text };
      }
    }

    if (!response.ok) {
      var msg =
        (payload && (payload.message || payload.error_description || payload.hint)) ||
        "Supabase 요청 실패 (" + response.status + ")";
      var err = new Error(msg);
      err.status = response.status;
      err.code = payload && payload.code ? payload.code : "";
      throw err;
    }

    return payload;
  }

  function normalizeSpecInput(spec) {
    var s = spec || {};
    return {
      cpuName: normalizeString(s.cpuName),
      cpuThreads: toNullableInt(s.cpuThreads),
      gpuName: normalizeString(s.gpuName),
      gpuVramGb: toNullableNumber(s.gpuVramGb),
      ramGb: toNullableNumber(s.ramGb),
      osName: normalizeString(s.osName),
      sourceType: normalizeString(s.sourceType) || "manual",
      updatedAt: s.updatedAt ? String(s.updatedAt) : new Date().toISOString()
    };
  }

  function rowToSpec(row) {
    if (!row) return null;
    return {
      cpuName: normalizeString(row.cpu_name),
      cpuThreads: toNullableInt(row.cpu_threads),
      gpuName: normalizeString(row.gpu_name),
      gpuVramGb: toNullableNumber(row.gpu_vram_gb),
      ramGb: toNullableNumber(row.ram_gb),
      osName: normalizeString(row.os_name),
      sourceType: normalizeString(row.source_type) || "manual",
      updatedAt: row.updated_at ? String(row.updated_at) : new Date().toISOString()
    };
  }

  function formatRestError(err, fallbackMsg) {
    if (!err) return fallbackMsg;
    if (err.code === "23505" || err.status === 409) {
      return "이미 사용 중인 아이디입니다.";
    }
    if (err.status === 401 || err.status === 403) {
      return "Supabase 인증 키(Anon Key) 또는 RLS 정책을 확인해 주세요.";
    }
    return err.message || fallbackMsg;
  }

  async function signUp(params) {
    var input = params || {};
    var name = normalizeString(input.name);
    var id = normalizeString(input.id);
    var email = normalizeString(input.email);
    var password = input.password === undefined || input.password === null ? "" : String(input.password);
    var mode = getMode();

    if (!name || !id || !email || !password) {
      return { ok: false, user: null, mode: mode, error: "모든 회원 정보를 입력해 주세요." };
    }
    if (id === "admin") {
      return { ok: false, user: null, mode: mode, error: "admin은 공용 계정 아이디로 사용할 수 없습니다." };
    }

    var passwordHash = await hashPassword(password);

    if (mode === "supabase") {
      try {
        var rows = await restRequest("/rest/v1/app_users", {
          method: "POST",
          prefer: "return=representation",
          body: {
            user_id: id,
            name: name,
            email: email,
            password_hash: passwordHash
          }
        });
        var created = Array.isArray(rows) ? rows[0] : rows;
        return {
          ok: true,
          user: {
            id: created && created.user_id ? created.user_id : id,
            name: created && created.name ? created.name : name,
            email: created && created.email ? created.email : email
          },
          mode: "supabase",
          error: null
        };
      } catch (err) {
        return {
          ok: false,
          user: null,
          mode: "supabase",
          error: formatRestError(err, "회원가입 처리 중 오류가 발생했습니다.")
        };
      }
    }

    var existingRaw = readStorage(USER_STORAGE_PREFIX + id);
    if (existingRaw) {
      return { ok: false, user: null, mode: "local", error: "이미 사용 중인 아이디입니다." };
    }

    var localUser = {
      id: id,
      name: name,
      email: email,
      passwordHash: passwordHash
    };
    writeStorage(USER_STORAGE_PREFIX + id, JSON.stringify(localUser));

    return {
      ok: true,
      user: { id: id, name: name, email: email },
      mode: "local",
      error: null
    };
  }

  async function login(params) {
    var input = params || {};
    var id = normalizeString(input.id);
    var password = input.password === undefined || input.password === null ? "" : String(input.password);
    var mode = getMode();

    if (!id || !password) {
      return { ok: false, user: null, mode: mode, error: "아이디와 비밀번호를 입력해 주세요." };
    }

    // 공용 데모 계정은 Supabase 연결 여부와 무관하게 항상 허용
    if (id === "admin" && password === "admin") {
      return {
        ok: true,
        user: { id: "admin", name: "admin", email: "admin@localhost" },
        mode: mode,
        error: null
      };
    }

    var passwordHash = await hashPassword(password);

    if (mode === "supabase") {
      try {
        var rows = await restRequest(
          "/rest/v1/app_users?user_id=eq." +
            encodeURIComponent(id) +
            "&select=user_id,name,email,password_hash&limit=1"
        );
        var row = Array.isArray(rows) ? rows[0] : null;
        if (!row || row.password_hash !== passwordHash) {
          return {
            ok: false,
            user: null,
            mode: "supabase",
            error: "아이디 또는 비밀번호가 올바르지 않습니다."
          };
        }
        return {
          ok: true,
          user: { id: row.user_id, name: row.name, email: row.email },
          mode: "supabase",
          error: null
        };
      } catch (err) {
        return {
          ok: false,
          user: null,
          mode: "supabase",
          error: formatRestError(err, "로그인 처리 중 오류가 발생했습니다.")
        };
      }
    }

    var savedRaw = readStorage(USER_STORAGE_PREFIX + id);
    if (!savedRaw) {
      return {
        ok: false,
        user: null,
        mode: "local",
        error: "아이디 또는 비밀번호가 올바르지 않습니다. (admin / admin)"
      };
    }

    try {
      var saved = JSON.parse(savedRaw);
      var matchesHash = saved.passwordHash && saved.passwordHash === passwordHash;
      var matchesLegacy = saved.pw !== undefined && saved.pw === password;
      if (!matchesHash && !matchesLegacy) {
        return {
          ok: false,
          user: null,
          mode: "local",
          error: "아이디 또는 비밀번호가 올바르지 않습니다."
        };
      }
      return {
        ok: true,
        user: {
          id: saved.id || id,
          name: saved.name || id,
          email: saved.email || ""
        },
        mode: "local",
        error: null
      };
    } catch (e) {
      return {
        ok: false,
        user: null,
        mode: "local",
        error: "저장된 사용자 데이터를 읽을 수 없습니다."
      };
    }
  }

  async function saveUserSpec(userId, spec) {
    var cleanUserId = normalizeString(userId);
    var mode = getMode();
    if (!cleanUserId) {
      return { ok: false, spec: null, mode: mode, error: "사용자 ID가 필요합니다." };
    }

    var normalized = normalizeSpecInput(spec);

    if (mode === "supabase") {
      try {
        var rows = await restRequest("/rest/v1/user_specs?on_conflict=user_id", {
          method: "POST",
          prefer: "resolution=merge-duplicates,return=representation",
          body: {
            user_id: cleanUserId,
            cpu_name: normalized.cpuName,
            cpu_threads: normalized.cpuThreads,
            gpu_name: normalized.gpuName,
            gpu_vram_gb: normalized.gpuVramGb,
            ram_gb: normalized.ramGb,
            os_name: normalized.osName,
            source_type: normalized.sourceType,
            updated_at: normalized.updatedAt
          }
        });
        var savedRow = Array.isArray(rows) ? rows[0] : rows;
        return {
          ok: true,
          spec: rowToSpec(savedRow) || normalized,
          mode: "supabase",
          error: null
        };
      } catch (err) {
        return {
          ok: false,
          spec: null,
          mode: "supabase",
          error: formatRestError(err, "사양 저장 중 오류가 발생했습니다.")
        };
      }
    }

    writeStorage(SPEC_STORAGE_PREFIX + cleanUserId, JSON.stringify(normalized));
    return {
      ok: true,
      spec: normalized,
      mode: "local",
      error: null
    };
  }

  async function loadUserSpec(userId) {
    var cleanUserId = normalizeString(userId);
    var mode = getMode();
    if (!cleanUserId) {
      return { ok: false, spec: null, mode: mode, error: "사용자 ID가 필요합니다." };
    }

    if (mode === "supabase") {
      try {
        var rows = await restRequest(
          "/rest/v1/user_specs?user_id=eq." +
            encodeURIComponent(cleanUserId) +
            "&select=user_id,cpu_name,cpu_threads,gpu_name,gpu_vram_gb,ram_gb,os_name,source_type,updated_at&limit=1"
        );
        var row = Array.isArray(rows) ? rows[0] : null;
        return {
          ok: true,
          spec: rowToSpec(row),
          mode: "supabase",
          error: null
        };
      } catch (err) {
        return {
          ok: false,
          spec: null,
          mode: "supabase",
          error: formatRestError(err, "사양 조회 중 오류가 발생했습니다.")
        };
      }
    }

    var savedRaw = readStorage(SPEC_STORAGE_PREFIX + cleanUserId);
    if (!savedRaw) {
      return { ok: true, spec: null, mode: "local", error: null };
    }

    try {
      var parsed = JSON.parse(savedRaw);
      return {
        ok: true,
        spec: normalizeSpecInput(parsed),
        mode: "local",
        error: null
      };
    } catch (e) {
      return {
        ok: false,
        spec: null,
        mode: "local",
        error: "저장된 사양 데이터를 읽을 수 없습니다."
      };
    }
  }

  global.AppDB = {
    getConfig: getConfig,
    saveConfig: saveConfig,
    isConfigured: isConfigured,
    getModeLabel: getModeLabel,
    signUp: signUp,
    login: login,
    saveUserSpec: saveUserSpec,
    loadUserSpec: loadUserSpec
  };
})(window);
