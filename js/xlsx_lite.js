(function (global) {
  'use strict';

  function readUint16LE(view, offset) {
    return view.getUint16(offset, true);
  }

  function readUint32LE(view, offset) {
    return view.getUint32(offset, true);
  }

  async function inflateRawBytes(compressed) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([compressed]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    }
    if (typeof require === 'function') {
      return new Uint8Array(require('zlib').inflateRawSync(compressed));
    }
    throw new Error('当前浏览器不支持原生解压 .xlsx，请导出为 CSV 后上传');
  }

  async function unzipEntries(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Find End of Central Directory (0x06054b50) scanning backwards
    let eocdOffset = -1;
    const minOff = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= minOff; i--) {
      if (
        bytes[i] === 0x50 &&
        bytes[i + 1] === 0x4b &&
        bytes[i + 2] === 0x05 &&
        bytes[i + 3] === 0x06
      ) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) {
      throw new Error('无效的 .xlsx 文件（找不到 ZIP 目录结构）');
    }

    const totalEntries = readUint16LE(view, eocdOffset + 10);
    const cdOffset = readUint32LE(view, eocdOffset + 16);
    const decoder = new TextDecoder('utf-8');

    const entries = new Map();
    let ptr = cdOffset;
    for (let idx = 0; idx < totalEntries && ptr + 46 <= bytes.length; idx++) {
      const sig = readUint32LE(view, ptr);
      if (sig !== 0x02014b50) break;
      const method = readUint16LE(view, ptr + 10);
      const compSize = readUint32LE(view, ptr + 20);
      const nameLen = readUint16LE(view, ptr + 28);
      const extraLen = readUint16LE(view, ptr + 30);
      const commentLen = readUint16LE(view, ptr + 32);
      const localHeaderOffset = readUint32LE(view, ptr + 42);
      const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      ptr += 46 + nameLen + extraLen + commentLen;

      entries.set(name, { method, compSize, localHeaderOffset });
    }

    async function readEntryText(name) {
      const meta = entries.get(name);
      if (!meta) return null;
      const lh = meta.localHeaderOffset;
      if (readUint32LE(view, lh) !== 0x04034b50) {
        throw new Error('ZIP 文件头损坏: ' + name);
      }
      const lhNameLen = readUint16LE(view, lh + 26);
      const lhExtraLen = readUint16LE(view, lh + 28);
      const dataStart = lh + 30 + lhNameLen + lhExtraLen;
      const slice = bytes.subarray(dataStart, dataStart + meta.compSize);
      let outBytes;
      if (meta.method === 0) {
        outBytes = slice;
      } else if (meta.method === 8) {
        outBytes = await inflateRawBytes(slice);
      } else {
        throw new Error('不支持的 ZIP 压缩方式: ' + meta.method);
      }
      return decoder.decode(outBytes);
    }

    return { entries, readEntryText };
  }

  function parseXml(xmlText) {
    if (typeof DOMParser !== 'undefined') {
      return new DOMParser().parseFromString(xmlText, 'text/xml');
    }
    throw new Error('XML parser unavailable');
  }

  function colLettersToIndex(ref) {
    const match = /^([A-Z]+)/i.exec(ref || '');
    if (!match) return -1;
    const letters = match[1].toUpperCase();
    let idx = 0;
    for (let i = 0; i < letters.length; i++) {
      idx = idx * 26 + (letters.charCodeAt(i) - 64);
    }
    return idx - 1;
  }

  function excelSerialToString(serial) {
    const num = Number(serial);
    if (!Number.isFinite(num) || num < 20000 || num > 80000) return String(serial);
    const ms = Math.round((num - 25569) * 86400 * 1000);
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return (
      d.getUTCFullYear() +
      '-' +
      p(d.getUTCMonth() + 1) +
      '-' +
      p(d.getUTCDate()) +
      ' ' +
      p(d.getUTCHours()) +
      ':' +
      p(d.getUTCMinutes()) +
      ':' +
      p(d.getUTCSeconds())
    );
  }

  function parseSharedStringsDom(xmlText) {
    if (!xmlText) return [];
    const doc = parseXml(xmlText);
    const siNodes = doc.getElementsByTagName('si');
    const list = [];
    for (let i = 0; i < siNodes.length; i++) {
      const tNodes = siNodes[i].getElementsByTagName('t');
      let s = '';
      for (let j = 0; j < tNodes.length; j++) {
        s += tNodes[j].textContent || '';
      }
      list.push(s);
    }
    return list;
  }

  function parseWorksheetDom(xmlText, sharedStrings) {
    const doc = parseXml(xmlText);
    const rowNodes = doc.getElementsByTagName('row');
    const rows = [];
    for (let i = 0; i < rowNodes.length; i++) {
      const rowNode = rowNodes[i];
      const cells = rowNode.getElementsByTagName('c');
      const rowArr = [];
      let fallbackCol = 0;
      for (let j = 0; j < cells.length; j++) {
        const c = cells[j];
        const ref = c.getAttribute('r') || '';
        let colIdx = colLettersToIndex(ref);
        if (colIdx < 0) colIdx = fallbackCol;
        fallbackCol = colIdx + 1;

        const cType = c.getAttribute('t') || '';
        let val = '';
        if (cType === 's') {
          const vNode = c.getElementsByTagName('v')[0];
          const sIdx = vNode ? parseInt(vNode.textContent || '0', 10) : 0;
          val = sharedStrings[sIdx] ?? '';
        } else if (cType === 'inlineStr') {
          const tNodes = c.getElementsByTagName('t');
          for (let k = 0; k < tNodes.length; k++) {
            val += tNodes[k].textContent || '';
          }
        } else if (cType === 'str' || cType === 'b' || cType === 'e') {
          const vNode = c.getElementsByTagName('v')[0];
          val = vNode ? vNode.textContent || '' : '';
        } else {
          const vNode = c.getElementsByTagName('v')[0];
          val = vNode ? vNode.textContent || '' : '';
        }
        while (rowArr.length <= colIdx) rowArr.push('');
        rowArr[colIdx] = val;
      }
      rows.push(rowArr);
    }
    return rows;
  }

  // Fallback lightweight XML extraction for headless Node tests without DOMParser
  function decodeXmlEntities(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  function parseSharedStringsRegex(xmlText) {
    if (!xmlText) return [];
    const list = [];
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xmlText)) !== null) {
      const inner = m[1];
      let text = '';
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let tm;
      while ((tm = tRe.exec(inner)) !== null) {
        text += decodeXmlEntities(tm[1]);
      }
      list.push(text);
    }
    return list;
  }

  function parseWorksheetRegex(xmlText, sharedStrings) {
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xmlText)) !== null) {
      const rowContent = rm[1];
      const rowArr = [];
      let fallbackCol = 0;
      const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(rowContent)) !== null) {
        const attrs = cm[1] || '';
        const body = cm[2] || '';
        const rMatch = /\br="([^"]+)"/.exec(attrs);
        const tMatch = /\bt="([^"]+)"/.exec(attrs);
        let colIdx = colLettersToIndex(rMatch ? rMatch[1] : '');
        if (colIdx < 0) colIdx = fallbackCol;
        fallbackCol = colIdx + 1;
        const cType = tMatch ? tMatch[1] : '';
        let val = '';
        if (cType === 's') {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
          val = sharedStrings[vm ? parseInt(vm[1], 10) : 0] ?? '';
        } else if (cType === 'inlineStr') {
          const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
          let tm;
          while ((tm = tRe.exec(body)) !== null) {
            val += decodeXmlEntities(tm[1]);
          }
        } else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
          val = vm ? decodeXmlEntities(vm[1]) : '';
        }
        while (rowArr.length <= colIdx) rowArr.push('');
        rowArr[colIdx] = val;
      }
      rows.push(rowArr);
    }
    return rows;
  }

  async function parseXlsxRows(arrayBuffer) {
    const { entries, readEntryText } = await unzipEntries(arrayBuffer);
    const sharedXml = await readEntryText('xl/sharedStrings.xml');
    let sheetName = 'xl/worksheets/sheet1.xml';
    if (!entries.has(sheetName)) {
      for (const k of entries.keys()) {
        if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(k)) {
          sheetName = k;
          break;
        }
      }
    }
    const sheetXml = await readEntryText(sheetName);
    if (!sheetXml) {
      throw new Error('在 .xlsx 中未找到工作表数据');
    }

    const useDom = typeof DOMParser !== 'undefined';
    const sharedStrings = useDom
      ? parseSharedStringsDom(sharedXml)
      : parseSharedStringsRegex(sharedXml);
    const rawRows = useDom
      ? parseWorksheetDom(sheetXml, sharedStrings)
      : parseWorksheetRegex(sheetXml, sharedStrings);

    return rawRows;
  }

  const api = { parseXlsxRows, excelSerialToString };
  global.QZXlsx = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
