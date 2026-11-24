(function (global) {
  'use strict';

  const DB_NAME = 'qingzhang_v1';
  const DB_VERSION = 1;
  const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 3600 * 1000;

  const CATEGORIES = {
    expense: [
      { key: 'food', label: '餐饮', icon: '🍜' },
      { key: 'transit', label: '交通', icon: '🚇' },
      { key: 'shop', label: '购物', icon: '🛍️' },
      { key: 'daily', label: '日用', icon: '🧴' },
      { key: 'sport', label: '运动', icon: '🏃' },
      { key: 'home', label: '住房', icon: '🏠' },
      { key: 'fun', label: '娱乐', icon: '🎮' },
      { key: 'med', label: '医疗', icon: '💊' },
      { key: 'travel', label: '旅行', icon: '✈️' },
      { key: 'digital', label: '数码', icon: '📱' },
      { key: 'social', label: '人情', icon: '🤝' },
      { key: 'other_exp', label: '其他', icon: '📦' },
    ],
    income: [
      { key: 'salary', label: '工资', icon: '💰' },
      { key: 'bonus', label: '奖金', icon: '🎁' },
      { key: 'invest', label: '理财', icon: '📈' },
      { key: 'reimb_in', label: '报销款', icon: '🧾' },
      { key: 'other_inc', label: '其他', icon: '✨' },
    ],
    transfer: [
      { key: 'repay', label: '还款', icon: '💳' },
      { key: 'reimb_adv', label: '垫付', icon: '🧾' },
      { key: 'internal', label: '转账', icon: '🔄' },
    ],
  };

  const LEGACY_CATEGORIES = [{ key: 'study', label: '学习', icon: '📚', group: 'expense' }];

  const CATEGORY_MAP = (() => {
    const m = {};
    for (const group of Object.keys(CATEGORIES)) {
      for (const item of CATEGORIES[group]) {
        m[item.key] = { ...item, group };
      }
    }
    for (const item of LEGACY_CATEGORIES) {
      if (!m[item.key]) m[item.key] = { ...item };
    }
    return m;
  })();

  const DEFAULT_TAGS = ['出差', '聚餐', '固定支出', '家人', '健身'];

  const DEFAULT_CATEGORY_SUBTAGS = {
    food: ['三餐', '咖啡奶茶', '聚餐', '外卖'],
    transit: ['打车', '地铁公交', '高铁机票', '加油停车'],
    shop: ['服饰鞋包', '网购', '美妆护肤', '礼物'],
    daily: ['杂货', '买菜生鲜', '洗护清洁', '话费网费'],
    sport: ['健身房', '补剂', '运动装备', '球类场地'],
    home: ['房租', '水电燃气', '物业宽带', '家居维修'],
    fun: ['电影演出', '游戏会员', '书影音', '休闲聚会'],
    med: ['挂号门诊', '买药', '体检牙科', '保健品'],
    travel: ['酒店住宿', '机票车票', '景点门票', '当地餐饮'],
    digital: ['硬件设备', '软件订阅', '配件', '云服务'],
    social: ['请客送礼', '红包礼金', '孝敬家人'],
    other_exp: ['学习培训', '出差', '杂项'],
    study: ['课程书籍', '考试认证'],
    salary: ['月薪', '补贴'],
    bonus: ['年终奖', '绩效奖'],
    invest: ['基金股票', '利息分红'],
    reimb_in: ['差旅报销', '日常报销'],
    other_inc: ['红包退款', '闲置转卖'],
    repay: ['信用卡还款', '花呗白条'],
    reimb_adv: ['差旅垫付', '招待垫付'],
    internal: ['卡间互转', '理财申赎'],
  };

  function parseScopedTagName(rawName) {
    const s = String(rawName || '').trim();
    const sepIdx = s.indexOf('::');
    if (sepIdx > 0) {
      return {
        category: s.slice(0, sepIdx).trim(),
        tag: s.slice(sepIdx + 2).trim().replace(/^#+/, '').slice(0, 24),
        scoped: true,
      };
    }
    return {
      category: '',
      tag: s.replace(/^#+/, '').slice(0, 24),
      scoped: false,
    };
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatLocalDateTime(dateObj) {
    const d = dateObj || new Date();
    return (
      d.getFullYear() +
      '-' +
      pad2(d.getMonth() + 1) +
      '-' +
      pad2(d.getDate()) +
      'T' +
      pad2(d.getHours()) +
      ':' +
      pad2(d.getMinutes())
    );
  }

  function currentMonthKey(dateObj) {
    const d = dateObj || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function generateId(prefix = 'tx') {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return prefix + '_' + global.crypto.randomUUID();
    }
    const rnd = Math.random().toString(16).slice(2, 10);
    return prefix + '_' + Date.now().toString(36) + '_' + rnd;
  }

  function normalizeTx(raw) {
    if (!raw || !raw.id) return null;
    const type = ['expense', 'income', 'transfer'].includes(raw.type)
      ? raw.type
      : 'expense';
    const num = Math.abs(Number(raw.amount) || 0);
    const amount = Math.round(num * 100) / 100;
    const tags = Array.isArray(raw.tags)
      ? Array.from(
          new Set(
            raw.tags
              .map((t) => String(t).trim().replace(/^#+/, ''))
              .filter(Boolean)
              .map((t) => t.slice(0, 24))
          )
        )
      : [];
    const externalRefs = Array.isArray(raw.external_refs)
      ? Array.from(
          new Set(raw.external_refs.map((r) => String(r).trim()).filter(Boolean))
        )
      : [];
    const reimbursable = Boolean(raw.reimbursable);
    let reimburseStatus = ['none', 'pending', 'done'].includes(raw.reimburse_status)
      ? raw.reimburse_status
      : reimbursable
      ? 'pending'
      : 'none';
    if (reimbursable && reimburseStatus === 'none') {
      reimburseStatus = 'pending';
    }
    const excludeFromStats =
      type === 'transfer' ? true : Boolean(raw.exclude_from_stats);

    const planId = raw.plan_id ? String(raw.plan_id).trim().slice(0, 96) : null;
    const planMode = ['split', 'repeat'].includes(raw.plan_mode)
      ? raw.plan_mode
      : null;
    const planIndex =
      raw.plan_index !== null && raw.plan_index !== undefined && Number(raw.plan_index) > 0
        ? Math.max(1, parseInt(raw.plan_index, 10))
        : null;
    const planTotal =
      raw.plan_total !== null && raw.plan_total !== undefined && Number(raw.plan_total) > 0
        ? Math.max(1, parseInt(raw.plan_total, 10))
        : null;
    const planOriginAmount =
      raw.plan_origin_amount !== null &&
      raw.plan_origin_amount !== undefined &&
      Number.isFinite(Number(raw.plan_origin_amount))
        ? Math.round(Math.abs(Number(raw.plan_origin_amount)) * 100) / 100
        : null;

    return {
      id: String(raw.id).slice(0, 96),
      type,
      amount,
      category:
        String(raw.category || (type === 'income' ? 'salary' : type === 'transfer' ? 'internal' : 'other_exp')).slice(0, 32),
      tags,
      occurred_at: String(raw.occurred_at || formatLocalDateTime()).slice(0, 19),
      note: String(raw.note || '').slice(0, 160),
      reimbursable,
      reimburse_status: reimburseStatus,
      exclude_from_stats: excludeFromStats,
      source: String(raw.source || 'manual').slice(0, 32),
      external_refs: externalRefs,
      plan_id: planId,
      plan_mode: planMode,
      plan_index: planIndex,
      plan_total: planTotal,
      plan_origin_amount: planOriginAmount,
      updated_at: Number(raw.updated_at) || Date.now(),
      deleted_at:
        raw.deleted_at !== null && raw.deleted_at !== undefined
          ? Number(raw.deleted_at)
          : null,
    };
  }

  function addMonthsClamped(isoLocalStr, monthOffset) {
    const raw = String(isoLocalStr || formatLocalDateTime());
    const datePart = raw.slice(0, 10);
    const timePart = raw.length >= 16 ? raw.slice(11, 16) : '12:00';
    const [y, m, d] = datePart.split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
      return raw;
    }
    const totalMonths = y * 12 + (m - 1) + (parseInt(monthOffset, 10) || 0);
    const newYear = Math.floor(totalMonths / 12);
    const newMonth1 = (totalMonths % 12) + 1;
    const maxDay = new Date(newYear, newMonth1, 0).getDate();
    const clampedDay = Math.min(d, maxDay);
    return `${newYear}-${pad2(newMonth1)}-${pad2(clampedDay)}T${timePart}`;
  }

  function splitAmountExact(totalAmount, periods) {
    const n = Math.max(1, parseInt(periods, 10) || 1);
    const totalCents = Math.round(Math.abs(Number(totalAmount) || 0) * 100);
    const base = Math.floor(totalCents / n);
    const rem = totalCents - base * n;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push((base + (i < rem ? 1 : 0)) / 100);
    }
    return out;
  }

  function buildPlanTransactions(baseTx, opts) {
    const mode = opts && opts.mode === 'repeat' ? 'repeat' : 'split';
    const periods = Math.max(1, Math.min(60, parseInt(opts && opts.periods, 10) || 1));
    const inputAmount = Math.round(Math.abs(Number((opts && opts.inputAmount) ?? baseTx.amount) || 0) * 100) / 100;

    if (periods <= 1) {
      return [
        normalizeTx({
          ...baseTx,
          id: baseTx.id || generateId('tx'),
          amount: inputAmount,
          plan_id: null,
          plan_mode: null,
          plan_index: null,
          plan_total: null,
          plan_origin_amount: null,
        }),
      ];
    }

    const planId = generateId('plan');
    const amounts =
      mode === 'split'
        ? splitAmountExact(inputAmount, periods)
        : new Array(periods).fill(inputAmount);
    const baseTime = baseTx.occurred_at || formatLocalDateTime();
    const now = Date.now();
    const txs = [];

    for (let i = 0; i < periods; i++) {
      txs.push(
        normalizeTx({
          ...baseTx,
          id: generateId('tx'),
          amount: amounts[i],
          occurred_at: addMonthsClamped(baseTime, i),
          external_refs: i === 0 ? baseTx.external_refs || [] : [],
          plan_id: planId,
          plan_mode: mode,
          plan_index: i + 1,
          plan_total: periods,
          plan_origin_amount: inputAmount,
          updated_at: now,
          deleted_at: null,
        })
      );
    }
    return txs;
  }

  function computeFutureCommitments(snapshot, afterMonthKey) {
    const monthTotals = {};
    const planGroups = new Map();

    for (const tx of (snapshot && snapshot.transactions) || []) {
      if (tx.deleted_at !== null && tx.deleted_at !== undefined) continue;
      if (tx.exclude_from_stats || tx.type !== 'expense') continue;
      if (!tx.occurred_at) continue;
      const mk = tx.occurred_at.slice(0, 7);
      if (mk <= afterMonthKey) continue;

      monthTotals[mk] = (monthTotals[mk] || 0) + tx.amount;

      if (tx.plan_id) {
        if (!planGroups.has(tx.plan_id)) {
          planGroups.set(tx.plan_id, {
            plan_id: tx.plan_id,
            note: tx.note || '',
            category: tx.category,
            plan_mode: tx.plan_mode || 'split',
            plan_total: tx.plan_total || 1,
            plan_origin_amount: tx.plan_origin_amount,
            remainingPeriods: 0,
            remainingAmount: 0,
            perMonthAmount: tx.amount,
            lastMonth: mk,
          });
        }
        const g = planGroups.get(tx.plan_id);
        g.remainingPeriods += 1;
        g.remainingAmount += tx.amount;
        if (mk > g.lastMonth) g.lastMonth = mk;
      }
    }

    const nextMonths = Object.keys(monthTotals)
      .sort()
      .slice(0, 6)
      .map((mk) => ({
        monthKey: mk,
        amount: Math.round(monthTotals[mk] * 100) / 100,
      }));

    const activePlans = Array.from(planGroups.values())
      .map((g) => ({
        ...g,
        remainingAmount: Math.round(g.remainingAmount * 100) / 100,
      }))
      .sort((a, b) => b.remainingAmount - a.remainingAmount);

    return { nextMonths, activePlans };
  }

  function mergeSnapshots(local, remote) {
    const cutoff = Date.now() - TOMBSTONE_MAX_AGE_MS;
    const lMap = new Map();
    for (const raw of (local && local.transactions) || []) {
      const nt = normalizeTx(raw);
      if (nt) lMap.set(nt.id, nt);
    }
    const rMap = new Map();
    for (const raw of (remote && remote.transactions) || []) {
      const nt = normalizeTx(raw);
      if (nt) rMap.set(nt.id, nt);
    }

    const allIds = new Set([...lMap.keys(), ...rMap.keys()]);
    const mergedTxs = [];
    let remoteNeedsPush = false;

    for (const id of allIds) {
      const lt = lMap.get(id);
      const rt = rMap.get(id);
      let chosen;
      if (lt && !rt) {
        chosen = lt;
        if (chosen.deleted_at === null || chosen.deleted_at >= cutoff) {
          remoteNeedsPush = true;
        }
      } else if (rt && !lt) {
        chosen = rt;
      } else {
        const refs = Array.from(new Set([...lt.external_refs, ...rt.external_refs]));
        if (lt.updated_at > rt.updated_at) {
          chosen = { ...lt, external_refs: refs };
          remoteNeedsPush = true;
        } else if (rt.updated_at > lt.updated_at) {
          chosen = { ...rt, external_refs: refs };
          if (refs.length > rt.external_refs.length) remoteNeedsPush = true;
        } else {
          chosen = { ...lt, external_refs: refs };
          if (JSON.stringify(lt) !== JSON.stringify(rt)) remoteNeedsPush = true;
        }
      }
      if (chosen.deleted_at !== null && chosen.deleted_at < cutoff) continue;
      mergedTxs.push(chosen);
    }

    mergedTxs.sort((a, b) => {
      if (a.occurred_at !== b.occurred_at) {
        return a.occurred_at < b.occurred_at ? 1 : -1;
      }
      return b.updated_at - a.updated_at;
    });

    const lb = (local && local.budgets) || {};
    const rb = (remote && remote.budgets) || {};
    const mergedBudgets = {};
    for (const mk of new Set([...Object.keys(lb), ...Object.keys(rb)])) {
      const lEntry = lb[mk];
      const rEntry = rb[mk];
      if (lEntry && !rEntry) {
        mergedBudgets[mk] = lEntry;
        remoteNeedsPush = true;
      } else if (rEntry && !lEntry) {
        mergedBudgets[mk] = rEntry;
      } else if (lEntry && rEntry) {
        if ((Number(lEntry.updated_at) || 0) > (Number(rEntry.updated_at) || 0)) {
          mergedBudgets[mk] = lEntry;
          remoteNeedsPush = true;
        } else {
          mergedBudgets[mk] = rEntry;
        }
      }
    }

    const lTags = new Map();
    for (const t of (local && local.custom_tags) || []) {
      if (t && t.name) lTags.set(String(t.name).trim(), t);
    }
    const rTags = new Map();
    for (const t of (remote && remote.custom_tags) || []) {
      if (t && t.name) rTags.set(String(t.name).trim(), t);
    }
    const mergedTags = [];
    for (const name of Array.from(new Set([...lTags.keys(), ...rTags.keys()])).sort()) {
      const lt = lTags.get(name);
      const rt = rTags.get(name);
      let chosen;
      if (lt && !rt) {
        chosen = lt;
        remoteNeedsPush = true;
      } else if (rt && !lt) {
        chosen = rt;
      } else {
        if ((Number(lt.updated_at) || 0) > (Number(rt.updated_at) || 0)) {
          chosen = lt;
          remoteNeedsPush = true;
        } else {
          chosen = rt;
        }
      }
      if (chosen.deleted_at !== null && chosen.deleted_at !== undefined && Number(chosen.deleted_at) < cutoff) {
        continue;
      }
      mergedTags.push({
        name,
        updated_at: Number(chosen.updated_at) || Date.now(),
        deleted_at: chosen.deleted_at ?? null,
      });
    }

    return {
      snapshot: {
        schema_version: 1,
        exported_at: Date.now(),
        transactions: mergedTxs,
        budgets: mergedBudgets,
        custom_tags: mergedTags,
      },
      remoteNeedsPush,
    };
  }

  function computeMonthStats(snapshot, monthKey) {
    const [yrStr, moStr] = monthKey.split('-');
    const year = Number(yrStr);
    const month = Number(moStr);
    const daysInMonth = new Date(year, month, 0).getDate();
    const dailySeries = new Array(daysInMonth).fill(0);

    let personalExpense = 0;
    let personalIncome = 0;
    let excludedExpense = 0;
    const catTotals = {};
    const catSubTotals = {};
    const tagTotals = {};
    const monthActive = [];
    const pendingReimbursements = [];

    for (const tx of snapshot.transactions || []) {
      if (tx.deleted_at !== null && tx.deleted_at !== undefined) continue;
      if (tx.reimbursable && tx.reimburse_status === 'pending') {
        pendingReimbursements.push(tx);
      }
      if (!tx.occurred_at || !tx.occurred_at.startsWith(monthKey)) continue;
      monthActive.push(tx);

      if (tx.exclude_from_stats || tx.type === 'transfer') {
        if (tx.type === 'expense' || tx.reimbursable) {
          excludedExpense += tx.amount;
        }
        continue;
      }

      if (tx.type === 'expense') {
        personalExpense += tx.amount;
        const dayIdx = Number(tx.occurred_at.slice(8, 10)) - 1;
        if (dayIdx >= 0 && dayIdx < daysInMonth) {
          dailySeries[dayIdx] += tx.amount;
        }
        catTotals[tx.category] = (catTotals[tx.category] || 0) + tx.amount;
        if (!catSubTotals[tx.category]) catSubTotals[tx.category] = {};
        for (const tag of tx.tags || []) {
          if (!tagTotals[tag]) tagTotals[tag] = { tag, amount: 0, count: 0 };
          tagTotals[tag].amount += tx.amount;
          tagTotals[tag].count += 1;
          catSubTotals[tx.category][tag] =
            (catSubTotals[tx.category][tag] || 0) + tx.amount;
        }
      } else if (tx.type === 'income') {
        personalIncome += tx.amount;
      }
    }

    const budgetObj =
      (snapshot.budgets && snapshot.budgets[monthKey]) ||
      (snapshot.budgets && snapshot.budgets.default) ||
      { total: 0, categories: {} };
    const totalBudget = Number(budgetObj.total) || 0;
    const catBudgets = budgetObj.categories || {};
    const remainingBudget = totalBudget > 0 ? totalBudget - personalExpense : 0;
    const budgetPct = totalBudget > 0 ? (personalExpense / totalBudget) * 100 : 0;

    const now = new Date();
    const isCurMonth = monthKey === currentMonthKey(now);
    const daysLeft = isCurMonth
      ? Math.max(1, daysInMonth - now.getDate() + 1)
      : daysInMonth;
    const dailyAllowance =
      totalBudget > 0 ? Math.max(0, remainingBudget) / daysLeft : 0;

    const byCategory = Object.entries(catTotals)
      .map(([key, amt]) => {
        const subMap = catSubTotals[key] || {};
        const subItems = Object.entries(subMap)
          .map(([tag, subAmt]) => ({
            tag,
            amount: Math.round(subAmt * 100) / 100,
            pctOfCat: amt > 0 ? (subAmt / amt) * 100 : 0,
          }))
          .sort((a, b) => b.amount - a.amount);
        return {
          key,
          meta: CATEGORY_MAP[key] || { key, label: key, icon: '📦' },
          amount: Math.round(amt * 100) / 100,
          pct: personalExpense > 0 ? (amt / personalExpense) * 100 : 0,
          budgetCap: Number(catBudgets[key]) || 0,
          subItems,
        };
      })
      .sort((a, b) => b.amount - a.amount);

    const byTag = Object.values(tagTotals)
      .map((item) => ({
        ...item,
        amount: Math.round(item.amount * 100) / 100,
        pct: personalExpense > 0 ? (item.amount / personalExpense) * 100 : 0,
      }))
      .sort((a, b) => b.amount - a.amount);

    const pendingTotal = pendingReimbursements.reduce((s, t) => s + t.amount, 0);

    return {
      monthKey,
      daysInMonth,
      dailySeries: dailySeries.map((v) => Math.round(v * 100) / 100),
      personalExpense: Math.round(personalExpense * 100) / 100,
      personalIncome: Math.round(personalIncome * 100) / 100,
      excludedExpense: Math.round(excludedExpense * 100) / 100,
      netBalance: Math.round((personalIncome - personalExpense) * 100) / 100,
      totalBudget,
      catBudgets,
      remainingBudget: Math.round(remainingBudget * 100) / 100,
      budgetPct,
      dailyAllowance: Math.round(dailyAllowance * 100) / 100,
      byCategory,
      byTag,
      monthActive,
      pendingReimbursements,
      pendingTotal: Math.round(pendingTotal * 100) / 100,
    };
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function formatPlanLabel(tx) {
    if (!tx.plan_id || !tx.plan_total) return '';
    if (tx.plan_mode === 'repeat') {
      const prefix = tx.plan_total === 12 ? '全年' : '周期';
      return `${prefix} ${tx.plan_index || 1}/${tx.plan_total}`;
    }
    const totalTxt = tx.plan_origin_amount ? ` (总¥${Number(tx.plan_origin_amount).toFixed(2)})` : '';
    return `分摊 ${tx.plan_index || 1}/${tx.plan_total}${totalTxt}`;
  }

  function buildCsvString(transactions) {
    const header = [
      '日期时间',
      '类型',
      '分类',
      '金额(元)',
      '标签',
      '备注',
      '报销状态',
      '计入收支统计',
      '来源',
      '外部单号',
      '记录ID',
      '分期/周期',
    ];
    const rows = [header.map(csvEscape).join(',')];
    for (const tx of transactions) {
      if (tx.deleted_at !== null && tx.deleted_at !== undefined) continue;
      const typeLabel =
        tx.type === 'expense' ? '支出' : tx.type === 'income' ? '收入' : '不入账';
      const catLabel = (CATEGORY_MAP[tx.category] || {}).label || tx.category;
      const reimbLabel = tx.reimbursable
        ? tx.reimburse_status === 'done'
          ? '已报销'
          : '待报销'
        : '非报销';
      rows.push(
        [
          tx.occurred_at.replace('T', ' '),
          typeLabel,
          catLabel,
          tx.amount.toFixed(2),
          (tx.tags || []).map((t) => '#' + t).join(' '),
          tx.note || '',
          reimbLabel,
          tx.exclude_from_stats ? '否' : '是',
          tx.source || 'manual',
          (tx.external_refs || []).join(';'),
          tx.id,
          formatPlanLabel(tx),
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    return '\uFEFF' + rows.join('\r\n');
  }

  // IndexedDB persistence wrapper (graceful memory fallback when blocked)
  class LedgerStore {
    constructor() {
      this.db = null;
      this.snapshot = {
        schema_version: 1,
        exported_at: Date.now(),
        transactions: [],
        budgets: {},
        custom_tags: DEFAULT_TAGS.map((name) => ({
          name,
          updated_at: 1,
          deleted_at: null,
        })),
      };
      this.meta = { sync_config: null, last_sync_at: '', dirty: false };
      this.writeSeq = 0;
    }

    async init() {
      if (typeof indexedDB === 'undefined') return this.snapshot;
      try {
        this.db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('transactions')) {
              db.createObjectStore('transactions', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('budgets')) {
              db.createObjectStore('budgets', { keyPath: 'month_key' });
            }
            if (!db.objectStoreNames.contains('custom_tags')) {
              db.createObjectStore('custom_tags', { keyPath: 'name' });
            }
            if (!db.objectStoreNames.contains('meta')) {
              db.createObjectStore('meta', { keyPath: 'k' });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        await this._loadFromDb();
      } catch (err) {
        console.warn('IndexedDB unavailable, using in-memory store:', err);
        this.db = null;
      }
      return this.snapshot;
    }

    async _readAll(storeName) {
      if (!this.db) return [];
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    }

    async _loadFromDb() {
      const [txs, budgetRows, tagRows, metaRows] = await Promise.all([
        this._readAll('transactions'),
        this._readAll('budgets'),
        this._readAll('custom_tags'),
        this._readAll('meta'),
      ]);
      const budgets = {};
      for (const b of budgetRows) {
        budgets[b.month_key] = {
          total: Number(b.total) || 0,
          categories: b.categories || {},
          updated_at: Number(b.updated_at) || Date.now(),
        };
      }
      const tags =
        tagRows.length > 0
          ? tagRows
          : DEFAULT_TAGS.map((name) => ({
              name,
              updated_at: 1,
              deleted_at: null,
            }));
      this.snapshot = {
        schema_version: 1,
        exported_at: Date.now(),
        transactions: txs
          .map(normalizeTx)
          .filter(Boolean)
          .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1)),
        budgets,
        custom_tags: tags,
      };
      for (const m of metaRows) {
        this.meta[m.k] = m.v;
      }
    }

    async _persistSnapshot() {
      if (!this.db) return;
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(
          ['transactions', 'budgets', 'custom_tags'],
          'readwrite'
        );
        const txStore = tx.objectStore('transactions');
        txStore.clear();
        for (const item of this.snapshot.transactions) txStore.put(item);

        const bStore = tx.objectStore('budgets');
        bStore.clear();
        for (const [month_key, val] of Object.entries(this.snapshot.budgets)) {
          bStore.put({ month_key, ...val });
        }

        const tStore = tx.objectStore('custom_tags');
        tStore.clear();
        for (const tg of this.snapshot.custom_tags) tStore.put(tg);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async setMeta(k, v) {
      if (k === 'dirty' && v === true) {
        this.writeSeq += 1;
      }
      this.meta[k] = v;
      if (!this.db) return;
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ k, v });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async upsertTransaction(rawTx) {
      const now = Date.now();
      const normalized = normalizeTx({
        ...rawTx,
        id: rawTx.id || generateId('tx'),
        updated_at: now,
        deleted_at: null,
      });
      const idx = this.snapshot.transactions.findIndex(
        (t) => t.id === normalized.id
      );
      if (idx >= 0) {
        this.snapshot.transactions[idx] = normalized;
      } else {
        this.snapshot.transactions.unshift(normalized);
      }
      this.snapshot.transactions.sort((a, b) =>
        a.occurred_at < b.occurred_at ? 1 : -1
      );
      for (const tg of normalized.tags) {
        this._ensureTagInMemory(tg, now, normalized.category);
      }
      await this._persistSnapshot();
      await this.setMeta('dirty', true);
      return normalized;
    }

    async batchImportTransactions(list) {
      const now = Date.now();
      for (const raw of list) {
        const normalized = normalizeTx({
          ...raw,
          id: raw.id || generateId('tx'),
          updated_at: now,
          deleted_at: null,
        });
        const idx = this.snapshot.transactions.findIndex(
          (t) => t.id === normalized.id
        );
        if (idx >= 0) {
          this.snapshot.transactions[idx] = normalized;
        } else {
          this.snapshot.transactions.unshift(normalized);
        }
        for (const tg of normalized.tags) {
          this._ensureTagInMemory(tg, now, normalized.category);
        }
      }
      this.snapshot.transactions.sort((a, b) =>
        a.occurred_at < b.occurred_at ? 1 : -1
      );
      await this._persistSnapshot();
      await this.setMeta('dirty', true);
    }

    async deleteTransaction(id) {
      const idx = this.snapshot.transactions.findIndex((t) => t.id === id);
      if (idx >= 0) {
        this.snapshot.transactions[idx] = {
          ...this.snapshot.transactions[idx],
          updated_at: Date.now(),
          deleted_at: Date.now(),
        };
        await this._persistSnapshot();
        await this.setMeta('dirty', true);
      }
    }

    async createPlanTransactions(baseTx, planOpts) {
      const generated = buildPlanTransactions(baseTx, planOpts);
      await this.batchImportTransactions(generated);
      return generated;
    }

    async updatePlanGroupMetadata(planId, patch) {
      if (!planId) return 0;
      const now = Date.now();
      let count = 0;
      this.snapshot.transactions = this.snapshot.transactions.map((tx) => {
        if (tx.plan_id !== planId || (tx.deleted_at !== null && tx.deleted_at !== undefined)) {
          return tx;
        }
        count += 1;
        return normalizeTx({
          ...tx,
          category: patch.category !== undefined ? patch.category : tx.category,
          tags: patch.tags !== undefined ? patch.tags : tx.tags,
          note: patch.note !== undefined ? patch.note : tx.note,
          reimbursable: patch.reimbursable !== undefined ? patch.reimbursable : tx.reimbursable,
          reimburse_status:
            patch.reimburse_status !== undefined ? patch.reimburse_status : tx.reimburse_status,
          exclude_from_stats:
            patch.exclude_from_stats !== undefined
              ? patch.exclude_from_stats
              : tx.exclude_from_stats,
          updated_at: now,
        });
      });
      if (patch.tags) {
        let firstCategory = '';
        for (const tx of this.snapshot.transactions) {
          if (tx.plan_id === planId && (tx.deleted_at === null || tx.deleted_at === undefined)) {
            firstCategory = tx.category;
            break;
          }
        }
        const catForTag = patch.category || firstCategory;
        for (const tg of patch.tags) this._ensureTagInMemory(tg, now, catForTag);
      }
      if (count > 0) {
        await this._persistSnapshot();
        await this.setMeta('dirty', true);
      }
      return count;
    }

    async deletePlanGroup(planId) {
      if (!planId) return 0;
      const now = Date.now();
      let count = 0;
      this.snapshot.transactions = this.snapshot.transactions.map((tx) => {
        if (tx.plan_id !== planId || (tx.deleted_at !== null && tx.deleted_at !== undefined)) {
          return tx;
        }
        count += 1;
        return {
          ...tx,
          updated_at: now,
          deleted_at: now,
        };
      });
      if (count > 0) {
        await this._persistSnapshot();
        await this.setMeta('dirty', true);
      }
      return count;
    }

    async settleReimbursement(id) {
      const idx = this.snapshot.transactions.findIndex((t) => t.id === id);
      if (idx >= 0) {
        this.snapshot.transactions[idx] = {
          ...this.snapshot.transactions[idx],
          reimbursable: true,
          reimburse_status: 'done',
          exclude_from_stats: true,
          updated_at: Date.now(),
        };
        await this._persistSnapshot();
        await this.setMeta('dirty', true);
      }
    }

    async linkExternalRefs(id, refs) {
      const idx = this.snapshot.transactions.findIndex((t) => t.id === id);
      if (idx >= 0) {
        const existing = this.snapshot.transactions[idx].external_refs || [];
        this.snapshot.transactions[idx] = {
          ...this.snapshot.transactions[idx],
          external_refs: Array.from(new Set([...existing, ...refs])),
          updated_at: Date.now(),
        };
        await this._persistSnapshot();
        await this.setMeta('dirty', true);
      }
    }

    async setBudget(monthKey, total, categories) {
      this.snapshot.budgets[monthKey] = {
        total: Math.max(0, Number(total) || 0),
        categories: categories || {},
        updated_at: Date.now(),
      };
      await this._persistSnapshot();
      await this.setMeta('dirty', true);
    }

    _ensureTagInMemory(name, ts = Date.now(), categoryKey = '') {
      const clean = String(name)
        .trim()
        .replace(/^#+/, '')
        .replace(/::/g, '·')
        .slice(0, 24);
      if (!clean) return;
      if (categoryKey) {
        const scopedKey = `${categoryKey}::${clean}`;
        const existingScoped = this.snapshot.custom_tags.findIndex(
          (t) => t.name === scopedKey
        );
        if (existingScoped >= 0) {
          if (this.snapshot.custom_tags[existingScoped].deleted_at !== null) {
            this.snapshot.custom_tags[existingScoped] = {
              name: scopedKey,
              updated_at: ts,
              deleted_at: null,
            };
          }
          return;
        }
        if (this.getSubtagsForCategory(categoryKey).includes(clean)) {
          return;
        }
        this.snapshot.custom_tags.push({
          name: scopedKey,
          updated_at: ts,
          deleted_at: null,
        });
        return;
      }

      const idx = this.snapshot.custom_tags.findIndex((t) => t.name === clean);
      if (idx >= 0) {
        if (this.snapshot.custom_tags[idx].deleted_at !== null) {
          this.snapshot.custom_tags[idx] = {
            name: clean,
            updated_at: ts,
            deleted_at: null,
          };
        }
      } else {
        this.snapshot.custom_tags.push({
          name: clean,
          updated_at: ts,
          deleted_at: null,
        });
      }
    }

    getSubtagsForCategory(categoryKey) {
      const defaults = DEFAULT_CATEGORY_SUBTAGS[categoryKey] || [];
      const list = [...defaults];
      for (const item of this.snapshot.custom_tags || []) {
        if (!item || !item.name) continue;
        const parsed = parseScopedTagName(item.name);
        if (!parsed.tag) continue;
        if (parsed.scoped) {
          if (parsed.category !== categoryKey) continue;
          if (item.deleted_at !== null && item.deleted_at !== undefined) {
            const idx = list.indexOf(parsed.tag);
            if (idx >= 0) list.splice(idx, 1);
          } else if (!list.includes(parsed.tag)) {
            list.push(parsed.tag);
          }
        } else if (
          (item.deleted_at === null || item.deleted_at === undefined) &&
          !DEFAULT_TAGS.includes(parsed.tag) &&
          !list.includes(parsed.tag)
        ) {
          list.push(parsed.tag);
        }
      }
      return list;
    }

    async addSubtag(categoryKey, rawTagName) {
      const cat = String(categoryKey || '').trim();
      const clean = String(rawTagName || '')
        .trim()
        .replace(/^#+/, '')
        .replace(/::/g, '·')
        .slice(0, 24);
      if (!cat || !clean) return;
      const now = Date.now();
      const scopedKey = `${cat}::${clean}`;
      const idx = this.snapshot.custom_tags.findIndex((t) => t.name === scopedKey);
      if (idx >= 0) {
        this.snapshot.custom_tags[idx] = {
          name: scopedKey,
          updated_at: now,
          deleted_at: null,
        };
      } else if (!(DEFAULT_CATEGORY_SUBTAGS[cat] || []).includes(clean)) {
        this.snapshot.custom_tags.push({
          name: scopedKey,
          updated_at: now,
          deleted_at: null,
        });
      }
      await this._persistSnapshot();
      await this.setMeta('dirty', true);
    }

    async removeSubtag(categoryKey, rawTagName) {
      const cat = String(categoryKey || '').trim();
      const clean = String(rawTagName || '')
        .trim()
        .replace(/^#+/, '')
        .replace(/::/g, '·')
        .slice(0, 24);
      if (!cat || !clean) return;
      const now = Date.now();
      const scopedKey = `${cat}::${clean}`;
      const idx = this.snapshot.custom_tags.findIndex((t) => t.name === scopedKey);
      if (idx >= 0) {
        this.snapshot.custom_tags[idx] = {
          name: scopedKey,
          updated_at: now,
          deleted_at: now,
        };
      } else {
        this.snapshot.custom_tags.push({
          name: scopedKey,
          updated_at: now,
          deleted_at: now,
        });
      }
      // Also tombstone matching legacy unscoped entry so it does not linger in settings
      const legIdx = this.snapshot.custom_tags.findIndex((t) => t.name === clean);
      if (legIdx >= 0 && this.snapshot.custom_tags[legIdx].deleted_at === null) {
        this.snapshot.custom_tags[legIdx] = {
          name: clean,
          updated_at: now,
          deleted_at: now,
        };
      }
      await this._persistSnapshot();
      await this.setMeta('dirty', true);
    }

    async addTag(name) {
      this._ensureTagInMemory(name, Date.now());
      await this._persistSnapshot();
      await this.setMeta('dirty', true);
    }

    getActiveTags() {
      const out = [];
      for (const t of this.snapshot.custom_tags || []) {
        if (!t || (t.deleted_at !== null && t.deleted_at !== undefined)) continue;
        const parsed = parseScopedTagName(t.name);
        if (parsed.tag && !out.includes(parsed.tag)) out.push(parsed.tag);
      }
      return out;
    }

    async replaceFromMerge(remoteSnap) {
      const { snapshot, remoteNeedsPush } = mergeSnapshots(
        this.snapshot,
        remoteSnap
      );
      this.snapshot = snapshot;
      await this._persistSnapshot();
      return { snapshot, remoteNeedsPush };
    }
  }

  const api = {
    CATEGORIES,
    CATEGORY_MAP,
    DEFAULT_TAGS,
    DEFAULT_CATEGORY_SUBTAGS,
    parseScopedTagName,
    LedgerStore,
    mergeSnapshots,
    computeMonthStats,
    computeFutureCommitments,
    addMonthsClamped,
    splitAmountExact,
    buildPlanTransactions,
    formatPlanLabel,
    buildCsvString,
    formatLocalDateTime,
    currentMonthKey,
    generateId,
    normalizeTx,
  };

  global.QZStore = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
