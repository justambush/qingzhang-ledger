(function () {
  'use strict';

  const StoreApi = window.QZStore;
  const CryptoApi = window.QZCrypto;
  const ReconApi = window.QZReconcile;

  const store = new StoreApi.LedgerStore();

  const state = {
    activeTab: 'ledger',
    monthKey: StoreApi.currentMonthKey(),
    filterSearch: '',
    filterTag: '',
    filterReimbOnly: false,
    rankMode: 'category',

    // Entry modal state
    entryEditingId: null,
    entryType: 'expense',
    entryCategory: 'food',
    entryTags: [],
    entryReimbursable: false,
    entryReimburseStatus: 'none',
    entrySource: 'manual',
    entryExternalRefs: [],
    entryPlanId: null,
    entryPlanMode: null,
    entryPlanIndex: null,
    entryPlanTotal: null,
    entryPlanOriginAmount: null,
    planBoxOpen: false,
    planMode: 'split',
    planPeriods: 1,
    calcExpr: '',

    // Reconcile state
    uploadedFiles: [],
    rawBillItems: [],
    pendingMappingFiles: [],
    reconFilter: 'missing',
    reconResult: null,

    // Runtime env
    isSidecar: CryptoApi.isSidecarEnvironment(),
    sidecarSyncInfo: null,
    deferredInstallPrompt: null,
    isIOS: /iphone|ipad|ipod/i.test(navigator.userAgent || ''),
    isStandalone:
      window.matchMedia('(display-mode: standalone)').matches ||
      navigator.standalone === true,
    pendingPairCode: '',
    syncing: false,
  };

  const APPS_SCRIPT_SNIPPET = `function doGet(e) {
  var p = PropertiesService.getUserProperties();
  var secret = p.getProperty('QZ_SECRET') || '';
  if (secret && (e.parameter.secret || '') !== secret) {
    return ContentService.createTextOutput(JSON.stringify({error:'forbidden'}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var vault = p.getProperty('QZ_VAULT') || '{}';
  return ContentService.createTextOutput(vault)
    .setMimeType(ContentService.MimeType.JSON);
}
function doPost(e) {
  var data = JSON.parse(e.postData.contents || '{}');
  var p = PropertiesService.getUserProperties();
  var secret = p.getProperty('QZ_SECRET') || '';
  if (secret && data.secret !== secret) {
    return ContentService.createTextOutput(JSON.stringify({error:'forbidden'}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  delete data.secret;
  p.setProperty('QZ_VAULT', JSON.stringify(data));
  return ContentService.createTextOutput(JSON.stringify({ok:true}))
    .setMimeType(ContentService.MimeType.JSON);
}`;

  const $ = (id) => document.getElementById(id);

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtMoney(v) {
    return '¥' + (Number(v) || 0).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  function shiftMonth(monthKey, delta) {
    const [y, m] = monthKey.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function formatMonthLabel(monthKey) {
    const [y, m] = monthKey.split('-');
    return `${y}年${Number(m)}月`;
  }

  function formatDayHeading(dateStr) {
    const today = StoreApi.formatLocalDateTime().slice(0, 10);
    const yest = StoreApi.formatLocalDateTime(
      new Date(Date.now() - 86400000)
    ).slice(0, 10);
    const [y, m, d] = dateStr.split('-').map(Number);
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const wd = weekdays[new Date(y, m - 1, d).getDay()];
    const suffix = dateStr === today ? ' 今天' : dateStr === yest ? ' 昨天' : '';
    return `${m}月${d}日 ${wd}${suffix}`;
  }

  function evalCalcExpression(expr) {
    const cleaned = String(expr || '').replace(/[^0-9.+\-]/g, '');
    if (!cleaned) return 0;
    const tokens = cleaned.match(/[+-]?[0-9]*\.?[0-9]+/g);
    if (!tokens) return 0;
    let sum = 0;
    for (const tk of tokens) {
      const n = Number(tk);
      if (Number.isFinite(n)) sum += n;
    }
    return Math.max(0, Math.round(sum * 100) / 100);
  }

  // -------------------------------------------------------------------------
  // Sync & Pairing Lifecycle
  // -------------------------------------------------------------------------

  async function refreshSidecarMeta() {
    if (!state.isSidecar) return;
    try {
      const [sRes, cRes] = await Promise.all([
        window.sidecar.fetch('/api/ledger/state'),
        window.sidecar.fetch('/api/sync/config'),
      ]);
      if (sRes.ok) {
        const sData = await sRes.json();
        if (sData && sData.snapshot) {
          await store.replaceFromMerge(sData.snapshot);
        }
      }
      if (cRes.ok) {
        const cData = await cRes.json();
        if (cData && cData.sync) {
          state.sidecarSyncInfo = cData.sync;
        }
      }
    } catch (err) {
      console.warn('Sidecar initial fetch error:', err);
    }
  }

  async function runSync(silent = true) {
    if (state.syncing) return;
    const cfg = store.meta.sync_config;
    if (!state.isSidecar && (!cfg || !cfg.sync_key)) {
      updateSyncPill();
      return;
    }
    if (!navigator.onLine && !state.isSidecar) {
      updateSyncPill();
      return;
    }
    state.syncing = true;
    updateSyncPill();
    try {
      if (state.isSidecar) {
        await CryptoApi.syncViaSidecar(store);
        const res = await window.sidecar.fetch('/api/sync/now', {
          method: 'POST',
          body: '{}',
        });
        if (res.ok) {
          const data = await res.json();
          if (data.snapshot) await store.replaceFromMerge(data.snapshot);
          if (data.sync) state.sidecarSyncInfo = data.sync;
        }
        if (!silent) showToast('已同步 Jetski 账本');
      } else {
        const res = await CryptoApi.syncViaCloud(store, cfg);
        if (res.ok && !silent) showToast('云端加密同步完成');
      }
    } catch (err) {
      if (!silent) showToast(err.message || '同步失败，已保留离线记录');
    } finally {
      state.syncing = false;
      renderAll();
    }
  }

  function updateSyncPill() {
    const dot = $('sync-dot');
    const txt = $('sync-pill-text');
    dot.className = 'sync-dot';
    if (state.syncing) {
      dot.classList.add('syncing');
      txt.textContent = '同步中...';
      return;
    }
    if (!navigator.onLine && !state.isSidecar) {
      txt.textContent = '离线模式';
      return;
    }
    if (state.isSidecar) {
      dot.classList.add('ok');
      const remoteOn = state.sidecarSyncInfo && state.sidecarSyncInfo.configured;
      txt.textContent = remoteOn ? 'Jetski 已连云端' : 'Jetski 本地';
      return;
    }
    const cfg = store.meta.sync_config;
    if (cfg && cfg.sync_key) {
      dot.classList.add('ok');
      txt.textContent = store.meta.last_sync_at
        ? `已同步 ${store.meta.last_sync_at}`
        : '已配对';
    } else {
      txt.textContent = '离线本机';
    }
  }

  async function applyPairingString(raw) {
    const parsed = CryptoApi.parsePairingCode(raw);
    await store.setMeta('sync_config', parsed);
    state.pendingPairCode = '';
    $('ios-pair-banner').classList.add('hidden');
    $('pair-input-box').classList.add('hidden');
    await runSync(false);
    renderSettings();
  }

  async function handleIncomingHashPairing() {
    const hash = window.location.hash || '';
    const idx = hash.indexOf('pair=');
    if (idx < 0) return;
    const rawPair = decodeURIComponent(hash.slice(idx + 5).split('&')[0] || '');
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!rawPair) return;

    try {
      const parsed = CryptoApi.parsePairingCode(rawPair);
      const code = CryptoApi.encodePairingCode(parsed);
      if (state.isIOS && !state.isStandalone) {
        // On iOS, Safari browser storage is isolated from Home Screen PWA storage!
        state.pendingPairCode = code;
        await store.setMeta('sync_config', parsed);
        renderIosPairBanner();
        await runSync(true);
      } else {
        await applyPairingString(code);
      }
    } catch (err) {
      showToast(err.message || '配对码无效');
    }
  }

  function renderIosPairBanner() {
    const el = $('ios-pair-banner');
    if (!state.pendingPairCode) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="card-head">
        <h3>📲 检测到 Jetski 配对码</h3>
        <button type="button" class="btn-text" id="btn-close-pair-banner">收起</button>
      </div>
      <p class="muted-sm">
        1. 点击 Safari 底部 <strong>分享 [↑] → 添加到主屏幕</strong><br>
        2. 点下方按钮复制配对码，从桌面打开「轻账」后粘贴配对即可。
      </p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary btn-sm" id="btn-banner-copy-pair">📋 一键复制配对码</button>
      </div>
    `;
    $('btn-close-pair-banner').onclick = () => el.classList.add('hidden');
    $('btn-banner-copy-pair').onclick = async () => {
      await copyText(state.pendingPairCode, '配对码已复制，请从主屏幕打开轻账后粘贴');
    };
  }

  async function copyText(text, okMsg = '已复制到剪贴板') {
    try {
      await navigator.clipboard.writeText(text);
      showToast(okMsg);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast(okMsg);
    }
  }

  // -------------------------------------------------------------------------
  // Rendering: Header, Ledger, Charts, Reconcile, Settings
  // -------------------------------------------------------------------------

  function renderAll() {
    const stats = StoreApi.computeMonthStats(store.snapshot, state.monthKey);
    renderHeader(stats);
    if (state.activeTab === 'ledger') renderLedger(stats);
    if (state.activeTab === 'charts') renderCharts(stats);
    if (state.activeTab === 'reconcile') renderReconcile();
    if (state.activeTab === 'settings') renderSettings();
  }

  function renderHeader(stats) {
    $('month-label').textContent = formatMonthLabel(state.monthKey);
    $('sum-expense').textContent = fmtMoney(stats.personalExpense);
    $('sum-income').textContent = fmtMoney(stats.personalIncome);

    const bk = $('sum-budget-k');
    const bv = $('sum-budget-v');
    bv.className = 'sum-v';
    if (stats.totalBudget > 0) {
      if (stats.remainingBudget < 0) {
        bk.textContent = '超出预算';
        bv.textContent = fmtMoney(Math.abs(stats.remainingBudget));
        bv.classList.add('is-over');
      } else {
        bk.textContent = '预算剩余';
        bv.textContent = fmtMoney(stats.remainingBudget);
      }
    } else {
      bk.textContent = '本月预算';
      bv.textContent = '点此设置';
    }
    updateSyncPill();
  }

  function renderLedger(stats) {
    const chipsWrap = $('ledger-filter-chips');
    const chips = [];

    if (stats.pendingReimbursements.length > 0 || state.filterReimbOnly) {
      chips.push(
        `<button type="button" class="chip reimb ${state.filterReimbOnly ? 'active' : ''}" data-filter-reimb="1">🧾 待报销 ${stats.pendingReimbursements.length}笔 (${fmtMoney(stats.pendingTotal)})</button>`
      );
    }
    const usedTags = Array.from(
      new Set(
        stats.monthActive.flatMap((t) => t.tags || []).concat(store.getActiveTags())
      )
    ).slice(0, 12);
    for (const tg of usedTags) {
      const act = state.filterTag === tg ? 'active' : '';
      chips.push(
        `<button type="button" class="chip ${act}" data-filter-tag="${esc(tg)}">#${esc(tg)}</button>`
      );
    }
    chipsWrap.innerHTML = chips.join('');
    chipsWrap.querySelectorAll('[data-filter-reimb]').forEach((btn) => {
      btn.onclick = () => {
        state.filterReimbOnly = !state.filterReimbOnly;
        renderAll();
      };
    });
    chipsWrap.querySelectorAll('[data-filter-tag]').forEach((btn) => {
      btn.onclick = () => {
        const tg = btn.getAttribute('data-filter-tag');
        state.filterTag = state.filterTag === tg ? '' : tg;
        renderAll();
      };
    });

    const sourceList = state.filterReimbOnly
      ? stats.pendingReimbursements
      : stats.monthActive;

    const q = state.filterSearch.trim().toLowerCase();
    const filtered = sourceList.filter((tx) => {
      if (state.filterTag && !(tx.tags || []).includes(state.filterTag)) {
        return false;
      }
      if (!q) return true;
      const catLabel = (StoreApi.CATEGORY_MAP[tx.category] || {}).label || '';
      const hay = [
        tx.note,
        catLabel,
        tx.amount.toFixed(2),
        ...(tx.tags || []).map((t) => '#' + t),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });

    const listEl = $('ledger-list');
    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="empty-box">
          <div class="empty-ico">📒</div>
          <div>${state.filterReimbOnly ? '暂无待报销记录' : '本月还没有账目，点下方 ＋ 记一笔'}</div>
        </div>
      `;
      return;
    }

    // Group by date YYYY-MM-DD
    const groups = new Map();
    for (const tx of filtered) {
      const d = tx.occurred_at.slice(0, 10);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(tx);
    }

    let html = '';
    for (const [dateStr, items] of groups.entries()) {
      let dayExp = 0;
      let dayInc = 0;
      for (const it of items) {
        if (it.exclude_from_stats || it.type === 'transfer') continue;
        if (it.type === 'expense') dayExp += it.amount;
        if (it.type === 'income') dayInc += it.amount;
      }
      const sumParts = [];
      if (dayExp > 0) sumParts.push('支 ' + fmtMoney(dayExp));
      if (dayInc > 0) sumParts.push('收 ' + fmtMoney(dayInc));

      html += `<div class="day-group">
        <div class="day-head">
          <span>${esc(formatDayHeading(dateStr))}</span>
          <span>${esc(sumParts.join(' · ') || '不入账')}</span>
        </div>`;

      for (const tx of items) {
        const cat = StoreApi.CATEGORY_MAP[tx.category] || {
          icon: '📦',
          label: tx.category,
        };
        const timeStr = tx.occurred_at.slice(11, 16);
        const amtPrefix =
          tx.type === 'expense' ? '-' : tx.type === 'income' ? '+' : '';
        const tagsHtml = (tx.tags || [])
          .map((t) => `<span class="tag-badge">#${esc(t)}</span>`)
          .join('');
        let badgeHtml = '';
        if (tx.reimbursable) {
          badgeHtml =
            tx.reimburse_status === 'done'
              ? '<span class="status-badge done">已报销</span>'
              : '<span class="status-badge pending">待报销·不入账</span>';
        } else if (tx.exclude_from_stats || tx.type === 'transfer') {
          badgeHtml = '<span class="status-badge excluded">不入账</span>';
        }
        let planHtml = '';
        if (tx.plan_id && tx.plan_total) {
          const pTxt =
            tx.plan_mode === 'repeat'
              ? `${tx.plan_total === 12 ? '全年' : '周期'} ${tx.plan_index || 1}/${tx.plan_total}`
              : `分摊 ${tx.plan_index || 1}/${tx.plan_total}`;
          planHtml = `<span class="plan-badge">${esc(pTxt)}</span>`;
        }

        html += `
          <div class="tx-row" data-tx-id="${esc(tx.id)}">
            <div class="tx-ico">${esc(cat.icon)}</div>
            <div class="tx-main">
              <div class="tx-title-line">
                <span>${esc(cat.label)}</span>
                ${tx.note ? `<span class="tx-note">${esc(tx.note)}</span>` : ''}
              </div>
              <div class="tx-sub-line">
                <span>${esc(timeStr)}</span>
                ${planHtml}
                ${badgeHtml}
                ${tagsHtml}
              </div>
            </div>
            <div class="tx-amt ${esc(tx.type)}">${amtPrefix}${fmtMoney(tx.amount)}</div>
          </div>
        `;
      }
      html += '</div>';
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('.tx-row').forEach((row) => {
      row.onclick = () => openEntryModal(row.getAttribute('data-tx-id'));
    });
  }

  function renderCharts(stats) {
    // Budget Card
    const bCard = $('budget-card');
    if (stats.totalBudget > 0) {
      const pct = Math.min(100, Math.round(stats.budgetPct));
      const over = stats.remainingBudget < 0;
      bCard.innerHTML = `
        <div class="card-head">
          <h3>月度预算</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-open-budget-modal">设预算</button>
        </div>
        <div class="budget-meta">
          <span>已支出 <strong>${fmtMoney(stats.personalExpense)}</strong> / ${fmtMoney(stats.totalBudget)}</span>
          <span>${over ? '已超支 ' + fmtMoney(Math.abs(stats.remainingBudget)) : '剩余 ' + fmtMoney(stats.remainingBudget)}</span>
        </div>
        <div class="budget-bar-track">
          <div class="budget-bar-fill ${over ? 'over' : ''}" style="width:${pct}%"></div>
        </div>
        <div class="budget-meta">
          <span>已用 ${stats.budgetPct.toFixed(0)}%${stats.excludedExpense > 0 ? ` · 已剔除报销/不入账 ${fmtMoney(stats.excludedExpense)}` : ''}</span>
          <span>${over ? '日均可用 ¥0.00' : '日均可用 ' + fmtMoney(stats.dailyAllowance)}</span>
        </div>
      `;
    } else {
      bCard.innerHTML = `
        <div class="card-head">
          <h3>月度预算</h3>
          <button type="button" class="btn btn-primary btn-sm" id="btn-open-budget-modal">设置预算</button>
        </div>
        <p class="muted-sm">设置月度总预算与分类上限，系统会自动剔除报销和不入账支出。</p>
      `;
    }
    $('btn-open-budget-modal').onclick = openBudgetModal;

    // Daily Spend SVG Bar Chart
    const avg =
      stats.daysInMonth > 0 ? stats.personalExpense / stats.daysInMonth : 0;
    $('chart-avg-label').textContent = `日均 ${fmtMoney(avg)} · 合计 ${fmtMoney(stats.personalExpense)}`;

    const maxVal = Math.max(10, ...stats.dailySeries, avg * 1.2);
    const W = 360;
    const H = 112;
    const padL = 6;
    const padR = 6;
    const padT = 10;
    const padB = 20;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;
    const slotW = chartW / stats.daysInMonth;
    const barW = Math.max(4, slotW * 0.66);

    const avgY = padT + chartH - (avg / maxVal) * chartH;
    let barsSvg = '';
    for (let i = 0; i < stats.daysInMonth; i++) {
      const val = stats.dailySeries[i];
      const bh = val > 0 ? Math.max(3, (val / maxVal) * chartH) : 2;
      const x = padL + i * slotW + (slotW - barW) / 2;
      const y = padT + chartH - bh;
      const fill = val > 0 ? '#F59E0B' : '#E5E7EB';
      barsSvg += `<rect class="day-bar" data-day="${i + 1}" data-val="${val.toFixed(2)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${fill}" style="cursor:pointer"/>`;
    }
    const labelDays = [1, 5, 10, 15, 20, 25, stats.daysInMonth];
    let labelsSvg = '';
    for (const d of labelDays) {
      const lx = padL + (d - 0.5) * slotW;
      labelsSvg += `<text x="${lx.toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="#667085">${d}</text>`;
    }

    $('daily-chart-wrap').innerHTML = `
      <svg class="daily-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line x1="${padL}" y1="${avgY.toFixed(1)}" x2="${W - padR}" y2="${avgY.toFixed(1)}" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="3,3"/>
        ${barsSvg}
        ${labelsSvg}
      </svg>
    `;
    $('daily-chart-wrap')
      .querySelectorAll('.day-bar')
      .forEach((bar) => {
        bar.onclick = () => {
          const d = bar.getAttribute('data-day');
          const v = Number(bar.getAttribute('data-val'));
          $('daily-chart-tip').textContent = `${state.monthKey.slice(5)}月${d}日 个人支出：${fmtMoney(v)}`;
        };
      });

    // Category vs Tag Rank
    $('rank-total-label').textContent = fmtMoney(stats.personalExpense);
    const rankListEl = $('rank-list');
    if (state.rankMode === 'category') {
      if (stats.byCategory.length === 0) {
        rankListEl.innerHTML = '<p class="muted-sm">本月暂无计入统计的支出</p>';
      } else {
        rankListEl.innerHTML = stats.byCategory
          .map((item) => {
            const capHint =
              item.budgetCap > 0
                ? `<span class="muted-sm"> / 限额 ${fmtMoney(item.budgetCap)}</span>`
                : '';
            return `
            <div class="rank-item">
              <div class="rank-top">
                <span>${esc(item.meta.icon)} ${esc(item.meta.label)} <span class="muted-sm">${item.pct.toFixed(1)}%</span>${capHint}</span>
                <span>${fmtMoney(item.amount)}</span>
              </div>
              <div class="rank-track"><div class="rank-fill" style="width:${Math.min(100, item.pct).toFixed(1)}%"></div></div>
            </div>`;
          })
          .join('');
      }
    } else {
      if (stats.byTag.length === 0) {
        rankListEl.innerHTML = '<p class="muted-sm">本月支出暂未打 #标签</p>';
      } else {
        rankListEl.innerHTML = stats.byTag
          .map(
            (item) => `
          <div class="rank-item">
            <div class="rank-top">
              <span>#${esc(item.tag)} <span class="muted-sm">${item.count}笔 · ${item.pct.toFixed(1)}%</span></span>
              <span>${fmtMoney(item.amount)}</span>
            </div>
            <div class="rank-track"><div class="rank-fill" style="width:${Math.min(100, item.pct).toFixed(1)}%;background:#0284C7"></div></div>
          </div>`
          )
          .join('');
      }
    }

    // Pending Reimbursement Pool
    const rCard = $('reimb-pool-card');
    if (stats.pendingReimbursements.length === 0) {
      rCard.classList.add('hidden');
    } else {
      rCard.classList.remove('hidden');
      rCard.innerHTML = `
        <div class="card-head">
          <h3>🧾 待报销费用池（未计入个人支出）</h3>
          <strong>${fmtMoney(stats.pendingTotal)}</strong>
        </div>
        ${stats.pendingReimbursements
          .slice(0, 10)
          .map((tx) => {
            const cat = StoreApi.CATEGORY_MAP[tx.category] || {
              icon: '🧾',
              label: tx.category,
            };
            return `
            <div class="rank-item">
              <div class="rank-top">
                <span>${esc(cat.icon)} ${esc(tx.note || cat.label)} <span class="muted-sm">${esc(tx.occurred_at.slice(0, 10))}</span></span>
                <span>
                  ${fmtMoney(tx.amount)}
                  <button type="button" class="btn btn-ghost btn-sm" data-settle-id="${esc(tx.id)}">✓ 已报销</button>
                </span>
              </div>
            </div>`;
          })
          .join('')}
      `;
      rCard.querySelectorAll('[data-settle-id]').forEach((btn) => {
        btn.onclick = async () => {
          await store.settleReimbursement(btn.getAttribute('data-settle-id'));
          showToast('已标记为报销完成');
          renderAll();
          runSync(true);
        };
      });
    }

    // Future Scheduled Installments & Recurring Plans
    const fCard = $('future-plans-card');
    const future = StoreApi.computeFutureCommitments(
      store.snapshot,
      state.monthKey
    );
    if (future.nextMonths.length === 0) {
      fCard.classList.add('hidden');
    } else {
      fCard.classList.remove('hidden');
      const monthChips = future.nextMonths
        .map(
          (m) =>
            `<span class="chip">${esc(m.monthKey.slice(2))} · ${fmtMoney(m.amount)}</span>`
        )
        .join('');
      const plansHtml = future.activePlans
        .slice(0, 10)
        .map((p) => {
          const cat = StoreApi.CATEGORY_MAP[p.category] || {
            icon: '📅',
            label: p.category,
          };
          const kindTxt =
            p.plan_mode === 'repeat'
              ? p.plan_total === 12
                ? '全年定额'
                : '周期定额'
              : '分摊';
          return `
          <div class="rank-item">
            <div class="rank-top">
              <span>${esc(cat.icon)} ${esc(p.note || cat.label)} <span class="plan-badge">${esc(kindTxt)} · 剩${p.remainingPeriods}期</span></span>
              <span>
                ${fmtMoney(p.remainingAmount)}
                <button type="button" class="btn btn-ghost btn-sm" data-del-plan="${esc(p.plan_id)}">删整组</button>
              </span>
            </div>
          </div>`;
        })
        .join('');
      fCard.innerHTML = `
        <div class="card-head">
          <h3>📅 未来月份待摊 / 固定支出</h3>
        </div>
        <div class="chip-scroll">${monthChips}</div>
        <div class="mt-10">${plansHtml}</div>
      `;
      fCard.querySelectorAll('[data-del-plan]').forEach((btn) => {
        btn.onclick = async () => {
          const n = await store.deletePlanGroup(btn.getAttribute('data-del-plan'));
          showToast(`已删除整组 ${n} 期记录`);
          renderAll();
          runSync(true);
        };
      });
    }
  }

  // -------------------------------------------------------------------------
  // Quick Entry Sheet & Calculator Keypad
  // -------------------------------------------------------------------------

  function openEntryModal(editId = null) {
    state.entryEditingId = editId;
    const delBtn = $('btn-entry-delete');
    const delGroupBtn = $('btn-entry-delete-group');
    const editBar = $('entry-plan-edit-bar');
    const planPill = $('btn-entry-plan');

    if (editId) {
      const tx = store.snapshot.transactions.find((t) => t.id === editId);
      if (!tx) return;
      state.entryType = tx.type;
      state.entryCategory = tx.category;
      state.entryTags = [...(tx.tags || [])];
      state.entryReimbursable = Boolean(tx.reimbursable);
      state.entryReimburseStatus = tx.reimburse_status || 'none';
      state.entrySource = tx.source || 'manual';
      state.entryExternalRefs = [...(tx.external_refs || [])];
      state.entryPlanId = tx.plan_id || null;
      state.entryPlanMode = tx.plan_mode || null;
      state.entryPlanIndex = tx.plan_index || null;
      state.entryPlanTotal = tx.plan_total || null;
      state.entryPlanOriginAmount = tx.plan_origin_amount ?? null;
      state.planBoxOpen = false;
      state.planPeriods = 1;
      state.calcExpr = tx.amount > 0 ? String(tx.amount) : '';
      $('entry-time-input').value = tx.occurred_at.slice(0, 16);
      $('entry-note-input').value = tx.note || '';
      delBtn.classList.remove('hidden');
      planPill.classList.add('hidden');
      if (tx.plan_id) {
        delBtn.textContent = '删本期';
        delGroupBtn.classList.remove('hidden');
        editBar.classList.remove('hidden');
        $('entry-plan-edit-label').textContent =
          tx.plan_mode === 'repeat'
            ? `📅 ${tx.plan_total === 12 ? '全年' : '周期'} 第 ${tx.plan_index || 1}/${tx.plan_total || 1} 期`
            : `📅 分摊 第 ${tx.plan_index || 1}/${tx.plan_total || 1} 期`;
        $('chk-sync-plan-meta').checked = true;
      } else {
        delBtn.textContent = '删除';
        delGroupBtn.classList.add('hidden');
        editBar.classList.add('hidden');
      }
    } else {
      state.entryType = 'expense';
      state.entryCategory = StoreApi.CATEGORIES.expense[0].key;
      state.entryTags = [];
      state.entryReimbursable = false;
      state.entryReimburseStatus = 'none';
      state.entrySource = 'manual';
      state.entryExternalRefs = [];
      state.entryPlanId = null;
      state.entryPlanMode = null;
      state.entryPlanIndex = null;
      state.entryPlanTotal = null;
      state.entryPlanOriginAmount = null;
      state.planBoxOpen = false;
      state.planMode = 'split';
      state.planPeriods = 1;
      state.calcExpr = '';
      $('entry-time-input').value = StoreApi.formatLocalDateTime();
      $('entry-note-input').value = '';
      $('plan-custom-months').value = '';
      delBtn.classList.add('hidden');
      delBtn.textContent = '删除';
      delGroupBtn.classList.add('hidden');
      editBar.classList.add('hidden');
      planPill.classList.remove('hidden');
    }
    renderEntrySheet();
    $('entry-modal').classList.remove('hidden');
  }

  function updatePlanPreview() {
    const previewEl = $('plan-preview-text');
    if (!previewEl) return;
    if (state.entryEditingId || state.planPeriods <= 1) {
      previewEl.textContent = '当前为单笔入账（点上方 2月/4月/12月 开启分期或全年设置）';
      return;
    }
    const amt = evalCalcExpression(state.calcExpr);
    const startTime = $('entry-time-input').value || StoreApi.formatLocalDateTime();
    const startMonth = startTime.slice(0, 7);
    const endMonth = StoreApi.addMonthsClamped(startTime, state.planPeriods - 1).slice(0, 7);
    if (amt <= 0) {
      previewEl.textContent =
        state.planMode === 'split'
          ? `${startMonth} ~ ${endMonth}（共 ${state.planPeriods} 期）：输入总金额后自动平摊`
          : `${startMonth} ~ ${endMonth}（共 ${state.planPeriods} 期）：输入单月金额后一键生成`;
      return;
    }
    if (state.planMode === 'split') {
      const slices = StoreApi.splitAmountExact(amt, state.planPeriods);
      previewEl.textContent = `${startMonth} ~ ${endMonth}（共 ${state.planPeriods} 期）：每月约 ${fmtMoney(slices[0])}（总额 ${fmtMoney(amt)}）`;
    } else {
      previewEl.textContent = `${startMonth} ~ ${endMonth}（共 ${state.planPeriods} 期）：每月 ${fmtMoney(amt)}（合计 ${fmtMoney(amt * state.planPeriods)}）`;
    }
  }

  function renderEntrySheet() {
    $('entry-type-ctrl')
      .querySelectorAll('.seg-btn')
      .forEach((btn) => {
        btn.classList.toggle(
          'active',
          btn.getAttribute('data-type') === state.entryType
        );
      });

    const cats = StoreApi.CATEGORIES[state.entryType] || StoreApi.CATEGORIES.expense;
    if (!cats.some((c) => c.key === state.entryCategory)) {
      state.entryCategory = cats[0].key;
    }

    $('entry-cat-grid').innerHTML = cats
      .map(
        (c) => `
      <button type="button" class="cat-btn ${c.key === state.entryCategory ? 'active' : ''}" data-cat="${esc(c.key)}">
        <span class="c-ico">${esc(c.icon)}</span>
        <span class="c-txt">${esc(c.label)}</span>
      </button>`
      )
      .join('');

    $('entry-cat-grid')
      .querySelectorAll('.cat-btn')
      .forEach((btn) => {
        btn.onclick = () => {
          state.entryCategory = btn.getAttribute('data-cat');
          renderEntrySheet();
        };
      });

    // Tags chips
    const allTags = Array.from(
      new Set([...store.getActiveTags(), ...state.entryTags])
    );
    $('entry-tag-chips').innerHTML =
      allTags
        .map(
          (tg) =>
            `<button type="button" class="chip ${state.entryTags.includes(tg) ? 'active' : ''}" data-entry-tag="${esc(tg)}">#${esc(tg)}</button>`
        )
        .join('') +
      '<button type="button" class="chip" id="btn-entry-new-tag">+ 新标签</button>';

    $('entry-tag-chips')
      .querySelectorAll('[data-entry-tag]')
      .forEach((btn) => {
        btn.onclick = () => {
          const tg = btn.getAttribute('data-entry-tag');
          if (state.entryTags.includes(tg)) {
            state.entryTags = state.entryTags.filter((x) => x !== tg);
          } else {
            state.entryTags.push(tg);
          }
          renderEntrySheet();
        };
      });

    $('btn-entry-new-tag').onclick = () => {
      const box = $('entry-new-tag-box');
      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) {
        $('entry-new-tag-input').value = '';
        $('entry-new-tag-input').focus();
      }
    };

    const reimbBtn = $('btn-entry-reimb');
    reimbBtn.classList.toggle('active', state.entryReimbursable);
    if (!state.entryReimbursable) {
      $('reimb-pill-label').textContent = '报销(不入账)';
    } else if (state.entryReimburseStatus === 'done') {
      $('reimb-pill-label').textContent = '✓ 已报销(不入账)';
    } else {
      $('reimb-pill-label').textContent = '✓ 待报销(不入账)';
    }

    const planBtn = $('btn-entry-plan');
    const planBox = $('entry-plan-box');
    const isPlanActive = !state.entryEditingId && state.planPeriods > 1;
    planBtn.classList.toggle('plan-active', isPlanActive || state.planBoxOpen);
    if (!isPlanActive) {
      $('plan-pill-label').textContent = '分期/全年';
    } else if (state.planMode === 'split') {
      $('plan-pill-label').textContent = `平摊${state.planPeriods}月`;
    } else if (state.planPeriods === 12) {
      $('plan-pill-label').textContent = '全年12月';
    } else {
      $('plan-pill-label').textContent = `定额${state.planPeriods}月`;
    }

    planBox.classList.toggle(
      'hidden',
      Boolean(state.entryEditingId) || !state.planBoxOpen
    );

    $('plan-mode-ctrl')
      .querySelectorAll('.seg-btn')
      .forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-pmode') === state.planMode);
      });
    $('plan-period-chips')
      .querySelectorAll('.chip')
      .forEach((c) => {
        c.classList.toggle(
          'active',
          Number(c.getAttribute('data-periods')) === state.planPeriods
        );
      });

    updateCalcDisplay();
  }

  function updateCalcDisplay() {
    const val = evalCalcExpression(state.calcExpr);
    $('calc-expr').textContent = /[+-]/.test(state.calcExpr)
      ? state.calcExpr
      : '';
    $('calc-display').textContent = fmtMoney(val);
    updatePlanPreview();
  }

  async function handleKeypadPress(key) {
    if (key === 'del') {
      state.calcExpr = state.calcExpr.slice(0, -1);
      updateCalcDisplay();
      return;
    }
    if (key === '=') {
      const res = evalCalcExpression(state.calcExpr);
      state.calcExpr = res > 0 ? String(res) : '';
      updateCalcDisplay();
      return;
    }
    if (key === 'done') {
      const amount = evalCalcExpression(state.calcExpr);
      if (amount <= 0) {
        showToast('请输入金额');
        return;
      }
      const occurredAt =
        $('entry-time-input').value || StoreApi.formatLocalDateTime();
      const note = $('entry-note-input').value.trim();
      const excludeFromStats =
        state.entryType === 'transfer' || state.entryReimbursable;
      const reimbStatus = state.entryReimbursable
        ? state.entryReimburseStatus === 'done'
          ? 'done'
          : 'pending'
        : 'none';

      if (!state.entryEditingId && state.planPeriods > 1) {
        await store.createPlanTransactions(
          {
            type: state.entryType,
            category: state.entryCategory,
            tags: state.entryTags,
            occurred_at: occurredAt,
            note,
            reimbursable: state.entryReimbursable,
            reimburse_status: reimbStatus,
            exclude_from_stats: excludeFromStats,
            source: state.entrySource,
            external_refs: state.entryExternalRefs,
          },
          {
            mode: state.planMode,
            periods: state.planPeriods,
            inputAmount: amount,
          }
        );
        $('entry-modal').classList.add('hidden');
        state.monthKey = occurredAt.slice(0, 7);
        renderAll();
        showToast(
          state.planMode === 'split'
            ? `已按 ${state.planPeriods} 个月平摊入账`
            : `已一键生成 ${state.planPeriods} 期固定账目`
        );
        runSync(true);
        return;
      }

      await store.upsertTransaction({
        id: state.entryEditingId || undefined,
        type: state.entryType,
        amount,
        category: state.entryCategory,
        tags: state.entryTags,
        occurred_at: occurredAt,
        note,
        reimbursable: state.entryReimbursable,
        reimburse_status: reimbStatus,
        exclude_from_stats: excludeFromStats,
        source: state.entrySource,
        external_refs: state.entryExternalRefs,
        plan_id: state.entryPlanId,
        plan_mode: state.entryPlanMode,
        plan_index: state.entryPlanIndex,
        plan_total: state.entryPlanTotal,
        plan_origin_amount: state.entryPlanOriginAmount,
      });

      if (
        state.entryEditingId &&
        state.entryPlanId &&
        $('chk-sync-plan-meta') &&
        $('chk-sync-plan-meta').checked
      ) {
        await store.updatePlanGroupMetadata(state.entryPlanId, {
          category: state.entryCategory,
          tags: state.entryTags,
          note,
          reimbursable: state.entryReimbursable,
          reimburse_status: reimbStatus,
          exclude_from_stats: excludeFromStats,
        });
      }

      $('entry-modal').classList.add('hidden');
      state.monthKey = occurredAt.slice(0, 7);
      renderAll();
      showToast(state.entryEditingId ? '已更新记录' : '已记一笔');
      runSync(true);
      return;
    }

    if (key === '+' || key === '-') {
      if (!state.calcExpr) return;
      if (/[+-]$/.test(state.calcExpr)) {
        state.calcExpr = state.calcExpr.slice(0, -1) + key;
      } else {
        state.calcExpr += key;
      }
      updateCalcDisplay();
      return;
    }

    if (key === '.') {
      const lastNum = state.calcExpr.split(/[+-]/).pop() || '';
      if (lastNum.includes('.')) return;
      state.calcExpr += lastNum === '' ? '0.' : '.';
      updateCalcDisplay();
      return;
    }

    // Digit 0-9 (limit 2 decimal places)
    const lastNum = state.calcExpr.split(/[+-]/).pop() || '';
    if (lastNum.includes('.') && lastNum.split('.')[1].length >= 2) return;
    if (lastNum === '0' && key === '0') return;
    state.calcExpr += key;
    updateCalcDisplay();
  }

  // -------------------------------------------------------------------------
  // Budget Modal
  // -------------------------------------------------------------------------

  function openBudgetModal() {
    const cur =
      store.snapshot.budgets[state.monthKey] ||
      store.snapshot.budgets.default || { total: 0, categories: {} };
    const cats = StoreApi.CATEGORIES.expense.slice(0, 8);
    $('budget-modal-title').textContent = `${formatMonthLabel(state.monthKey)} 预算设置`;
    $('budget-form-body').innerHTML = `
      <label class="muted-sm">本月总预算 (元)</label>
      <input type="number" step="100" id="input-budget-total" class="compact-input" value="${cur.total || ''}" placeholder="例如：8000" />
      <label class="muted-sm mt-10" style="display:block">分类上限（可选，留空表示不限）</label>
      <div class="export-grid mt-10">
        ${cats
          .map(
            (c) => `
          <div>
            <span class="muted-sm">${esc(c.icon)} ${esc(c.label)}</span>
            <input type="number" step="50" class="compact-input budget-cat-input" data-bcat="${esc(c.key)}" value="${(cur.categories && cur.categories[c.key]) || ''}" placeholder="不限" />
          </div>`
          )
          .join('')}
      </div>
      <label class="meta-pill mt-10">
        <input type="checkbox" id="chk-budget-default" checked /> 同时设为每月默认预算
      </label>
      <div class="btn-row">
        <button type="button" class="btn btn-primary btn-block" id="btn-save-budget">保存预算</button>
      </div>
    `;
    $('btn-save-budget').onclick = async () => {
      const total = Number($('input-budget-total').value) || 0;
      const catMap = {};
      $('budget-form-body')
        .querySelectorAll('.budget-cat-input')
        .forEach((inp) => {
          const v = Number(inp.value);
          if (v > 0) catMap[inp.getAttribute('data-bcat')] = v;
        });
      await store.setBudget(state.monthKey, total, catMap);
      if ($('chk-budget-default').checked) {
        await store.setBudget('default', total, catMap);
      }
      $('budget-modal').classList.add('hidden');
      renderAll();
      showToast('预算已更新');
      runSync(true);
    };
    $('budget-modal').classList.remove('hidden');
  }

  // -------------------------------------------------------------------------
  // 3-Way Statement Reconciliation
  // -------------------------------------------------------------------------

  async function processStatementObjects(fileObjects) {
    for (const f of fileObjects) {
      try {
        const res = await ReconApi.parseStatementFile(f);
        state.uploadedFiles.push({
          name: res.fileName,
          kind: res.needsMapping ? '待映射' : res.kind,
          count: res.items ? res.items.length : 0,
        });
        if (res.needsMapping) {
          state.pendingMappingFiles.push(res);
        } else {
          state.rawBillItems.push(...res.items);
        }
      } catch (err) {
        showToast(`${f.name}: ${err.message || '解析失败'}`);
      }
    }
    recomputeReconcile();
  }

  function recomputeReconcile() {
    if (state.rawBillItems.length > 0) {
      state.reconResult = ReconApi.reconcileBills(
          state.rawBillItems,
          store.snapshot.transactions
      );
    } else {
      state.reconResult = null;
    }
    renderReconcile();
  }

  function renderReconcile() {
    const fileChips = $('uploaded-files-chips');
    const clearBtn = $('btn-clear-bills');
    if (state.uploadedFiles.length > 0) {
      clearBtn.classList.remove('hidden');
      const kindMap = {
        wechat: '微信',
        alipay: '支付宝',
        credit_card: '信用卡',
      };
      fileChips.innerHTML = state.uploadedFiles
        .map(
          (f) =>
            `<span class="chip active">${esc(kindMap[f.kind] || f.kind)} · ${esc(f.name)} (${f.count})</span>`
        )
        .join('');
    } else {
      clearBtn.classList.add('hidden');
      fileChips.innerHTML = '';
    }

    // Manual Column Mapper (for unrecognized bank CSV/TXT)
    const mapCard = $('manual-map-card');
    if (state.pendingMappingFiles.length > 0) {
      const mf = state.pendingMappingFiles[0];
      const maxCols = Math.max(...mf.preview.map((r) => r.length));
      const sampleRow = mf.preview[0] || [];
      const colOpts = Array.from({ length: maxCols }, (_, i) => {
        const label = `第${i + 1}列 (${String(sampleRow[i] || '').slice(0, 14)})`;
        return `<option value="${i}">${esc(label)}</option>`;
      }).join('');
      mapCard.classList.remove('hidden');
      mapCard.innerHTML = `
        <div class="card-head">
          <h3>手动指定列：${esc(mf.fileName)}</h3>
        </div>
        <div class="export-grid">
          <div><span class="muted-sm">日期列</span><select id="map-date" class="compact-input">${colOpts}</select></div>
          <div><span class="muted-sm">金额列</span><select id="map-amt" class="compact-input">${colOpts}</select></div>
          <div><span class="muted-sm">商户/摘要列</span><select id="map-merc" class="compact-input">${colOpts}</select></div>
          <div><span class="muted-sm">收支方向列(可选)</span><select id="map-flag" class="compact-input"><option value="-1">无</option>${colOpts}</select></div>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-primary btn-sm" id="btn-apply-manual-map">解析此账单</button>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-skip-manual-map">跳过</button>
        </div>
      `;
      $('btn-apply-manual-map').onclick = () => {
        const items =
          ReconApi.parseCreditCardRows(mf.rows, 0, mf.rows[0] || [], mf.fileName, {
            date: Number($('map-date').value),
            amount: Number($('map-amt').value),
            merchant: Number($('map-merc').value),
            flag: Number($('map-flag').value),
          }) || [];
        state.rawBillItems.push(...items);
        state.pendingMappingFiles.shift();
        const uf = state.uploadedFiles.find((u) => u.name === mf.fileName);
        if (uf) {
          uf.kind = 'credit_card';
          uf.count = items.length;
        }
        recomputeReconcile();
      };
      $('btn-skip-manual-map').onclick = () => {
        state.pendingMappingFiles.shift();
        renderReconcile();
      };
    } else {
      mapCard.classList.add('hidden');
    }

    const resArea = $('reconcile-result-area');
    if (!state.reconResult) {
      resArea.classList.add('hidden');
      return;
    }
    resArea.classList.remove('hidden');

    const r = state.reconResult;
    $('recon-summary').textContent = `跨渠道合并去重 ${r.crossMergedPairs} 笔 · 漏记待补 ${r.missingCount} 笔 · 已匹配 ${r.fuzzyCount + r.exactCount} 笔`;

    const filters = [
      { key: 'missing', label: `🔴 待补录 (${r.rows.filter((x) => x.reconStatus === 'missing').length})` },
      { key: 'merged', label: `🔗 跨单合并 (${r.mergedCrossCount})` },
      { key: 'fuzzy', label: `🟡 已手记 (${r.fuzzyCount})` },
      { key: 'exact', label: `✅ 已导入 (${r.exactCount})` },
      { key: 'ledger_only', label: `⚪ 仅手记 (${r.ledgerOnly.length})` },
    ];
    $('recon-filter-pills').innerHTML = filters
      .map(
        (f) =>
          `<button type="button" class="chip ${state.reconFilter === f.key ? 'active' : ''}" data-rf="${f.key}">${esc(f.label)}</button>`
      )
      .join('');
    $('recon-filter-pills')
      .querySelectorAll('[data-rf]')
      .forEach((btn) => {
        btn.onclick = () => {
          state.reconFilter = btn.getAttribute('data-rf');
          renderReconcile();
        };
      });

    const listEl = $('recon-list');
    if (state.reconFilter === 'ledger_only') {
      $('sticky-import-bar').classList.add('hidden');
      if (r.ledgerOnly.length === 0) {
        listEl.innerHTML = '<div class="empty-box">该时段无孤立手记记录</div>';
      } else {
        listEl.innerHTML = r.ledgerOnly
          .map((tx) => {
            const cat = StoreApi.CATEGORY_MAP[tx.category] || {
              icon: '📦',
              label: tx.category,
            };
            return `
            <div class="recon-row">
              <div class="recon-row-top">
                <div class="tx-ico">${esc(cat.icon)}</div>
                <div class="tx-main">
                  <div class="tx-title-line">${esc(cat.label)} ${esc(tx.note || '')}</div>
                  <div class="tx-sub-line">${esc(tx.occurred_at.replace('T', ' '))} · 仅本机手记</div>
                </div>
                <div class="tx-amt">${fmtMoney(tx.amount)}</div>
              </div>
            </div>`;
          })
          .join('');
      }
      return;
    }

    const rowsToShow = r.rows.filter((row) => {
      if (state.reconFilter === 'missing') return row.reconStatus === 'missing';
      if (state.reconFilter === 'merged') return row.source === 'merged_bill';
      if (state.reconFilter === 'fuzzy') return row.reconStatus === 'matched_fuzzy';
      if (state.reconFilter === 'exact') return row.reconStatus === 'matched_exact';
      return true;
    });

    if (rowsToShow.length === 0) {
      listEl.innerHTML = '<div class="empty-box">此分类下暂无条目</div>';
    } else {
      const srcBadge = (row) => {
        if (row.source === 'merged_bill') {
          const first = row.mergedFrom[0] === 'wechat' ? '微信' : '支付宝';
          return `<span class="status-badge done">🔗 ${first}+信用卡已合并</span>`;
        }
        if (row.source === 'wechat') return '<span class="tag-badge">微信</span>';
        if (row.source === 'alipay') return '<span class="tag-badge">支付宝</span>';
        return '<span class="tag-badge">信用卡</span>';
      };

      listEl.innerHTML = rowsToShow
        .map((row) => {
          const catGroup =
            StoreApi.CATEGORIES[row.type] || StoreApi.CATEGORIES.expense;
          const catOpts = catGroup
            .map(
              (c) =>
                `<option value="${esc(c.key)}" ${c.key === row.category ? 'selected' : ''}>${esc(c.icon)} ${esc(c.label)}</option>`
            )
            .join('');
          const disabled = row.reconStatus === 'matched_exact' ? 'disabled' : '';
          const fuzzyLabel = row.matchedSplitOrigin
            ? `🔗 关联分摊首期 (总${fmtMoney(row.matchedTx.plan_origin_amount)})`
            : `🔗 关联至手记 (${fmtMoney(row.matchedTx?.amount || 0)})`;
          const fuzzyBtn =
            row.reconStatus === 'matched_fuzzy' && row.matchedTx
              ? `<button type="button" class="btn btn-ghost btn-sm" data-link-id="${esc(row.bill_id)}">${esc(fuzzyLabel)}</button>`
              : '';
          const splitOpts =
            row.type === 'expense' && !row.is_repayment && row.reconStatus !== 'matched_exact'
              ? `<select class="recon-select" data-split-id="${esc(row.bill_id)}">
                  ${[1, 2, 3, 4, 6, 12]
                    .map(
                      (n) =>
                        `<option value="${n}" ${(row.splitPeriods || 1) === n ? 'selected' : ''}>${n === 1 ? '不分期' : `平摊${n}月`}</option>`
                    )
                    .join('')}
                </select>`
              : '';
          const repayHint = row.is_repayment
            ? '<span class="status-badge excluded">还款/不入账</span>'
            : '';

          return `
          <div class="recon-row" data-bill-id="${esc(row.bill_id)}">
            <div class="recon-row-top">
              <input type="checkbox" class="recon-chk" data-chk-id="${esc(row.bill_id)}" ${row.selected ? 'checked' : ''} ${disabled} />
              <div class="tx-main">
                <div class="tx-title-line">
                  <span>${esc(row.merchant)}</span>
                  ${row.product ? `<span class="tx-note">${esc(row.product)}</span>` : ''}
                </div>
                <div class="tx-sub-line">
                  <span>${esc(row.occurred_at.replace('T', ' '))}</span>
                  ${srcBadge(row)}
                  ${repayHint}
                </div>
              </div>
              <div class="tx-amt ${esc(row.type)}">${row.type === 'income' ? '+' : '-'}${fmtMoney(row.amount)}</div>
            </div>
            <div class="recon-controls">
              <select class="recon-select" data-cat-id="${esc(row.bill_id)}" ${disabled}>${catOpts}</select>
              ${splitOpts}
              <button type="button" class="chip reimb ${row.reimbursable ? 'active' : ''}" data-reimb-id="${esc(row.bill_id)}" ${disabled}>
                ${row.reimbursable ? '✓ 报销不入账' : '🧾 设为报销'}
              </button>
              ${fuzzyBtn}
            </div>
          </div>`;
        })
        .join('');

      listEl.querySelectorAll('[data-chk-id]').forEach((chk) => {
        chk.onchange = () => {
          const item = r.rows.find(
            (x) => x.bill_id === chk.getAttribute('data-chk-id')
          );
          if (item) {
            item.selected = chk.checked;
            updateImportStickyBar();
          }
        };
      });
      listEl.querySelectorAll('[data-cat-id]').forEach((sel) => {
        sel.onchange = () => {
          const item = r.rows.find(
            (x) => x.bill_id === sel.getAttribute('data-cat-id')
          );
          if (item) item.category = sel.value;
        };
      });
      listEl.querySelectorAll('[data-split-id]').forEach((sel) => {
        sel.onchange = () => {
          const item = r.rows.find(
            (x) => x.bill_id === sel.getAttribute('data-split-id')
          );
          if (item) item.splitPeriods = Number(sel.value) || 1;
        };
      });
      listEl.querySelectorAll('[data-reimb-id]').forEach((btn) => {
        btn.onclick = () => {
          const item = r.rows.find(
            (x) => x.bill_id === btn.getAttribute('data-reimb-id')
          );
          if (item) {
            item.reimbursable = !item.reimbursable;
            item.exclude_from_stats = item.reimbursable || item.type === 'transfer';
            renderReconcile();
          }
        };
      });
      listEl.querySelectorAll('[data-link-id]').forEach((btn) => {
        btn.onclick = async () => {
          const item = r.rows.find(
            (x) => x.bill_id === btn.getAttribute('data-link-id')
          );
          if (item && item.matchedTx) {
            await store.linkExternalRefs(item.matchedTx.id, item.external_refs);
            showToast('已关联现有手记，不会重复记账');
            recomputeReconcile();
            runSync(true);
          }
        };
      });
    }
    updateImportStickyBar();
  }

  function updateImportStickyBar() {
    const bar = $('sticky-import-bar');
    if (!state.reconResult) {
      bar.classList.add('hidden');
      return;
    }
    const chosen = state.reconResult.rows.filter(
      (r) => r.selected && r.reconStatus !== 'matched_exact'
    );
    if (chosen.length === 0) {
      bar.classList.add('hidden');
      return;
    }
    const total = chosen.reduce((s, r) => s + r.amount, 0);
    bar.classList.remove('hidden');
    $('btn-import-selected').textContent = `一键补录选中 (${chosen.length}笔 · ${fmtMoney(total)})`;
  }

  // -------------------------------------------------------------------------
  // Settings, iOS Install Prompt, Sidecar Provisioning & Export
  // -------------------------------------------------------------------------

  function renderSettings() {
    // 1. PWA Install Prompt Card (mandatory when !isStandalone && !isSidecar)
    const pwaCard = $('pwa-install-card');
    if (state.isSidecar || state.isStandalone) {
      pwaCard.classList.add('hidden');
    } else if (state.deferredInstallPrompt) {
      pwaCard.classList.remove('hidden');
      pwaCard.innerHTML = `
        <div class="card-head"><h3>📲 安装到桌面</h3></div>
        <p class="muted-sm">安装后像原生 App 一样全屏运行，断网也能记账查账。</p>
        <button type="button" class="btn btn-primary btn-block mt-10" id="btn-pwa-install">安装轻账 App</button>
      `;
      $('btn-pwa-install').onclick = async () => {
        await state.deferredInstallPrompt.prompt();
        state.deferredInstallPrompt = null;
        renderSettings();
      };
    } else if (state.isIOS) {
      pwaCard.classList.remove('hidden');
      pwaCard.innerHTML = `
        <div class="card-head"><h3>📲 添加到 iPhone 主屏幕</h3></div>
        <p class="muted-sm">在 Safari 底部点 <strong>分享 [↑] → 添加到主屏幕</strong>，即可生成独立桌面图标并永久离线保存。</p>
        <button type="button" class="btn btn-primary btn-block mt-10" id="btn-open-ios-guide">查看安装与配对步骤</button>
      `;
      $('btn-open-ios-guide').onclick = () => {
        if (state.pendingPairCode) {
          $('btn-modal-copy-pair').classList.remove('hidden');
        }
        $('ios-guide-modal').classList.remove('hidden');
      };
    } else {
      pwaCard.classList.add('hidden');
    }

    // 2. Jetski Sidecar Hub Card (visible inside Jetski AuxPane/Sidebar)
    const scCard = $('sidecar-hub-card');
    if (!state.isSidecar) {
      scCard.classList.add('hidden');
    } else {
      scCard.classList.remove('hidden');
      const info = state.sidecarSyncInfo || {};
      const qrBlock = info.qr_svg
        ? `
        <div class="qr-box">
          ${info.qr_svg}
          <div class="muted-sm">用 iPhone 相机扫码打开，再「添加到主屏幕」</div>
          <div class="btn-row">
            <button type="button" class="btn btn-primary btn-sm" id="btn-copy-sc-pair">📋 复制配对码 (QZ1)</button>
            ${info.pages_url ? `<a class="btn btn-ghost btn-sm" href="${esc(info.pages_url)}" target="_blank" rel="noopener">打开网址</a>` : ''}
          </div>
        </div>`
        : '';

      scCard.innerHTML = `
        <div class="card-head">
          <h3>🤖 Jetski 账本同步中心</h3>
          <span class="badge ${info.configured ? 'ok' : ''}">${info.configured ? '云通道已开启' : '待部署'}</span>
        </div>
        <p class="muted-sm">iPhone 不连公司内网也能通过 GitHub Pages + 端到端加密 Gist 同步回 Jetski。</p>
        ${qrBlock}
        <div class="btn-row">
          <button type="button" class="btn btn-primary btn-sm" id="btn-ask-jetski-analyze">💬 让 Jetski 分析本月账本</button>
          <a class="btn btn-ghost btn-sm" href="./pwa_dist.zip" download="qingzhang-pwa.zip">📦 下载 PWA 静态包</a>
        </div>
        <details class="mt-10">
          <summary class="muted-sm" style="cursor:pointer;font-weight:600">🚀 一键发布到 GitHub Pages 并生成二维码</summary>
          <div class="mt-10">
            <input type="password" id="gh-token-input" class="compact-input" placeholder="GitHub Token (需 repo + gist 权限)" />
            <input type="text" id="gh-repo-input" class="compact-input mt-10" value="${esc(info.repo_name || 'qingzhang-ledger')}" placeholder="GitHub 仓库名（如 qingzhang-ledger）" />
            <button type="button" class="btn btn-primary btn-block mt-10" id="btn-gh-provision">一键部署 & 生成 iPhone 二维码</button>
          </div>
        </details>
        <details class="mt-10">
          <summary class="muted-sm" style="cursor:pointer">备选：用个人 Gmail Apps Script 当云端中转（无需 GitHub Gist）</summary>
          <pre class="code-block mt-10">${esc(APPS_SCRIPT_SNIPPET)}</pre>
        </details>
      `;

      if ($('btn-copy-sc-pair')) {
        $('btn-copy-sc-pair').onclick = () =>
          copyText(info.pairing_code || '', '配对码已复制');
      }
      $('btn-ask-jetski-analyze').onclick = async () => {
        const stats = StoreApi.computeMonthStats(store.snapshot, state.monthKey);
        const promptMsg = `请结合我的轻账记录分析 ${state.monthKey} 收支情况：本月个人支出 ${fmtMoney(stats.personalExpense)}，收入 ${fmtMoney(stats.personalIncome)}，预算 ${fmtMoney(stats.totalBudget)}，待报销 ${stats.pendingReimbursements.length} 笔（${fmtMoney(stats.pendingTotal)}）。请用简洁要点总结消费结构与可优化项。`;
        try {
          if (window.sidecar?.agent?.sendMessage) {
            await window.sidecar.agent.sendMessage(promptMsg);
            showToast('已发送到当前 Jetski 对话');
          } else {
            await copyText(promptMsg, '已复制分析指令');
          }
        } catch (err) {
          showToast('发送失败: ' + (err.message || ''));
        }
      };
      $('btn-gh-provision').onclick = async () => {
        const token = $('gh-token-input').value.trim();
        const repo_name = $('gh-repo-input').value.trim() || 'qingzhang-ledger';
        if (!token) {
          showToast('请先输入 GitHub Token');
          return;
        }
        $('btn-gh-provision').disabled = true;
        $('btn-gh-provision').textContent = '正在部署 GitHub Pages...';
        try {
          const res = await window.sidecar.fetch('/api/github/provision', {
            method: 'POST',
            body: JSON.stringify({ token, repo_name }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '部署失败');
          state.sidecarSyncInfo = data.sync;
          showToast('部署成功！请等待约 30 秒 GitHub Pages 生效后扫码');
          renderSettings();
        } catch (err) {
          showToast(err.message || '部署失败');
        } finally {
          if ($('btn-gh-provision')) {
            $('btn-gh-provision').disabled = false;
            $('btn-gh-provision').textContent = '一键部署 & 生成 iPhone 二维码';
          }
        }
      };
    }

    // 3. Sync Status Card
    const cfg = store.meta.sync_config;
    const badge = $('sync-mode-badge');
    const detail = $('sync-detail-text');
    if (state.isSidecar) {
      badge.textContent = 'Sidecar 直连';
      badge.className = 'badge ok';
      detail.textContent =
        state.sidecarSyncInfo && state.sidecarSyncInfo.last_sync_at
          ? `最近云端同步：${state.sidecarSyncInfo.last_sync_at}`
          : '自动每 30 秒与云端加密账本同步';
    } else if (cfg && cfg.sync_key) {
      badge.textContent = cfg.mode === 'gist' ? 'Gist 端到端加密' : 'Relay 加密';
      badge.className = 'badge ok';
      detail.textContent = store.meta.last_sync_at
        ? `上次同步：${store.meta.last_sync_at}（AES-256-GCM 加密）`
        : '已配对 Jetski，点击立即同步即可双向合并。';
    } else {
      badge.textContent = '离线本机';
      badge.className = 'badge';
      detail.textContent = '所有记录离线存于本机；配对后可同步回 Cloudtop Jetski。';
    }

    // 4. Ledger Count & Tags
    const activeCount = store.snapshot.transactions.filter(
      (t) => t.deleted_at === null || t.deleted_at === undefined
    ).length;
    $('ledger-count-label').textContent = `共 ${activeCount} 条有效记录`;
    $('settings-tags-list').innerHTML = store
      .getActiveTags()
      .map((tg) => `<span class="chip">#${esc(tg)}</span>`)
      .join('');
  }

  async function exportFile(filename, mimeType, contentStr) {
    const blob = new Blob([contentStr], { type: mimeType });
    if (
      state.isIOS &&
      navigator.canShare &&
      typeof File !== 'undefined'
    ) {
      try {
        const file = new File([blob], filename, { type: mimeType });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已导出 ' + filename);
  }

  // -------------------------------------------------------------------------
  // Event Wiring
  // -------------------------------------------------------------------------

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.nav-item').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('.tab-view').forEach((sec) => {
      sec.classList.toggle('hidden', sec.id !== 'view-' + tabName);
    });
    renderAll();
  }

  function wireEvents() {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.onclick = () => switchTab(btn.getAttribute('data-tab'));
    });

    $('btn-top-settings').onclick = () => switchTab('settings');

    $('btn-prev-month').onclick = () => {
      state.monthKey = shiftMonth(state.monthKey, -1);
      renderAll();
    };
    $('btn-next-month').onclick = () => {
      state.monthKey = shiftMonth(state.monthKey, 1);
      renderAll();
    };
    $('btn-budget-shortcut').onclick = openBudgetModal;
    $('btn-sync-pill').onclick = () => {
      const cfg = store.meta.sync_config;
      if (!state.isSidecar && (!cfg || !cfg.sync_key)) {
        switchTab('settings');
        showToast('请粘贴配对码连通云端');
        return;
      }
      runSync(false);
    };

    $('ledger-search').oninput = (e) => {
      state.filterSearch = e.target.value;
      renderAll();
    };

    $('rank-mode-ctrl')
      .querySelectorAll('.seg-btn')
      .forEach((btn) => {
        btn.onclick = () => {
          state.rankMode = btn.getAttribute('data-rank');
          $('rank-mode-ctrl')
            .querySelectorAll('.seg-btn')
            .forEach((b) => b.classList.toggle('active', b === btn));
          renderAll();
        };
      });

    // Quick Entry Modal
    $('btn-open-add').onclick = () => openEntryModal(null);
    $('btn-close-entry').onclick = () => $('entry-modal').classList.add('hidden');
    $('entry-modal').onclick = (e) => {
      if (e.target === $('entry-modal')) $('entry-modal').classList.add('hidden');
    };
    $('entry-type-ctrl')
      .querySelectorAll('.seg-btn')
      .forEach((btn) => {
        btn.onclick = () => {
          state.entryType = btn.getAttribute('data-type');
          if (state.entryType === 'transfer') state.entryReimbursable = false;
          renderEntrySheet();
        };
      });
    $('btn-entry-reimb').onclick = () => {
      if (!state.entryReimbursable) {
        state.entryReimbursable = true;
        state.entryReimburseStatus = 'pending';
      } else if (state.entryEditingId && state.entryReimburseStatus === 'pending') {
        state.entryReimburseStatus = 'done';
      } else {
        state.entryReimbursable = false;
        state.entryReimburseStatus = 'none';
      }
      renderEntrySheet();
    };
    $('btn-entry-plan').onclick = () => {
      state.planBoxOpen = !state.planBoxOpen;
      if (state.planBoxOpen && state.planPeriods === 1) {
        if (state.entryCategory === 'home') {
          state.planMode = 'repeat';
          state.planPeriods = 12;
        } else {
          state.planMode = 'split';
          state.planPeriods = 4;
        }
      }
      renderEntrySheet();
    };
    $('plan-mode-ctrl')
      .querySelectorAll('.seg-btn')
      .forEach((btn) => {
        btn.onclick = () => {
          state.planMode = btn.getAttribute('data-pmode') === 'repeat' ? 'repeat' : 'split';
          if (state.planPeriods === 1) {
            state.planPeriods = state.planMode === 'repeat' ? 12 : 4;
          }
          renderEntrySheet();
        };
      });
    $('plan-period-chips')
      .querySelectorAll('.chip')
      .forEach((btn) => {
        btn.onclick = () => {
          const n = Number(btn.getAttribute('data-periods')) || 1;
          state.planPeriods = n;
          $('plan-custom-months').value = '';
          if (n === 1) state.planBoxOpen = false;
          renderEntrySheet();
        };
      });
    $('plan-custom-months').oninput = (e) => {
      const n = Math.min(60, Math.max(1, parseInt(e.target.value, 10) || 1));
      state.planPeriods = n;
      renderEntrySheet();
    };
    $('entry-time-input').onchange = () => updatePlanPreview();
    $('btn-entry-delete-group').onclick = async () => {
      if (!state.entryPlanId) return;
      const count = await store.deletePlanGroup(state.entryPlanId);
      $('entry-modal').classList.add('hidden');
      renderAll();
      showToast(`已删除整组 ${count} 期记录`);
      runSync(true);
    };
    $('btn-confirm-new-tag').onclick = async () => {
      const val = $('entry-new-tag-input').value.trim().replace(/^#+/, '').slice(0, 20);
      if (val) {
        await store.addTag(val);
        if (!state.entryTags.includes(val)) state.entryTags.push(val);
      }
      $('entry-new-tag-box').classList.add('hidden');
      renderEntrySheet();
    };
    $('entry-new-tag-box').classList.add('hidden');
    $('btn-entry-delete').onclick = async () => {
      if (!state.entryEditingId) return;
      await store.deleteTransaction(state.entryEditingId);
      $('entry-modal').classList.add('hidden');
      renderAll();
      showToast('已删除记录');
      runSync(true);
    };
    $('keypad-grid')
      .querySelectorAll('.kp-btn')
      .forEach((btn) => {
        btn.onclick = () => handleKeypadPress(btn.getAttribute('data-kp'));
      });

    // Budget & Guide Modals
    $('btn-close-budget').onclick = () => $('budget-modal').classList.add('hidden');
    $('btn-close-ios-guide').onclick = () => $('ios-guide-modal').classList.add('hidden');
    $('btn-dismiss-ios-guide').onclick = () => $('ios-guide-modal').classList.add('hidden');
    $('btn-modal-copy-pair').onclick = () =>
      copyText(state.pendingPairCode, '配对码已复制，请从主屏幕打开轻账后粘贴');

    // Reconcile Bench
    $('bill-file-input').onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length > 0) await processStatementObjects(files);
    };
    $('btn-demo-bills').onclick = async () => {
      await processStatementObjects(ReconApi.generateDemoStatements());
      showToast('已加载微信+支付宝+招行信用卡演示账单');
    };
    $('btn-clear-bills').onclick = () => {
      state.uploadedFiles = [];
      state.rawBillItems = [];
      state.pendingMappingFiles = [];
      state.reconResult = null;
      renderReconcile();
    };
    $('btn-import-selected').onclick = async () => {
      if (!state.reconResult) return;
      const chosen = state.reconResult.rows.filter(
        (r) => r.selected && r.reconStatus !== 'matched_exact'
      );
      if (chosen.length === 0) return;
      const expandedToImport = [];
      for (const c of chosen) {
        const base = {
          type: c.type,
          amount: c.amount,
          category: c.category,
          tags: [],
          occurred_at: c.occurred_at,
          note: c.product ? `${c.merchant} · ${c.product}` : c.merchant,
          reimbursable: c.reimbursable,
          reimburse_status: c.reimbursable ? 'pending' : 'none',
          exclude_from_stats: c.reimbursable || c.type === 'transfer',
          source: c.source,
          external_refs: c.external_refs,
        };
        const periods = Number(c.splitPeriods) || 1;
        if (periods > 1 && c.type === 'expense') {
          expandedToImport.push(
            ...StoreApi.buildPlanTransactions(base, {
              mode: 'split',
              periods,
              inputAmount: c.amount,
            })
          );
        } else {
          expandedToImport.push(base);
        }
      }
      await store.batchImportTransactions(expandedToImport);
      showToast(`已补录 ${chosen.length} 笔（共 ${expandedToImport.length} 条记录）`);
      recomputeReconcile();
      renderAll();
      runSync(true);
    };

    // Settings Pairing & Exports
    $('btn-paste-pair').onclick = async () => {
      $('pair-input-box').classList.remove('hidden');
      try {
        const txt = await navigator.clipboard.readText();
        if (txt && txt.includes('QZ1:')) {
          $('input-pair-code').value = txt.trim();
          await applyPairingString(txt.trim());
          return;
        }
      } catch (_) {}
      $('input-pair-code').focus();
    };
    $('btn-apply-pair').onclick = async () => {
      try {
        await applyPairingString($('input-pair-code').value);
      } catch (err) {
        showToast(err.message || '配对码无效');
      }
    };
    $('btn-sync-now').onclick = () => runSync(false);
    $('btn-edit-sync').onclick = () => {
      const box = $('manual-sync-form');
      if (!box.classList.contains('hidden')) {
        box.classList.add('hidden');
        return;
      }
      const cur = store.meta.sync_config || { mode: 'gist' };
      box.classList.remove('hidden');
      box.innerHTML = `
        <select id="man-mode" class="compact-input">
          <option value="gist" ${cur.mode === 'gist' ? 'selected' : ''}>GitHub Secret Gist</option>
          <option value="webhook" ${cur.mode === 'webhook' ? 'selected' : ''}>个人 Apps Script / Relay URL</option>
        </select>
        <input type="text" id="man-key" class="compact-input mt-10" value="${esc(cur.sync_key || '')}" placeholder="AES-256 同步密钥" />
        <input type="text" id="man-gist" class="compact-input mt-10" value="${esc(cur.gist_id || '')}" placeholder="Gist ID（Gist模式必填）" />
        <input type="password" id="man-token" class="compact-input mt-10" value="${esc(cur.token || '')}" placeholder="GitHub Token（Gist模式必填）" />
        <input type="url" id="man-relay" class="compact-input mt-10" value="${esc(cur.relay_url || '')}" placeholder="Relay HTTPS URL（Apps Script模式必填）" />
        <div class="btn-row">
          <button type="button" class="btn btn-primary btn-sm" id="btn-save-man-sync">保存配置</button>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-clear-sync">断开云同步</button>
        </div>
      `;
      $('btn-save-man-sync').onclick = async () => {
        const mode = $('man-mode').value;
        const cfg = {
          mode,
          sync_key: $('man-key').value.trim(),
          gist_id: $('man-gist').value.trim(),
          token: $('man-token').value.trim(),
          relay_url: $('man-relay').value.trim(),
        };
        await store.setMeta('sync_config', cfg);
        if (state.isSidecar) {
          await window.sidecar.fetch('/api/sync/config', {
            method: 'POST',
            body: JSON.stringify(cfg),
          });
        }
        box.classList.add('hidden');
        await runSync(false);
      };
      $('btn-clear-sync').onclick = async () => {
        await store.setMeta('sync_config', null);
        box.classList.add('hidden');
        renderAll();
        showToast('已断开本机云端配对');
      };
    };

    $('btn-export-month-csv').onclick = () => {
      const stats = StoreApi.computeMonthStats(store.snapshot, state.monthKey);
      exportFile(
        `qingzhang-${state.monthKey}.csv`,
        'text/csv;charset=utf-8',
        StoreApi.buildCsvString(stats.monthActive)
      );
    };
    $('btn-export-reimb-csv').onclick = () => {
      const pending = store.snapshot.transactions.filter(
        (t) => !t.deleted_at && t.reimbursable && t.reimburse_status === 'pending'
      );
      exportFile(
        'qingzhang-pending-reimbursements.csv',
        'text/csv;charset=utf-8',
        StoreApi.buildCsvString(pending)
      );
    };
    $('btn-export-all-csv').onclick = () => {
      exportFile(
        'qingzhang-all.csv',
        'text/csv;charset=utf-8',
        StoreApi.buildCsvString(store.snapshot.transactions)
      );
    };
    $('btn-export-json').onclick = () => {
      exportFile(
        `qingzhang-backup-${StoreApi.formatLocalDateTime().slice(0, 10)}.json`,
        'application/json;charset=utf-8',
        JSON.stringify(store.snapshot, null, 2)
      );
    };
    $('json-restore-input').onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        await store.replaceFromMerge(parsed);
        renderAll();
        showToast('JSON 备份已合并恢复');
        runSync(true);
      } catch (_) {
        showToast('JSON 备份格式无效');
      }
    };

    $('btn-add-setting-tag').onclick = async () => {
      const val = $('input-new-tag').value.trim();
      if (!val) return;
      await store.addTag(val);
      $('input-new-tag').value = '';
      renderSettings();
      runSync(true);
    };

    // PWA Install Events & Connectivity Listeners
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      renderSettings();
    });
    window.addEventListener('appinstalled', () => {
      state.isStandalone = true;
      state.deferredInstallPrompt = null;
      renderSettings();
    });
    window.addEventListener('online', () => {
      updateSyncPill();
      runSync(true);
    });
    window.addEventListener('offline', () => updateSyncPill());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') runSync(true);
    });
  }

  async function boot() {
    await store.init();
    if (!state.isSidecar && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    wireEvents();
    await handleIncomingHashPairing();
    await refreshSidecarMeta();
    renderAll();
    runSync(true);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
