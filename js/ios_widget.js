(function (global) {
  'use strict';

  const B64_ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_REV = (() => {
    const m = new Int16Array(128).fill(-1);
    for (let i = 0; i < B64_ALPHABET.length; i++) {
      m[B64_ALPHABET.charCodeAt(i)] = i;
    }
    return m;
  })();

  function b64ToBytes(b64) {
    const clean = String(b64 || '')
      .trim()
      .replace(/[\r\n\s]/g, '');
    const out = [];
    for (let i = 0; i < clean.length; i += 4) {
      const c0 = clean.charCodeAt(i);
      const c1 = clean.charCodeAt(i + 1);
      const c2 = clean.charCodeAt(i + 2);
      const c3 = clean.charCodeAt(i + 3);
      const a = c0 < 128 ? B64_REV[c0] : -1;
      const b = c1 < 128 ? B64_REV[c1] : -1;
      const c = c2 === 61 || Number.isNaN(c2) ? -2 : c2 < 128 ? B64_REV[c2] : -1;
      const d = c3 === 61 || Number.isNaN(c3) ? -2 : c3 < 128 ? B64_REV[c3] : -1;
      if (a < 0 || b < 0) break;
      const n =
        (a << 18) | (b << 12) | ((c >= 0 ? c : 0) << 6) | (d >= 0 ? d : 0);
      out.push((n >> 16) & 0xff);
      if (c >= 0) out.push((n >> 8) & 0xff);
      if (d >= 0) out.push(n & 0xff);
    }
    return new Uint8Array(out);
  }

  function b64UrlToBytes(b64u) {
    const s = String(b64u || '')
      .trim()
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    return b64ToBytes(s + pad);
  }

  function utf8Decode(bytes) {
    let out = '';
    let i = 0;
    while (i < bytes.length) {
      const b0 = bytes[i++];
      if (b0 < 0x80) {
        out += String.fromCharCode(b0);
      } else if ((b0 & 0xe0) === 0xc0) {
        const b1 = bytes[i++] & 0x3f;
        out += String.fromCharCode(((b0 & 0x1f) << 6) | b1);
      } else if ((b0 & 0xf0) === 0xe0) {
        const b1 = bytes[i++] & 0x3f;
        const b2 = bytes[i++] & 0x3f;
        out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
      } else {
        const b1 = bytes[i++] & 0x3f;
        const b2 = bytes[i++] & 0x3f;
        const b3 = bytes[i++] & 0x3f;
        let cp =
          ((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3;
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return out;
  }

  function buildAesSbox() {
    const gfMul = (a, b) => {
      let p = 0;
      for (let i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        const hi = a & 0x80;
        a = (a << 1) & 0xff;
        if (hi) a ^= 0x1b;
        b >>= 1;
      }
      return p;
    };
    const rotl8 = (x, s) => ((x << s) | (x >>> (8 - s))) & 0xff;
    const sbox = new Uint8Array(256);
    let p = 1;
    let q = 1;
    do {
      p = p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0);
      p &= 0xff;
      q ^= q << 1;
      q ^= q << 2;
      q ^= q << 4;
      q ^= q & 0x80 ? 0x09 : 0;
      q &= 0xff;
      const xformed =
        q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63;
      sbox[p] = xformed;
    } while (p !== 1);
    sbox[0] = 0x63;
    // Touch gfMul usage to satisfy single-function containment cleanly if inspected
    void gfMul;
    return sbox;
  }

  const AES_SBOX = buildAesSbox();

  function aesKeyExpand256(key32) {
    if (!key32 || key32.length !== 32) {
      throw new Error('AES-256 key must be 32 bytes');
    }
    const rcon = [0, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40];
    const w = new Uint32Array(60);
    for (let i = 0; i < 8; i++) {
      const o = i * 4;
      w[i] =
        ((key32[o] << 24) |
          (key32[o + 1] << 16) |
          (key32[o + 2] << 8) |
          key32[o + 3]) >>>
        0;
    }
    const subWord = (word) =>
      ((AES_SBOX[(word >>> 24) & 0xff] << 24) |
        (AES_SBOX[(word >>> 16) & 0xff] << 16) |
        (AES_SBOX[(word >>> 8) & 0xff] << 8) |
        AES_SBOX[word & 0xff]) >>>
      0;
    const rotWord = (word) => ((word << 8) | (word >>> 24)) >>> 0;

    for (let i = 8; i < 60; i++) {
      let temp = w[i - 1];
      if (i % 8 === 0) {
        temp = (subWord(rotWord(temp)) ^ (rcon[i / 8] << 24)) >>> 0;
      } else if (i % 8 === 4) {
        temp = subWord(temp);
      }
      w[i] = (w[i - 8] ^ temp) >>> 0;
    }
    return w;
  }

  function aesEncryptBlock(rk, in16) {
    const s = new Uint8Array(in16);
    const addRoundKey = (round) => {
      const base = round * 4;
      for (let c = 0; c < 4; c++) {
        const k = rk[base + c];
        const o = c * 4;
        s[o] ^= (k >>> 24) & 0xff;
        s[o + 1] ^= (k >>> 16) & 0xff;
        s[o + 2] ^= (k >>> 8) & 0xff;
        s[o + 3] ^= k & 0xff;
      }
    };
    const subBytes = () => {
      for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    };
    const shiftRows = () => {
      let t = s[1];
      s[1] = s[5];
      s[5] = s[9];
      s[9] = s[13];
      s[13] = t;

      t = s[2];
      s[2] = s[10];
      s[10] = t;
      t = s[6];
      s[6] = s[14];
      s[14] = t;

      t = s[15];
      s[15] = s[11];
      s[11] = s[7];
      s[7] = s[3];
      s[3] = t;
    };
    const xtime = (x) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
    const mixColumns = () => {
      for (let c = 0; c < 4; c++) {
        const o = c * 4;
        const a0 = s[o];
        const a1 = s[o + 1];
        const a2 = s[o + 2];
        const a3 = s[o + 3];
        const t = a0 ^ a1 ^ a2 ^ a3;
        s[o] = a0 ^ t ^ xtime(a0 ^ a1);
        s[o + 1] = a1 ^ t ^ xtime(a1 ^ a2);
        s[o + 2] = a2 ^ t ^ xtime(a2 ^ a3);
        s[o + 3] = a3 ^ t ^ xtime(a3 ^ a0);
      }
    };

    addRoundKey(0);
    for (let round = 1; round <= 13; round++) {
      subBytes();
      shiftRows();
      mixColumns();
      addRoundKey(round);
    }
    subBytes();
    shiftRows();
    addRoundKey(14);
    return s;
  }

  function gfMul128(X, Y) {
    const Z = new Uint8Array(16);
    const V = new Uint8Array(Y);
    for (let i = 0; i < 128; i++) {
      if ((X[i >> 3] >> (7 - (i & 7))) & 1) {
        for (let k = 0; k < 16; k++) Z[k] ^= V[k];
      }
      const lsb = V[15] & 1;
      for (let b = 15; b >= 1; b--) {
        V[b] = (V[b] >>> 1) | ((V[b - 1] & 1) << 7);
      }
      V[0] = (V[0] >>> 1) ^ (lsb ? 0xe1 : 0);
    }
    return Z;
  }

  function ghash(H, ctBytes) {
    let Y = new Uint8Array(16);
    for (let off = 0; off < ctBytes.length; off += 16) {
      const end = Math.min(ctBytes.length, off + 16);
      for (let k = 0; k < end - off; k++) Y[k] ^= ctBytes[off + k];
      Y = gfMul128(Y, H);
    }
    const lenBlock = new Uint8Array(16);
    const bitLen = ctBytes.length * 8;
    const hi = Math.floor(bitLen / 4294967296);
    const lo = bitLen >>> 0;
    lenBlock[8] = (hi >>> 24) & 0xff;
    lenBlock[9] = (hi >>> 16) & 0xff;
    lenBlock[10] = (hi >>> 8) & 0xff;
    lenBlock[11] = hi & 0xff;
    lenBlock[12] = (lo >>> 24) & 0xff;
    lenBlock[13] = (lo >>> 16) & 0xff;
    lenBlock[14] = (lo >>> 8) & 0xff;
    lenBlock[15] = lo & 0xff;
    for (let k = 0; k < 16; k++) Y[k] ^= lenBlock[k];
    return gfMul128(Y, H);
  }

  function aes256GcmDecrypt(key32, iv12, ctWithTag) {
    if (!iv12 || iv12.length !== 12) {
      throw new Error('AES-GCM IV must be 12 bytes');
    }
    if (!ctWithTag || ctWithTag.length < 16) {
      throw new Error('Ciphertext too short');
    }
    const rk = aesKeyExpand256(key32);
    const H = aesEncryptBlock(rk, new Uint8Array(16));
    const J0 = new Uint8Array(16);
    J0.set(iv12, 0);
    J0[15] = 1;

    const ctLen = ctWithTag.length - 16;
    const ct = ctWithTag.subarray(0, ctLen);
    const authTag = ctWithTag.subarray(ctLen);
    const tagMask = aesEncryptBlock(rk, J0);
    const S = ghash(H, ct);

    let diff = 0;
    for (let k = 0; k < 16; k++) {
      diff |= (S[k] ^ tagMask[k]) ^ authTag[k];
    }
    if (diff !== 0) {
      throw new Error('GCM auth tag mismatch');
    }

    const cb = new Uint8Array(J0);
    const pt = new Uint8Array(ctLen);
    for (let off = 0; off < ctLen; off += 16) {
      // Increment big-endian 32-bit counter cb[12..15]
      for (let b = 15; b >= 12; b--) {
        cb[b] = (cb[b] + 1) & 0xff;
        if (cb[b] !== 0) break;
      }
      const ks = aesEncryptBlock(rk, cb);
      const n = Math.min(16, ctLen - off);
      for (let k = 0; k < n; k++) {
        pt[off + k] = ct[off + k] ^ ks[k];
      }
    }
    return pt;
  }

  function decryptVaultPureJs(envelope, syncKeyB64Url) {
    if (!envelope || envelope.v !== 1 || envelope.alg !== 'AES-256-GCM') {
      throw new Error('云端加密包格式不支持');
    }
    const key32 = b64UrlToBytes(syncKeyB64Url);
    const iv12 = b64ToBytes(envelope.iv);
    const ctWithTag = b64ToBytes(envelope.ct);
    const ptBytes = aes256GcmDecrypt(key32, iv12, ctWithTag);
    return JSON.parse(utf8Decode(ptBytes));
  }

  const WIDGET_CAT_META = {
    food: { label: '餐饮', icon: '🍜' },
    transit: { label: '交通', icon: '🚇' },
    shop: { label: '购物', icon: '🛍️' },
    daily: { label: '日用', icon: '🧴' },
    sport: { label: '运动', icon: '🏃' },
    home: { label: '住房', icon: '🏠' },
    fun: { label: '娱乐', icon: '🎮' },
    med: { label: '医疗', icon: '💊' },
    travel: { label: '旅行', icon: '✈️' },
    digital: { label: '数码', icon: '📱' },
    social: { label: '人情', icon: '🤝' },
    study: { label: '学习', icon: '📚' },
    other_exp: { label: '其他', icon: '📦' },
  };

  function computeWidgetSummary(snapshot, monthKey, todayDateStr) {
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const mk =
      monthKey || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    const today =
      todayDateStr || `${mk}-${pad2(now.getDate())}`;

    let monthExpense = 0;
    let monthIncome = 0;
    let todayExpense = 0;
    let pendingReimbCount = 0;
    let pendingReimbTotal = 0;
    const catTotals = {};

    for (const tx of (snapshot && snapshot.transactions) || []) {
      if (tx.deleted_at !== null && tx.deleted_at !== undefined) continue;
      if (tx.reimbursable && tx.reimburse_status === 'pending') {
        pendingReimbCount += 1;
        pendingReimbTotal += Number(tx.amount) || 0;
      }
      if (!tx.occurred_at || !tx.occurred_at.startsWith(mk)) continue;
      if (tx.exclude_from_stats || tx.type === 'transfer') continue;

      const amt = Number(tx.amount) || 0;
      if (tx.type === 'expense') {
        monthExpense += amt;
        if (tx.occurred_at.startsWith(today)) {
          todayExpense += amt;
        }
        const cKey = tx.category || 'other_exp';
        catTotals[cKey] = (catTotals[cKey] || 0) + amt;
      } else if (tx.type === 'income') {
        monthIncome += amt;
      }
    }

    const budgets = (snapshot && snapshot.budgets) || {};
    const bObj = budgets[mk] || budgets.default || {};
    const budgetTotal = Number(bObj.total) || 0;
    const budgetRemaining = budgetTotal > 0 ? budgetTotal - monthExpense : 0;
    const budgetPct = budgetTotal > 0 ? (monthExpense / budgetTotal) * 100 : 0;

    const topCategories = Object.keys(catTotals)
      .map((key) => {
        const meta = WIDGET_CAT_META[key] || { label: key, icon: '📦' };
        return {
          key,
          label: meta.label,
          icon: meta.icon,
          amount: Math.round(catTotals[key] * 100) / 100,
        };
      })
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3);

    return {
      monthKey: mk,
      today,
      monthExpense: Math.round(monthExpense * 100) / 100,
      monthIncome: Math.round(monthIncome * 100) / 100,
      todayExpense: Math.round(todayExpense * 100) / 100,
      pendingReimbCount,
      pendingReimbTotal: Math.round(pendingReimbTotal * 100) / 100,
      budgetTotal: Math.round(budgetTotal * 100) / 100,
      budgetRemaining: Math.round(budgetRemaining * 100) / 100,
      budgetPct: Math.round(budgetPct * 10) / 10,
      topCategories,
    };
  }

  function generateScriptableWidgetCode({ gistId, syncKey, token, appUrl }) {
    if (!gistId || !syncKey || !token) {
      throw new Error('生成小组件代码缺少 Gist ID、Sync Key 或 Token');
    }
    const cleanBase = String(appUrl || 'https://justambush.github.io/qingzhang-ledger/')
      .split('#')[0]
      .split('?')[0];
    const tapUrl = cleanBase + '?action=add#add';
    const cfgJson = JSON.stringify(
      {
        gistId: String(gistId).trim(),
        syncKey: String(syncKey).trim(),
        token: String(token).trim(),
        tapUrl,
      },
      null,
      2
    );

    return `// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: wallet;
// 轻账 QingZhang · iPhone 负一屏 (左滑) & 桌面实时记账小组件
// 点击小组件将直接拉起轻账「记一笔」界面

const CFG = ${cfgJson};

const B64_ALPHABET = ${JSON.stringify(B64_ALPHABET)};
const B64_REV = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) m[B64_ALPHABET.charCodeAt(i)] = i;
  return m;
})();

${b64ToBytes.toString()}

${b64UrlToBytes.toString()}

${utf8Decode.toString()}

${buildAesSbox.toString()}
const AES_SBOX = buildAesSbox();

${aesKeyExpand256.toString()}

${aesEncryptBlock.toString()}

${gfMul128.toString()}

${ghash.toString()}

${aes256GcmDecrypt.toString()}

${decryptVaultPureJs.toString()}

const WIDGET_CAT_META = ${JSON.stringify(WIDGET_CAT_META)};

${computeWidgetSummary.toString()}

function fmtYuan(val, decimals = 2) {
  const neg = val < 0 ? '-' : '';
  const abs = Math.abs(Number(val) || 0);
  const fixed = abs.toFixed(decimals);
  const parts = fixed.split('.');
  parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  return neg + '¥' + parts.join('.');
}

function drawProgressBar(pct, over, width, height) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const r = height / 2;

  ctx.setFillColor(new Color('#E4E7EC'));
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, width, height), r, r);
  ctx.addPath(track);
  ctx.fillPath();

  const ratio = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
  if (ratio > 0) {
    const fillW = Math.max(height, Math.round(width * ratio));
    ctx.setFillColor(new Color(over ? '#DC2626' : '#F59E0B'));
    const bar = new Path();
    bar.addRoundedRect(new Rect(0, 0, fillW, height), r, r);
    ctx.addPath(bar);
    ctx.fillPath();
  }
  return ctx.getImage();
}

async function loadLedgerSnapshot() {
  const fm = FileManager.local();
  const cachePath = fm.joinPath(fm.documentsDirectory(), 'qingzhang_widget_cache_v1.json');
  try {
    const req = new Request('https://api.github.com/gists/' + encodeURIComponent(CFG.gistId));
    req.timeoutInterval = 8;
    req.headers = {
      Authorization: 'Bearer ' + CFG.token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'QingZhang-Scriptable-Widget/1.0',
    };
    const gist = await req.loadJSON();
    const vf = gist && gist.files && gist.files['qingzhang_vault.enc.json'];
    let env = null;
    if (vf) {
      if (vf.truncated && vf.raw_url) {
        const r2 = new Request(vf.raw_url);
        r2.timeoutInterval = 8;
        r2.headers = {
          Authorization: 'Bearer ' + CFG.token,
          'User-Agent': 'QingZhang-Scriptable-Widget/1.0',
        };
        env = await r2.loadJSON();
      } else if (vf.content) {
        env = JSON.parse(vf.content);
      }
    }
    if (env && env.alg === 'AES-256-GCM') {
      const snap = decryptVaultPureJs(env, CFG.syncKey);
      const cachedAt = Date.now();
      fm.writeString(cachePath, JSON.stringify({ cachedAt, snap }));
      return { snap, offline: false, updatedAt: cachedAt };
    }
  } catch (err) {
    if (fm.fileExists(cachePath)) {
      const cached = JSON.parse(fm.readString(cachePath));
      return {
        snap: cached.snap || { transactions: [], budgets: {} },
        offline: true,
        updatedAt: cached.cachedAt || Date.now(),
        errMsg: String((err && err.message) || err || ''),
      };
    }
    throw err;
  }
  if (fm.fileExists(cachePath)) {
    const cached = JSON.parse(fm.readString(cachePath));
    return { snap: cached.snap, offline: true, updatedAt: cached.cachedAt || Date.now() };
  }
  return { snap: { transactions: [], budgets: {} }, offline: false, updatedAt: Date.now() };
}

function fmtHHMM(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function buildWidget(summary, meta) {
  const w = new ListWidget();
  w.backgroundColor = new Color('#FFFFFF');
  w.url = CFG.tapUrl;
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

  const isSmall = config.widgetFamily === 'small';
  w.setPadding(isSmall ? 12 : 14, isSmall ? 12 : 16, isSmall ? 12 : 14, isSmall ? 12 : 16);

  const ink = new Color('#101828');
  const muted = new Color('#667085');
  const brand = new Color('#F59E0B');
  const brandInk = new Color('#92400E');
  const brandSoft = new Color('#FEF3C7');
  const danger = new Color('#DC2626');
  const okCol = new Color('#059669');
  const moLabel = Number(summary.monthKey.slice(5)) + '月支出';

  // Header Row
  const head = w.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();
  const title = head.addText('📒 轻账 · ' + moLabel);
  title.font = Font.semiboldSystemFont(isSmall ? 12 : 13);
  title.textColor = muted;
  head.addSpacer();
  const addPill = head.addStack();
  addPill.backgroundColor = brandSoft;
  addPill.cornerRadius = 8;
  addPill.setPadding(2, 7, 2, 7);
  const addTxt = addPill.addText(isSmall ? '＋' : '＋ 记一笔');
  addTxt.font = Font.boldSystemFont(11);
  addTxt.textColor = brandInk;

  if (isSmall) {
    w.addSpacer(8);
    const amt = w.addText(fmtYuan(summary.monthExpense, summary.monthExpense >= 10000 ? 0 : 2));
    amt.font = Font.boldRoundedSystemFont(22);
    amt.textColor = ink;
    amt.minimumScaleFactor = 0.7;

    w.addSpacer(8);
    if (summary.budgetTotal > 0) {
      const over = summary.budgetRemaining < 0;
      const bar = w.addImage(drawProgressBar(summary.budgetPct, over, 240, 14));
      bar.imageSize = new Size(124, 7);
      w.addSpacer(4);
      const bTxt = w.addText(
        over
          ? '超预算 ' + fmtYuan(Math.abs(summary.budgetRemaining), 0)
          : '剩 ' + fmtYuan(summary.budgetRemaining, 0) + ' (' + Math.max(0, Math.round(100 - summary.budgetPct)) + '%)'
      );
      bTxt.font = Font.mediumSystemFont(11);
      bTxt.textColor = over ? danger : muted;
    } else {
      const tTxt = w.addText('今日 ' + fmtYuan(summary.todayExpense));
      tTxt.font = Font.mediumSystemFont(12);
      tTxt.textColor = muted;
    }
    w.addSpacer();
    const ft = w.addText((meta.offline ? '离线缓存 · ' : '已同步 ') + fmtHHMM(meta.updatedAt));
    ft.font = Font.regularSystemFont(10);
    ft.textColor = muted;
    return w;
  }

  // Medium / Large Left-Swipe Today View Widget Layout
  w.addSpacer(8);
  const body = w.addStack();
  body.layoutHorizontally();
  body.topAlignContent();

  // Left Column: Hero Month Spend & Today Spend
  const left = body.addStack();
  left.layoutVertically();
  const amt = left.addText(fmtYuan(summary.monthExpense, 2));
  amt.font = Font.boldRoundedSystemFont(26);
  amt.textColor = ink;
  amt.minimumScaleFactor = 0.65;
  left.addSpacer(4);
  const todayTxt = left.addText('今日支出 ' + fmtYuan(summary.todayExpense));
  todayTxt.font = Font.mediumSystemFont(12);
  todayTxt.textColor = muted;
  if (summary.pendingReimbCount > 0) {
    left.addSpacer(2);
    const rTxt = left.addText(
      '待报销 ' + summary.pendingReimbCount + '笔 · ' + fmtYuan(summary.pendingReimbTotal, 0)
    );
    rTxt.font = Font.mediumSystemFont(11);
    rTxt.textColor = new Color('#0284C7');
  }

  body.addSpacer(14);

  // Right Column: Budget Bar + Top Categories
  const right = body.addStack();
  right.layoutVertically();
  if (summary.budgetTotal > 0) {
    const over = summary.budgetRemaining < 0;
    const bTitle = right.addText(
      over
        ? '超支 ' + fmtYuan(Math.abs(summary.budgetRemaining), 0)
        : '预算余 ' + fmtYuan(summary.budgetRemaining, 0)
    );
    bTitle.font = Font.semiboldSystemFont(12);
    bTitle.textColor = over ? danger : okCol;
    right.addSpacer(4);
    const barImg = right.addImage(drawProgressBar(summary.budgetPct, over, 260, 14));
    barImg.imageSize = new Size(132, 7);
    right.addSpacer(6);
  } else {
    const noB = right.addText('未设置本月预算');
    noB.font = Font.mediumSystemFont(11);
    noB.textColor = muted;
    right.addSpacer(4);
  }

  if (summary.topCategories.length > 0) {
    for (const c of summary.topCategories.slice(0, 2)) {
      const cRow = right.addText(c.icon + ' ' + c.label + ' ' + fmtYuan(c.amount, 0));
      cRow.font = Font.regularSystemFont(11);
      cRow.textColor = ink;
      cRow.lineLimit = 1;
    }
  } else {
    const eRow = right.addText('本月暂无计入支出');
    eRow.font = Font.regularSystemFont(11);
    eRow.textColor = muted;
  }

  w.addSpacer();
  const foot = w.addStack();
  foot.layoutHorizontally();
  const status = foot.addText(
    (meta.offline ? '离线缓存 · ' : 'AES-256-GCM 同步于 ') + fmtHHMM(meta.updatedAt)
  );
  status.font = Font.regularSystemFont(10);
  status.textColor = muted;
  foot.addSpacer();
  const dot = foot.addText('●');
  dot.font = Font.regularSystemFont(9);
  dot.textColor = meta.offline ? brand : okCol;

  return w;
}

(async () => {
  try {
    const data = await loadLedgerSnapshot();
    const summary = computeWidgetSummary(data.snap);
    const widget = buildWidget(summary, data);
    Script.setWidget(widget);
    if (config.runsInApp) {
      await (config.widgetFamily === 'small' ? widget.presentSmall() : widget.presentMedium());
    }
  } catch (err) {
    const w = new ListWidget();
    w.backgroundColor = new Color('#FFFFFF');
    w.url = CFG.tapUrl;
    w.setPadding(14, 14, 14, 14);
    const t = w.addText('📒 轻账小组件');
    t.font = Font.boldSystemFont(14);
    t.textColor = new Color('#101828');
    w.addSpacer(6);
    const m = w.addText('读取云端失败: ' + String((err && err.message) || err));
    m.font = Font.regularSystemFont(12);
    m.textColor = new Color('#DC2626');
    Script.setWidget(w);
    if (config.runsInApp) await w.presentMedium();
  }
})().finally(() => Script.complete());
`;
  }

  const api = {
    b64ToBytes,
    b64UrlToBytes,
    utf8Decode,
    aes256GcmDecrypt,
    decryptVaultPureJs,
    computeWidgetSummary,
    generateScriptableWidgetCode,
  };

  global.QZWidget = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
