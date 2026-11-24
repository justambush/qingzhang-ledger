(function (global) {
  'use strict';

  function getSubtleCrypto() {
    if (global.crypto && global.crypto.subtle) return global.crypto.subtle;
    if (typeof require === 'function') {
      try {
        return require('crypto').webcrypto.subtle;
      } catch (_) {}
    }
    throw new Error('WebCrypto API unavailable (requires HTTPS or localhost)');
  }

  function getRandomBytes(len) {
    const buf = new Uint8Array(len);
    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      global.crypto.getRandomValues(buf);
      return buf;
    }
    if (typeof require === 'function') {
      return new Uint8Array(require('crypto').randomBytes(len));
    }
    throw new Error('Secure random source unavailable');
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes).toString('base64');
    }
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function base64UrlToBytes(b64u) {
    const clean = String(b64u).trim().replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (clean.length % 4)) % 4);
    return base64ToBytes(clean + pad);
  }

  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function importAesKey(syncKeyB64Url) {
    const raw = base64UrlToBytes(syncKeyB64Url);
    if (raw.length !== 32) {
      throw new Error('同步密钥格式无效（需 32 字节 AES-256 密钥）');
    }
    return getSubtleCrypto().importKey('raw', raw, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  }

  async function encryptSnapshot(snapshot, syncKeyB64Url, device = 'ios-pwa') {
    const key = await importAesKey(syncKeyB64Url);
    const iv = getRandomBytes(12);
    const pt = new TextEncoder().encode(JSON.stringify(snapshot));
    const ctBuf = await getSubtleCrypto().encrypt(
      { name: 'AES-GCM', iv },
      key,
      pt
    );
    return {
      v: 1,
      alg: 'AES-256-GCM',
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(ctBuf)),
      pushed_at: Date.now(),
      device,
    };
  }

  async function decryptSnapshot(envelope, syncKeyB64Url) {
    if (!envelope || envelope.v !== 1 || envelope.alg !== 'AES-256-GCM') {
      throw new Error('云端加密包格式不支持');
    }
    const key = await importAesKey(syncKeyB64Url);
    const iv = base64ToBytes(envelope.iv);
    const ct = base64ToBytes(envelope.ct);
    const ptBuf = await getSubtleCrypto().decrypt(
      { name: 'AES-GCM', iv },
      key,
      ct
    );
    return JSON.parse(new TextDecoder().decode(ptBuf));
  }

  function validateParsedPairPayload(obj) {
    if (!obj || obj.v !== 1 || !obj.k) {
      throw new Error('配对码内容损坏或不完整');
    }
    if (obj.m === 'gist') {
      if (!obj.g || !obj.t) throw new Error('Gist 配对码缺少 Gist ID 或 Token');
      return {
        mode: 'gist',
        sync_key: obj.k,
        gist_id: obj.g,
        token: obj.t,
      };
    }
    if (obj.m === 'webhook') {
      if (!obj.u) throw new Error('Relay 配对码缺少 URL');
      return {
        mode: 'webhook',
        sync_key: obj.k,
        relay_url: obj.u,
        relay_secret: obj.s || '',
      };
    }
    throw new Error('不支持的同步模式: ' + obj.m);
  }

  function safeDecodeURIComponent(str) {
    try {
      return decodeURIComponent(str);
    } catch (_) {
      return str;
    }
  }

  function parsePairingCode(rawStr) {
    let text = String(rawStr || '').trim().replace(/^['"`\s]+|['"`\s]+$/g, '');
    if (!text) throw new Error('配对码不能为空');
    if (text.includes('%')) {
      text = safeDecodeURIComponent(text);
    }
    const compact = text.replace(/\s+/g, '');
    const pairParam = compact.match(/[#?&]pair=([^&#]+)/i);
    const candidate = pairParam
      ? safeDecodeURIComponent(pairParam[1])
      : compact;

    if (/^(ghp_|github_pat_|gho_)/i.test(candidate)) {
      throw new Error('这是 GitHub Token，请填入 16 位短配对码（形如 xxxx-xxxx-xxxx-xxxx）');
    }
    const qzMatch = candidate.match(/qz[1liI][:\uff1a]([A-Za-z0-9+/=_-]{20,})/i);
    if (!qzMatch) {
      if (/^https?:\/\//i.test(candidate)) {
        throw new Error('这是网页地址（不含配对信息），请填入 16 位短配对码');
      }
      throw new Error('无法识别配对码，请输入 16 位短配对码或 QZ1: 开头配对码');
    }

    const b64u = qzMatch[1].trim();
    let obj;
    try {
      const jsonBytes = base64UrlToBytes(b64u);
      obj = JSON.parse(new TextDecoder().decode(jsonBytes));
    } catch (_) {
      throw new Error('QZ1 配对码不完整或识别有误，建议改输 16 位短配对码');
    }
    return validateParsedPairPayload(obj);
  }

  function normalizeShortPairKey(rawStr) {
    let text = String(rawStr || '').trim().replace(/^['"`\s]+|['"`\s]+$/g, '');
    const kParam = text.match(/[#?&]k=([^&#\s]+)/i);
    if (kParam) {
      text = safeDecodeURIComponent(kParam[1]);
    }
    return text.replace(/[\s\-_\u2013\u2014]+/g, '').toLowerCase();
  }

  function isLikelyShortPairKey(rawStr) {
    const raw = String(rawStr || '').trim();
    if (!raw) return false;
    if (/[#?&]k=[^&#\s]+/i.test(raw)) return true;
    const compact = raw.replace(/\s+/g, '');
    if (/qz[1liI][:\uff1a]/i.test(compact)) return false;
    if (/[#?&]pair=/i.test(compact)) return false;
    if (/^(ghp_|github_pat_|gho_)/i.test(compact)) return false;
    if (/^https?:\/\//i.test(compact)) return false;
    const norm = normalizeShortPairKey(raw);
    return /^[a-z0-9]{12,24}$/.test(norm);
  }

  async function decryptPairVaultEnvelope(vaultObj, shortKeyRaw) {
    if (
      !vaultObj ||
      vaultObj.v !== 1 ||
      vaultObj.alg !== 'PBKDF2-SHA256-AES256GCM' ||
      !vaultObj.salt ||
      !vaultObj.iv ||
      !vaultObj.ct
    ) {
      throw new Error('云端配对配置格式不受支持');
    }
    const normKey = normalizeShortPairKey(shortKeyRaw);
    if (normKey.length < 12) {
      throw new Error('短配对码长度不足，请核对 16 位字符');
    }
    const subtle = getSubtleCrypto();
    const baseKey = await subtle.importKey(
      'raw',
      new TextEncoder().encode(normKey),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    const derivedKey = await subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: base64ToBytes(vaultObj.salt),
        iterations: Number(vaultObj.iter) || 600000,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    let ptBuf;
    try {
      ptBuf = await subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(vaultObj.iv) },
        derivedKey,
        base64ToBytes(vaultObj.ct)
      );
    } catch (_) {
      throw new Error('短配对码不正确，请核对 16 位字符');
    }
    const obj = JSON.parse(new TextDecoder().decode(ptBuf));
    return validateParsedPairPayload(obj);
  }

  async function unlockPairVaultWithShortKey(
    shortKeyRaw,
    vaultUrl = './pair_vault.json'
  ) {
    const sep = vaultUrl.includes('?') ? '&' : '?';
    let res;
    try {
      res = await fetch(`${vaultUrl}${sep}t=${Date.now()}`, {
        cache: 'no-store',
      });
    } catch (_) {
      throw new Error('无法下载云端配对配置，请检查网络或先点「刷新版本」');
    }
    if (!res.ok) {
      throw new Error(
        `未找到云端配对配置 (HTTP ${res.status})，请先点「刷新版本」或稍后重试`
      );
    }
    const vaultObj = await res.json();
    return decryptPairVaultEnvelope(vaultObj, shortKeyRaw);
  }

  function encodePairingCode(cfg) {
    const payload = { v: 1, m: cfg.mode, k: cfg.sync_key };
    if (cfg.mode === 'gist') {
      payload.g = cfg.gist_id;
      payload.t = cfg.token;
    } else if (cfg.mode === 'webhook') {
      payload.u = cfg.relay_url;
      if (cfg.relay_secret) payload.s = cfg.relay_secret;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return 'QZ1:' + bytesToBase64Url(bytes);
  }

  function isSidecarEnvironment() {
    if (typeof window === 'undefined') return false;
    if (window.sidecar && typeof window.sidecar.fetch === 'function') {
      const p = new URLSearchParams(window.location.search);
      return Boolean(p.get('token'));
    }
    return false;
  }

  async function syncViaSidecar(store) {
    const seqBeforePush = store.writeSeq || 0;
    const bodyStr = JSON.stringify({ snapshot: store.snapshot });
    const res = await window.sidecar.fetch('/api/ledger/sync', {
      method: 'POST',
      body: bodyStr,
    });
    if (!res.ok) throw new Error('Sidecar 同步失败: HTTP ' + res.status);
    const data = await res.json();
    if (data && data.snapshot) {
      await store.replaceFromMerge(data.snapshot);
    }
    if ((store.writeSeq || 0) === seqBeforePush) {
      await store.setMeta('dirty', false);
    }
    const ts = new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    await store.setMeta('last_sync_at', ts);
    return { ok: true, mode: 'sidecar', ts };
  }

  async function syncViaCloud(store, cfg) {
    if (!cfg || !cfg.sync_key) {
      return { ok: false, reason: 'not_configured' };
    }
    let remoteSnap = { transactions: [], budgets: {}, custom_tags: [] };
    let remoteHadData = false;

    if (cfg.mode === 'gist') {
      const res = await fetch(
        'https://api.github.com/gists/' + encodeURIComponent(cfg.gist_id),
        {
          headers: {
            Authorization: 'Bearer ' + cfg.token,
            Accept: 'application/vnd.github+json',
          },
          cache: 'no-store',
        }
      );
      if (!res.ok) throw new Error('拉取云端 Gist 失败 (HTTP ' + res.status + ')');
      const gist = await res.json();
      const vf = gist.files && gist.files['qingzhang_vault.enc.json'];
      if (vf) {
        let env = null;
        if (vf.truncated && vf.raw_url) {
          const r2 = await fetch(vf.raw_url, { cache: 'no-store' });
          if (!r2.ok) throw new Error('拉取完整加密包失败');
          env = await r2.json();
        } else if (vf.content && vf.content.trim()) {
          env = JSON.parse(vf.content);
        }
        if (env && env.alg === 'AES-256-GCM') {
          remoteSnap = await decryptSnapshot(env, cfg.sync_key);
          remoteHadData = true;
        }
      }
    } else if (cfg.mode === 'webhook') {
      const sep = cfg.relay_url.includes('?') ? '&' : '?';
      let url = cfg.relay_url + sep + 'action=pull';
      if (cfg.relay_secret) {
        url += '&secret=' + encodeURIComponent(cfg.relay_secret);
      }
      const res = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error('拉取 Relay 失败 (HTTP ' + res.status + ')');
      const env = await res.json();
      if (env && env.alg === 'AES-256-GCM') {
        remoteSnap = await decryptSnapshot(env, cfg.sync_key);
        remoteHadData = true;
      }
    } else {
      return { ok: false, reason: 'not_configured' };
    }

    const seqBeforeMerge = store.writeSeq || 0;
    const { snapshot, remoteNeedsPush } = await store.replaceFromMerge(remoteSnap);
    const shouldPush = remoteNeedsPush || !remoteHadData || Boolean(store.meta.dirty);

    if (shouldPush) {
      const envelope = await encryptSnapshot(snapshot, cfg.sync_key, 'ios-pwa');
      if (cfg.mode === 'gist') {
        const bodyStr = JSON.stringify({
          files: {
            'qingzhang_vault.enc.json': {
              content: JSON.stringify(envelope),
            },
          },
        });
        const res = await fetch(
          'https://api.github.com/gists/' + encodeURIComponent(cfg.gist_id),
          {
            method: 'PATCH',
            headers: {
              Authorization: 'Bearer ' + cfg.token,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: bodyStr,
            keepalive: bodyStr.length < 60000,
          }
        );
        if (!res.ok) throw new Error('上传加密账本失败 (HTTP ' + res.status + ')');
      } else if (cfg.mode === 'webhook') {
        const body = { ...envelope };
        if (cfg.relay_secret) body.secret = cfg.relay_secret;
        const bodyStr = JSON.stringify(body);
        const res = await fetch(cfg.relay_url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: bodyStr,
          keepalive: bodyStr.length < 60000,
        });
        if (!res.ok) throw new Error('上传 Relay 失败 (HTTP ' + res.status + ')');
      }
    }

    if ((store.writeSeq || 0) === seqBeforeMerge) {
      await store.setMeta('dirty', false);
    }
    const ts = new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    await store.setMeta('last_sync_at', ts);
    return { ok: true, mode: cfg.mode, pushed: shouldPush, ts };
  }

  const api = {
    encryptSnapshot,
    decryptSnapshot,
    parsePairingCode,
    encodePairingCode,
    normalizeShortPairKey,
    isLikelyShortPairKey,
    decryptPairVaultEnvelope,
    unlockPairVaultWithShortKey,
    isSidecarEnvironment,
    syncViaSidecar,
    syncViaCloud,
    base64UrlToBytes,
    bytesToBase64Url,
  };

  global.QZCrypto = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
