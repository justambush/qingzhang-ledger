(function (global) {
  'use strict';

  function decodeCsvBuffer(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    try {
      const txt = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return txt.replace(/^\uFEFF/, '');
    } catch (_) {
      try {
        return new TextDecoder('gb18030').decode(bytes).replace(/^\uFEFF/, '');
      } catch (e2) {
        return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
      }
    }
  }

  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).slice(0, 35);
    let commaScore = 0;
    let tabScore = 0;
    let semiScore = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      commaScore += (line.match(/,/g) || []).length;
      tabScore += (line.match(/\t/g) || []).length;
      semiScore += (line.match(/;/g) || []).length;
    }
    if (tabScore > commaScore && tabScore >= semiScore) return '\t';
    if (semiScore > commaScore && semiScore > tabScore) return ';';
    return ',';
  }

  function parseCsvRows(text) {
    const delim = detectDelimiter(text);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        row.push(field.trim());
        field = '';
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') i++;
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = '';
      } else if (ch === '\n') {
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field.trim());
      rows.push(row);
    }
    return rows;
  }

  function parseAmount(raw) {
    if (raw === null || raw === undefined) return NaN;
    let s = String(raw).trim();
    if (!s) return NaN;
    const isParenNeg = /^\(.*\)$/.test(s);
    s = s.replace(/[¥￥$,，\sCNYRMBHKDUSD]/gi, '').replace(/[()]/g, '');
    if (!s) return NaN;
    const n = Number(s);
    if (!Number.isFinite(n)) return NaN;
    return isParenNeg ? -Math.abs(n) : n;
  }

  function normalizeDateTime(raw) {
    if (raw === null || raw === undefined) return '';
    let s = String(raw).trim();
    if (!s) return '';
    // Excel serial date number (e.g. 46348.3854)
    if (/^\d{5}(\.\d+)?$/.test(s)) {
      const xlsxMod = global.QZXlsx;
      if (xlsxMod && typeof xlsxMod.excelSerialToString === 'function') {
        s = xlsxMod.excelSerialToString(Number(s));
      }
    }
    // 2026/11/23 09:15:30 or 2026-11-23 9:15 or 20261123
    const mFull = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})[日\sT]*(\d{1,2})?:?(\d{1,2})?/.exec(s);
    if (mFull) {
      const p = (x) => String(x || '0').padStart(2, '0');
      const hh = mFull[4] !== undefined ? p(mFull[4]) : '12';
      const mm = mFull[5] !== undefined ? p(mFull[5]) : '00';
      return `${mFull[1]}-${p(mFull[2])}-${p(mFull[3])}T${hh}:${mm}`;
    }
    const mCompact = /^(\d{4})(\d{2})(\d{2})(?:\s*(\d{2})(\d{2}))?/.exec(s);
    if (mCompact) {
      const hh = mCompact[4] || '12';
      const mm = mCompact[5] || '00';
      return `${mCompact[1]}-${mCompact[2]}-${mCompact[3]}T${hh}:${mm}`;
    }
    // MM/DD or MM-DD without year -> assume current year
    const mShort = /^(\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?/.exec(s);
    if (mShort) {
      const yr = new Date().getFullYear();
      const p = (x) => String(x || '0').padStart(2, '0');
      return `${yr}-${p(mShort[1])}-${p(mShort[2])}T${p(mShort[3] || 12)}:${p(mShort[4] || 0)}`;
    }
    return '';
  }

  function hashFingerprint(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function suggestCategory(merchant, product, type) {
    if (type === 'income') {
      const text = (merchant + ' ' + product).toLowerCase();
      if (/报销|差旅补贴/.test(text)) return 'reimb_in';
      if (/工资|薪资|发薪|payroll/.test(text)) return 'salary';
      if (/奖金|年终|绩效/.test(text)) return 'bonus';
      if (/基金|理财|分红|利息|余额宝|零钱通收益/.test(text)) return 'invest';
      return 'other_inc';
    }
    if (type === 'transfer') {
      const text = (merchant + ' ' + product).toLowerCase();
      if (/还款/.test(text)) return 'repay';
      return 'internal';
    }
    const text = (merchant + ' ' + product).toLowerCase();
    if (/美团|饿了么|瑞幸|luckin|星巴克|starbucks|麦当劳|肯德基|喜茶|霸王茶姬|奈雪|咖啡|奶茶|火锅|烤肉|面馆|餐厅|食堂|餐饮|饭店|盒马|叮咚|买菜|烘焙|面包/.test(text)) {
      return 'food';
    }
    if (/滴滴|高德|uber|地铁|公交|交通|铁路|12306|停车|加油|中石化|中石油|高速|etc|充电桩|打车|曹操|哈啰/.test(text)) {
      return 'transit';
    }
    if (/淘宝|天猫|京东|拼多多|唯品会|得物|山姆|奥特莱斯|uniqlo|优衣库|zara|服饰|百货|购物|apple\s*store/.test(text)) {
      return 'shop';
    }
    if (/便利店|罗森|lawson|全家|familymart|7-?11|顺丰|京东快递|菜鸟|话费|联通|移动|电信|日用|屈臣氏|名创/.test(text)) {
      return 'daily';
    }
    if (/房租|水电|燃气|物业|自如|链家|供暖|宽带/.test(text)) {
      return 'home';
    }
    if (/电影|猫眼|大麦|steam|网易云|qq音乐|腾讯视频|爱奇艺|bilibili|会员|剧本杀|ktv|游戏/.test(text)) {
      return 'fun';
    }
    if (/医院|药房|药店|体检|门诊|挂号|口腔|牙科|美年/.test(text)) {
      return 'med';
    }
    if (/酒店|携程|去哪儿|飞猪|同程|机票|航空|国航|东航|南航|民宿|airbnb/.test(text)) {
      return 'travel';
    }
    if (/苹果|icloud|app\s*store|数码|小米|华为|联想|电子/.test(text)) {
      return 'digital';
    }
    if (/红包|转账|礼金|送礼|请客/.test(text)) {
      return 'social';
    }
    if (/书店|图书|课程|培训|得到|极客时间|学费|考试/.test(text)) {
      return 'study';
    }
    return 'other_exp';
  }

  function findHeaderRow(rows) {
    for (let r = 0; r < Math.min(rows.length, 50); r++) {
      const cells = (rows[r] || []).map((c) => String(c || '').trim());
      const nonEmpty = cells.filter(Boolean);
      if (nonEmpty.length < 3) continue;
      const joined = nonEmpty.join('|');

      // Alipay (check Alipay-distinct columns before WeChat so newer Alipay '交易时间'+'金额' headers match Alipay)
      if (
        (joined.includes('交易创建时间') || joined.includes('交易时间') || joined.includes('付款时间')) &&
        joined.includes('交易对方') &&
        (joined.includes('交易订单号') || joined.includes('商品说明') || joined.includes('资金状态') || joined.includes('收/付款方式') || joined.includes('交易分类'))
      ) {
        return { kind: 'alipay', headerIdx: r, headers: cells };
      }
      // WeChat
      if (
        joined.includes('交易时间') &&
        joined.includes('交易对方') &&
        (joined.includes('金额(元)') || joined.includes('当前状态') || joined.includes('交易单号') || joined.includes('金额'))
      ) {
        return { kind: 'wechat', headerIdx: r, headers: cells };
      }
      // Credit card
      const hasDate = /(交易日|交易日期|记账日|消费日期|入账日期|交易时间|日期)/.test(joined);
      const hasAmt = /(金额|人民币|支出|存入|发生额)/.test(joined);
      if (hasDate && hasAmt) {
        return { kind: 'credit_card', headerIdx: r, headers: cells };
      }
    }
    return null;
  }

  function colIdx(headers, patterns) {
    for (const pat of patterns) {
      const i = headers.findIndex((h) => (pat instanceof RegExp ? pat.test(h) : h.includes(pat)));
      if (i >= 0) return i;
    }
    return -1;
  }

  function parseWeChatRows(rows, headerIdx, headers, fileName) {
    const iTime = colIdx(headers, ['交易时间']);
    const iType = colIdx(headers, ['交易类型']);
    const iMerchant = colIdx(headers, ['交易对方']);
    const iGoods = colIdx(headers, ['商品']);
    const iDir = colIdx(headers, ['收/支']);
    const iAmt = colIdx(headers, ['金额(元)', '金额']);
    const iPay = colIdx(headers, ['支付方式']);
    const iStatus = colIdx(headers, ['当前状态', '状态']);
    const iOrder = colIdx(headers, ['交易单号', '商户单号']);

    const items = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => !String(c || '').trim())) continue;
      const dt = normalizeDateTime(row[iTime]);
      if (!dt) continue;
      const status = String(row[iStatus] || '').trim();
      if (/已全额退款|退款成功|交易关闭|支付失败|已退还/.test(status)) continue;

      const amt = Math.abs(parseAmount(row[iAmt]));
      if (!Number.isFinite(amt) || amt <= 0) continue;

      const dir = String(row[iDir] || '').trim();
      const txKind = String(row[iType] || '').trim();
      const merchant = String(row[iMerchant] || '').trim();
      const goods = String(row[iGoods] || '').trim();
      const payMethod = String(row[iPay] || '').trim();
      const orderId = String(row[iOrder] || '').trim();

      let type = 'expense';
      if (dir === '收入') type = 'income';
      else if (dir === '/' || dir === '不计收支' || /零钱提现|转入零钱通|信用卡还款/.test(txKind + goods)) {
        type = 'transfer';
      }

      const ref = orderId
        ? 'wx:' + orderId
        : 'wx:' + hashFingerprint(`${dt}|${amt.toFixed(2)}|${merchant}|${goods}`);

      items.push({
        bill_id: 'bill_' + hashFingerprint(ref + '_' + r),
        source: 'wechat',
        fileName,
        occurred_at: dt,
        amount: Math.round(amt * 100) / 100,
        type,
        merchant: merchant || txKind || '微信支付',
        product: goods && goods !== '/' ? goods : txKind,
        pay_method: payMethod,
        category: suggestCategory(merchant, goods + ' ' + txKind, type),
        external_refs: [ref],
        reimbursable: false,
        exclude_from_stats: type === 'transfer',
        is_repayment: type === 'transfer',
      });
    }
    return items;
  }

  function parseAlipayRows(rows, headerIdx, headers, fileName) {
    const iTime = colIdx(headers, ['交易时间', '交易创建时间', '付款时间']);
    const iCat = colIdx(headers, ['交易分类', '类型']);
    const iMerchant = colIdx(headers, ['交易对方']);
    const iGoods = colIdx(headers, ['商品说明', '商品名称']);
    const iDir = colIdx(headers, ['收/支']);
    const iAmt = colIdx(headers, ['金额', '金额（元）']);
    const iPay = colIdx(headers, ['收/付款方式', '付款方式']);
    const iStatus = colIdx(headers, ['交易状态', '资金状态']);
    const iOrder = colIdx(headers, ['交易订单号', '交易号']);

    const items = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => !String(c || '').trim())) continue;
      const dt = normalizeDateTime(row[iTime]);
      if (!dt) continue;
      const status = String(row[iStatus] || '').trim();
      if (/交易关闭|退款成功|解冻成功|等待付款/.test(status)) continue;

      const amt = Math.abs(parseAmount(row[iAmt]));
      if (!Number.isFinite(amt) || amt <= 0) continue;

      const dir = String(row[iDir] || '').trim();
      const catHint = String(row[iCat] || '').trim();
      const merchant = String(row[iMerchant] || '').trim();
      const goods = String(row[iGoods] || '').trim();
      const payMethod = String(row[iPay] || '').trim();
      const orderId = String(row[iOrder] || '').trim();

      let type = 'expense';
      if (dir === '收入') type = 'income';
      else if (
        dir === '不计收支' ||
        dir === '/' ||
        /还款|余额宝|花呗主动还款|信用卡还款|转入/.test(goods + catHint)
      ) {
        type = 'transfer';
      }

      const ref = orderId
        ? 'ali:' + orderId
        : 'ali:' + hashFingerprint(`${dt}|${amt.toFixed(2)}|${merchant}|${goods}`);

      items.push({
        bill_id: 'bill_' + hashFingerprint(ref + '_' + r),
        source: 'alipay',
        fileName,
        occurred_at: dt,
        amount: Math.round(amt * 100) / 100,
        type,
        merchant: merchant || catHint || '支付宝',
        product: goods,
        pay_method: payMethod,
        category: suggestCategory(merchant, goods + ' ' + catHint, type),
        external_refs: [ref],
        reimbursable: false,
        exclude_from_stats: type === 'transfer',
        is_repayment: type === 'transfer',
      });
    }
    return items;
  }

  function parseCreditCardRows(rows, headerIdx, headers, fileName, manualMap) {
    const iDate =
      manualMap && manualMap.date >= 0
        ? manualMap.date
        : colIdx(headers, [/^交易日/, /消费日期/, /交易时间/, /记账日/, /入账日/, /日期/]);
    const iMerchant =
      manualMap && manualMap.merchant >= 0
        ? manualMap.merchant
        : colIdx(headers, [/交易摘要/, /商户/, /摘要/, /描述/, /交易说明/, /对方户名/]);
    const iAmt =
      manualMap && manualMap.amount >= 0
        ? manualMap.amount
        : colIdx(headers, [/人民币金额/, /交易金额/, /记账金额/, /消费金额/, /发生额/, /金额/]);
    const iDebit = colIdx(headers, [/^支出/, /借方金额/, /支出金额/]);
    const iCredit = colIdx(headers, [/^收入/, /^存入/, /贷方金额/, /存入金额/]);
    const iFlag =
      manualMap && manualMap.flag >= 0
        ? manualMap.flag
        : colIdx(headers, [/借\/?贷/, /收\/?支/, /交易类型/, /方向/]);

    if (iDate < 0 || (iAmt < 0 && iDebit < 0)) {
      return null;
    }

    // Detect sign convention if single amount column is used:
    // some banks use +expense / -repayment, others use -expense / +repayment
    let negativeMeansExpense = false;
    if (iAmt >= 0 && iDebit < 0) {
      let negCount = 0;
      let posCount = 0;
      let negExpenseHint = 0;
      let posExpenseHint = 0;
      for (let r = headerIdx + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        const v = parseAmount(row[iAmt]);
        if (!Number.isFinite(v) || v === 0) continue;
        const desc = String(row[iMerchant] || '');
        const isRepay = /还款|存入|退货|退款/.test(desc);
        if (v < 0) {
          negCount++;
          if (!isRepay) negExpenseHint++;
        } else {
          posCount++;
          if (!isRepay) posExpenseHint++;
        }
      }
      if (negCount > posCount && negExpenseHint >= posExpenseHint) {
        negativeMeansExpense = true;
      }
    }

    const items = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => !String(c || '').trim())) continue;
      const dt = normalizeDateTime(row[iDate]);
      if (!dt) continue;

      const merchant = String(row[iMerchant] || '').trim() || '信用卡消费';
      const flag = iFlag >= 0 ? String(row[iFlag] || '').trim() : '';

      let amt = 0;
      let type = 'expense';

      if (iDebit >= 0) {
        const dVal = Math.abs(parseAmount(row[iDebit]) || 0);
        const cVal = iCredit >= 0 ? Math.abs(parseAmount(row[iCredit]) || 0) : 0;
        if (dVal > 0) {
          amt = dVal;
          type = 'expense';
        } else if (cVal > 0) {
          amt = cVal;
          type = 'transfer';
        } else {
          continue;
        }
      } else {
        const rawV = parseAmount(row[iAmt]);
        if (!Number.isFinite(rawV) || rawV === 0) continue;
        amt = Math.abs(rawV);
        if (flag && /贷|存入|还款|收入/.test(flag)) {
          type = 'transfer';
        } else if (flag && /借|支出|消费/.test(flag)) {
          type = 'expense';
        } else if (negativeMeansExpense) {
          type = rawV < 0 ? 'expense' : 'transfer';
        } else {
          type = rawV > 0 ? 'expense' : 'transfer';
        }
      }

      const isRepayDesc = /信用卡还款|自动还款|约定还款|网银还款|本行还款|银联入账|分期还款|退款/.test(
        merchant + ' ' + flag
      );
      if (isRepayDesc) type = 'transfer';

      const ref = 'cc:' + hashFingerprint(`${dt.slice(0, 10)}|${amt.toFixed(2)}|${merchant}|${r}`);
      items.push({
        bill_id: 'bill_' + hashFingerprint(ref),
        source: 'credit_card',
        fileName,
        occurred_at: dt,
        amount: Math.round(amt * 100) / 100,
        type,
        merchant,
        product: flag || '信用卡账单',
        pay_method: '信用卡',
        category: suggestCategory(merchant, flag, type),
        external_refs: [ref],
        reimbursable: false,
        exclude_from_stats: type === 'transfer',
        is_repayment: type === 'transfer',
      });
    }
    return items;
  }

  async function parseStatementFile(fileObj) {
    const name = fileObj.name || 'bill.csv';
    const buf =
      fileObj.arrayBuffer instanceof Function
        ? await fileObj.arrayBuffer()
        : fileObj.buffer;
    let rows;
    if (/\.xlsx$/i.test(name)) {
      rows = await global.QZXlsx.parseXlsxRows(buf);
    } else {
      const text = decodeCsvBuffer(buf);
      rows = parseCsvRows(text);
    }

    const detected = findHeaderRow(rows);
    if (!detected) {
      const nonEmptyRows = rows.filter((r) => r.some((c) => String(c || '').trim()));
      return {
        needsMapping: true,
        fileName: name,
        rows: nonEmptyRows,
        preview: nonEmptyRows.slice(0, 8),
      };
    }

    let items = [];
    if (detected.kind === 'wechat') {
      items = parseWeChatRows(rows, detected.headerIdx, detected.headers, name);
    } else if (detected.kind === 'alipay') {
      items = parseAlipayRows(rows, detected.headerIdx, detected.headers, name);
    } else {
      items =
        parseCreditCardRows(rows, detected.headerIdx, detected.headers, name, null) ||
        [];
    }
    return { needsMapping: false, kind: detected.kind, fileName: name, items };
  }

  function dateDayMs(isoStr) {
    const [y, m, d] = isoStr.slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function reconcileBills(rawBillItems, existingLedgerTxs) {
    // Step 0: deduplicate identical external_ref across overlapping exports of same channel
    const byRef = new Map();
    const uniqueItems = [];
    for (const item of rawBillItems) {
      const primaryRef = item.external_refs[0];
      if (primaryRef && byRef.has(primaryRef)) continue;
      if (primaryRef) byRef.set(primaryRef, true);
      uniqueItems.push({ ...item, external_refs: [...item.external_refs] });
    }

    // Step 1: Cross-channel deduplication (WeChat / Alipay <-> Credit Card)
    const walletRows = uniqueItems.filter(
      (i) => (i.source === 'wechat' || i.source === 'alipay') && i.type === 'expense'
    );
    const ccRows = uniqueItems.filter(
      (i) => i.source === 'credit_card' && i.type === 'expense'
    );

    const candidates = [];
    for (let wi = 0; wi < walletRows.length; wi++) {
      const w = walletRows[wi];
      const wDay = dateDayMs(w.occurred_at);
      for (let ci = 0; ci < ccRows.length; ci++) {
        const c = ccRows[ci];
        if (Math.abs(w.amount - c.amount) >= 0.01) continue;
        const cDay = dateDayMs(c.occurred_at);
        const diffDays = (cDay - wDay) / 86400000;
        if (diffDays < -1 || diffDays > 3) continue;

        let score = 100 - Math.abs(diffDays) * 18;
        if (diffDays === 0) score += 20;
        const wPay = (w.pay_method || '').toLowerCase();
        const cMerc = (c.merchant || '').toLowerCase();
        if (/信用卡|招行|招商|工行|工商|建行|建设|交行|交通|中信|广发|浦发|兴业|平安/.test(wPay)) {
          score += 40;
        }
        if (/财付通|微信|tenpay|支付宝|alipay|网联|银联/.test(cMerc)) {
          score += 40;
        }
        if (w.merchant && c.merchant && (c.merchant.includes(w.merchant) || w.merchant.includes(c.merchant))) {
          score += 25;
        }
        if (score >= 60) {
          candidates.push({ wi, ci, score });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const usedW = new Set();
    const usedC = new Set();
    const mergedResults = [];

    for (const cand of candidates) {
      if (usedW.has(cand.wi) || usedC.has(cand.ci)) continue;
      usedW.add(cand.wi);
      usedC.add(cand.ci);
      const w = walletRows[cand.wi];
      const c = ccRows[cand.ci];
      mergedResults.push({
        ...w,
        source: 'merged_bill',
        mergedFrom: [w.source, 'credit_card'],
        creditCardMerchant: c.merchant,
        external_refs: Array.from(new Set([...w.external_refs, ...c.external_refs])),
      });
    }

    const usedWalletIds = new Set([...usedW].map((i) => walletRows[i].bill_id));
    const usedCcIds = new Set([...usedC].map((i) => ccRows[i].bill_id));
    const consolidated = [];
    for (const item of uniqueItems) {
      if (usedWalletIds.has(item.bill_id) || usedCcIds.has(item.bill_id)) continue;
      consolidated.push(item);
    }
    consolidated.push(...mergedResults);
    consolidated.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));

    // Step 2: Compare consolidated bills against active existing ledger
    const activeLedger = (existingLedgerTxs || []).filter(
      (t) => t.deleted_at === null || t.deleted_at === undefined
    );
    const refToLedger = new Map();
    for (const tx of activeLedger) {
      for (const ref of tx.external_refs || []) {
        refToLedger.set(ref, tx);
      }
    }

    const matchedLedgerIds = new Set();
    const exactMatched = [];
    const unmatchedBills = [];

    for (const b of consolidated) {
      let foundExact = null;
      for (const ref of b.external_refs) {
        if (refToLedger.has(ref)) {
          foundExact = refToLedger.get(ref);
          break;
        }
      }
      if (foundExact) {
        matchedLedgerIds.add(foundExact.id);
        exactMatched.push({
          ...b,
          reconStatus: 'matched_exact',
          matchedTx: foundExact,
          selected: false,
        });
      } else {
        unmatchedBills.push(b);
      }
    }

    // Fuzzy match remaining bills against unmatched active ledger items
    // Also supports matching against period-1 of a split-amortized entry via plan_origin_amount
    const fuzzyPairs = [];
    for (let bi = 0; bi < unmatchedBills.length; bi++) {
      const b = unmatchedBills[bi];
      if (b.type === 'transfer') continue;
      const bDay = dateDayMs(b.occurred_at);
      for (let ti = 0; ti < activeLedger.length; ti++) {
        const tx = activeLedger[ti];
        if (matchedLedgerIds.has(tx.id)) continue;
        if (tx.type !== b.type) continue;
        const directAmtMatch = Math.abs(tx.amount - b.amount) < 0.01;
        const splitOriginMatch =
          !directAmtMatch &&
          tx.plan_mode === 'split' &&
          tx.plan_index === 1 &&
          tx.plan_origin_amount &&
          Math.abs(tx.plan_origin_amount - b.amount) < 0.01;
        if (!directAmtMatch && !splitOriginMatch) continue;
        const diffDays = Math.abs(dateDayMs(tx.occurred_at) - bDay) / 86400000;
        if (diffDays <= 1) {
          fuzzyPairs.push({ bi, ti, diffDays, splitOriginMatch });
        }
      }
    }
    fuzzyPairs.sort((a, b) => a.diffDays - b.diffDays);

    const fuzzyBillUsed = new Set();
    const fuzzyTxUsed = new Set();
    const fuzzyMatched = [];

    for (const p of fuzzyPairs) {
      if (fuzzyBillUsed.has(p.bi) || fuzzyTxUsed.has(p.ti)) continue;
      fuzzyBillUsed.add(p.bi);
      fuzzyTxUsed.add(p.ti);
      const b = unmatchedBills[p.bi];
      const tx = activeLedger[p.ti];
      matchedLedgerIds.add(tx.id);
      fuzzyMatched.push({
        ...b,
        reconStatus: 'matched_fuzzy',
        matchedTx: tx,
        matchedSplitOrigin: Boolean(p.splitOriginMatch),
        selected: false,
        splitPeriods: 1,
      });
    }

    const missing = [];
    for (let bi = 0; bi < unmatchedBills.length; bi++) {
      if (fuzzyBillUsed.has(bi)) continue;
      const b = unmatchedBills[bi];
      missing.push({
        ...b,
        reconStatus: 'missing',
        matchedTx: null,
        selected: b.type !== 'transfer',
        splitPeriods: 1,
      });
    }

    // Compute ledger-only records within bill date range
    let minDate = '9999-99-99';
    let maxDate = '0000-00-00';
    for (const b of consolidated) {
      const d = b.occurred_at.slice(0, 10);
      if (d < minDate) minDate = d;
      if (d > maxDate) maxDate = d;
    }
    const ledgerOnly = activeLedger.filter((tx) => {
      if (matchedLedgerIds.has(tx.id)) return false;
      if (consolidated.length === 0) return false;
      const d = tx.occurred_at.slice(0, 10);
      return d >= minDate && d <= maxDate;
    });

    const allRows = [...missing, ...fuzzyMatched, ...exactMatched].sort((a, b) =>
      a.occurred_at < b.occurred_at ? 1 : -1
    );

    return {
      rows: allRows,
      missingCount: missing.filter((r) => r.type !== 'transfer').length,
      mergedCrossCount: allRows.filter((r) => r.source === 'merged_bill').length,
      fuzzyCount: fuzzyMatched.length,
      exactCount: exactMatched.length,
      ledgerOnly,
      crossMergedPairs: usedW.size,
    };
  }

  function generateDemoStatements() {
    const now = new Date();
    const ym =
      now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const d1 = `${ym}-05`;
    const d2 = `${ym}-11`;
    const d3 = `${ym}-18`;

    const wechatCsv = [
      '微信支付账单明细,,,,,,,,',
      '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号',
      `${d1} 09:15:20,商户消费,瑞幸咖啡,生椰拿铁,支出,¥19.90,招商银行信用卡(8821),支付成功,WX1001`,
      `${d2} 12:30:05,商户消费,盒马鲜生,生鲜水果,支出,¥126.40,零钱,支付成功,WX1002`,
      `${d3} 19:45:10,商户消费,海底捞火锅,好友聚餐,支出,¥328.00,招商银行信用卡(8821),支付成功,WX1003`,
    ].join('\n');

    const alipayCsv = [
      '支付宝交易明细,,,,,,',
      '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号',
      `${d1} 18:20:00,交通出行,滴滴出行,快车行程,支出,34.50,招商银行信用卡(8821),交易成功,ALI2001`,
      `${d2} 21:05:11,日用百货,淘宝平台,充电线,支出,29.90,花呗,交易成功,ALI2002`,
    ].join('\n');

    const cmbCsv = [
      '招商银行信用卡对账单,,,,,',
      '交易日,记账日,交易摘要,人民币金额,卡号末四位',
      `${d1},${ym}-06,财付通-瑞幸咖啡,19.90,8821`,
      `${d1},${ym}-06,支付宝-滴滴出行,34.50,8821`,
      `${d3},${ym}-19,财付通-海底捞火锅,328.00,8821`,
      `${d3},${ym}-19,山姆会员商店线下刷卡,268.00,8821`,
      `${ym}-20,${ym}-20,掌上生活自动还款,-2000.00,8821`,
    ].join('\n');

    const enc = new TextEncoder();
    return [
      { name: '演示_微信账单.csv', buffer: enc.encode(wechatCsv).buffer },
      { name: '演示_支付宝账单.csv', buffer: enc.encode(alipayCsv).buffer },
      { name: '演示_招行信用卡账单.csv', buffer: enc.encode(cmbCsv).buffer },
    ];
  }

  const api = {
    decodeCsvBuffer,
    parseCsvRows,
    parseStatementFile,
    parseCreditCardRows,
    reconcileBills,
    suggestCategory,
    generateDemoStatements,
    normalizeDateTime,
  };

  global.QZReconcile = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
