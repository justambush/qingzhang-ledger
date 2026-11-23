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

  function parsePairingCode(rawStr) {
    let text = String(rawStr || '').trim();
    if (!text) throw new Error('配对码不能为空');
    const pairMarker = '#pair=';
    if (text.includes(pairMarker)) {
      text = text.split(pairMarker)[1].trim();
    }
    if (!text.startsWith('QZ1:')) {
      throw new Error('无法识别的配对码（应以 QZ1: 开头）');
    }
    const b64u = text.slice(4).trim();
    const jsonBytes = base64UrlToBytes(b64u);
    const obj = JSON.parse(new TextDecoder().decode(jsonBytes));
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
    const res = await window.sidecar.fetch('/api/ledger/sync', {
      method: 'POST',
      body: JSON.stringify({ snapshot: store.snapshot }),
    });
    if (!res.ok) throw new Error('Sidecar 同步失败: HTTP ' + res.status);
    const data = await res.json();
    if (data && data.snapshot) {
      await store.replaceFromMerge(data.snapshot);
    }
    await store.setMeta('dirty', false);
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

    const { snapshot, remoteNeedsPush } = await store.replaceFromMerge(remoteSnap);
    const shouldPush = remoteNeedsPush || !remoteHadData || Boolean(store.meta.dirty);

    if (shouldPush) {
      const envelope = await encryptSnapshot(snapshot, cfg.sync_key, 'ios-pwa');
      if (cfg.mode === 'gist') {
        const res = await fetch(
          'https://api.github.com/gists/' + encodeURIComponent(cfg.gist_id),
          {
            method: 'PATCH',
            headers: {
              Authorization: 'Bearer ' + cfg.token,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              files: {
                'qingzhang_vault.enc.json': {
                  content: JSON.stringify(envelope),
                },
              },
            }),
          }
        );
        if (!res.ok) throw new Error('上传加密账本失败 (HTTP ' + res.status + ')');
      } else if (cfg.mode === 'webhook') {
        const body = { ...envelope };
        if (cfg.relay_secret) body.secret = cfg.relay_secret;
        const res = await fetch(cfg.relay_url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('上传 Relay 失败 (HTTP ' + res.status + ')');
      }
    }

    await store.setMeta('dirty', false);
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
