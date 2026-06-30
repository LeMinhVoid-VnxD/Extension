'use strict';

// ============================================================
//  STATE
// ============================================================
const STATE = {
  container: null,
  originalHTML: '',
  translatedHTML: '',
  mode: 'original',
  lang: 'vi',
  busy: false,
};

const LANG_LABEL = {
  vi: 'VI', en: 'EN', zh: '中文', hi: 'हिन्दी',
  ru: 'RU', ja: 'JA', ko: 'KO', fr: 'FR',
  de: 'DE', pt: 'PT', ar: 'AR', bn: 'BN',
};

// ============================================================
//  MATH & CODE PRESERVATION
// ============================================================
const MATH_RE = /\$\$\$([\s\S]+?)\$\$\$|\$\$([\s\S]+?)\$\$|\$([\s\S]+?)\$|\\\(([\s\S]+?)\\\)/g;
const ORDINAL_RE = /\b([a-z])-(?:th|st|nd|rd)\b/g;
const SUBSCRIPT_RE = /\b[a-zA-Z]+_(?:[a-zA-Z0-9]|\{[^}]*\})/g;
const CP_VAR_RE = /\b([b-z])\b/g;
const A_VAR_RE = /\b(a)\b(?=[.,;:)\]}=!?]|\s+[+\-*/%^=<>!]|$)/g;
const MATH_MARK = /<<<M(\d+)>>>/g;

function preserveMath(text) {
  const blocks = [];

  let cleaned = text
    .replace(/(\s*)(?:\$\$\$[\s\S]+?\$\$\$|\$\$[\s\S]+?\$\$|\$[\s\S]+?\$|\\\([\s\S]+?\\\))(\s*)/g, (m, pre, post) => {
      blocks.push(pre + m.trim() + post);
      return '<<<M' + (blocks.length - 1) + '>>>';
    })
    .replace(ORDINAL_RE, (m) => {
      blocks.push(m);
      return '<<<M' + (blocks.length - 1) + '>>>';
    })
    .replace(SUBSCRIPT_RE, (m) => {
      blocks.push(m);
      return '<<<M' + (blocks.length - 1) + '>>>';
    })
    .replace(A_VAR_RE, (m) => {
      blocks.push(m);
      return '<<<M' + (blocks.length - 1) + '>>>';
    })
    .replace(CP_VAR_RE, (m) => {
      blocks.push(m);
      return '<<<M' + (blocks.length - 1) + '>>>';
    });

  return { cleaned, blocks };
}

function restoreMath(text, blocks) {
  return text.replace(MATH_MARK, (_, i) => blocks[+i] || '');
}

// ============================================================
//  DOM HELPERS
// ============================================================
function shouldSkip(el) {
  return el.matches && el.matches(
    'code, pre, .tex-math, .tex-graphics, .tex-string, cf-math'
  );
}

function isInsideSkipped(node) {
  let el = node.parentElement;
  while (el) {
    if (shouldSkip(el)) return true;
    el = el.parentElement;
  }
  return false;
}

function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.textContent.trim()) return NodeFilter.FILTER_SKIP;
      if (isInsideSkipped(n)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

// ============================================================
//  TRANSLATION API
// ============================================================
async function transGoogle(text, lang) {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    '?client=gtx&sl=auto&tl=' + encodeURIComponent(lang) +
    '&dt=t&q=' + encodeURIComponent(text);
  const r = await fetch(url);
  if (!r.ok) throw new Error('Google HTTP ' + r.status);
  const d = await r.json();
  if (!d || !d[0]) throw new Error('Bad Google response');
  return d[0].map((s) => s[0] || '').join('');
}

async function transMyMemory(text, lang) {
  const url =
    'https://api.mymemory.translated.net/get' +
    '?q=' + encodeURIComponent(text) +
    '&langpair=en%7C' + encodeURIComponent(lang);
  const r = await fetch(url);
  if (!r.ok) throw new Error('MyMemory HTTP ' + r.status);
  const d = await r.json();
  if (d.responseStatus === 200 && d.responseData) {
    return d.responseData.translatedText || text;
  }
  throw new Error('MyMemory status ' + d.responseStatus);
}

async function translateOne(text, lang) {
  if (!text.trim()) return text;
  const { cleaned, blocks } = preserveMath(text);
  if (!cleaned.trim()) return text;
  try {
    const r = await transGoogle(cleaned, lang);
    return restoreMath(r, blocks);
  } catch (e1) {
    try {
      const r = await transMyMemory(cleaned, lang);
      return restoreMath(r, blocks);
    } catch {
      return text;
    }
  }
}

// ============================================================
//  BATCH TRANSLATION
// ============================================================
const CONCURRENCY = 5;

async function translateAll(texts, lang) {
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i += CONCURRENCY) {
    const batch = [];
    const idxs = [];
    for (let j = i; j < Math.min(i + CONCURRENCY, texts.length); j++) {
      idxs.push(j);
      batch.push(translateOne(texts[j], lang).catch(() => texts[j]));
    }
    const res = await Promise.all(batch);
    for (let k = 0; k < res.length; k++) out[idxs[k]] = res[k];
  }
  return out;
}

// ============================================================
//  CORE TRANSLATE
// ============================================================
async function doTranslate() {
  if (STATE.busy) return;
  STATE.busy = true;
  renderToolbar();

  try {
    // Global pass: extract math delimiters across entire HTML (handles
    // formulas spanning element boundaries, e.g. $$$...$$$ across text nodes)
    const mathBlocks = [];
    const safeHTML = STATE.originalHTML.replace(
      /(\s*)(?:\$\$\$[\s\S]+?\$\$\$|\$\$[\s\S]+?\$\$|\$[\s\S]+?\$|\\\([\s\S]+?\\\))(\s*)/g,
      (m, pre, post) => {
        mathBlocks.push(pre + m.trim() + post);
        return '<cf-math data-i="' + (mathBlocks.length - 1) + '"></cf-math>';
      }
    );

    const tmp = document.createElement('div');
    tmp.innerHTML = safeHTML;
    const nodes = collectTextNodes(tmp);

    if (nodes.length === 0) {
      STATE.translatedHTML = STATE.originalHTML;
    } else {
      const texts = nodes.map((n) => n.textContent);
      const translated = await translateAll(texts, STATE.lang);
      nodes.forEach((n, i) => { n.textContent = translated[i]; });
      // Restore global math markers
      STATE.translatedHTML = tmp.innerHTML.replace(
        /<cf-math[^>]*data-i="(\d+)"[^>]*><\/cf-math>/g,
        (_, i) => mathBlocks[+i] || ''
      );
    }
  } catch (err) {
    console.error('[CF Translator]', err);
    STATE.translatedHTML = STATE.originalHTML;
  }

  STATE.busy = false;
  renderToolbar();
  applyMode();
}

// ============================================================
//  MODE MANAGEMENT
// ============================================================
function applyMode() {
  if (!STATE.container) return;
  const m = STATE.mode;
  const t = STATE.translatedHTML || STATE.originalHTML;

  if (m === 'original') {
    STATE.container.innerHTML = STATE.originalHTML;
  } else if (m === 'translated') {
    STATE.container.innerHTML = t;
  } else if (m === 'dual') {
    STATE.container.innerHTML =
      '<div style="margin-bottom:16px;">' + STATE.originalHTML + '</div>' +
      '<hr style="margin:16px 0;border:none;border-top:2px dashed #b0c4de;">' +
      '<div>' + t + '</div>';
  }
  renderToolbar();
}

async function setMode(mode) {
  STATE.mode = mode;
  if ((mode === 'translated' || mode === 'dual') && !STATE.translatedHTML) {
    await doTranslate();
  } else {
    applyMode();
  }
}

// ============================================================
//  TOOLBAR UI
// ============================================================
function btnStyle(active) {
  return active
    ? 'padding:4px 14px;border:1px solid #3b5998;border-radius:4px;cursor:pointer;background:#3b5998;color:#fff;font:13px/1.4 Arial,sans-serif;font-weight:600;'
    : 'padding:4px 14px;border:1px solid #b0c4de;border-radius:4px;cursor:pointer;background:#fff;color:#333;font:13px/1.4 Arial,sans-serif;';
}

function renderToolbar() {
  const bar = document.getElementById('cf-bar');
  if (!bar) return;

  const label = LANG_LABEL[STATE.lang] || STATE.lang.toUpperCase();
  const status = STATE.busy ? '\u23F3 Translating\u2026' : '\u2713';

  bar.innerHTML =
    '<span style="font-weight:700;color:#3b5998;margin-right:8px;font-size:14px;">\uD83C\uDF10 CF Translator</span>' +
    '<button class="cf-btn" data-mode="original" style="' + btnStyle(STATE.mode === 'original') + '">Original</button>' +
    '<button class="cf-btn" data-mode="translated" style="' + btnStyle(STATE.mode === 'translated') + '">' + label + '</button>' +
    '<button class="cf-btn" data-mode="dual" style="' + btnStyle(STATE.mode === 'dual') + '">Dual</button>' +
    '<span style="margin-left:auto;color:#888;font-size:12px;">' + status + '</span>';
}

function injectToolbar() {
  const old = document.getElementById('cf-bar');
  if (old) old.remove();

  const bar = document.createElement('div');
  bar.id = 'cf-bar';
  bar.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:8px 12px;' +
    'background:#f0f4ff;border:1px solid #b0c4de;border-radius:6px;' +
    'margin-bottom:12px;font:13px/1.4 Arial,sans-serif;';

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn) setMode(btn.dataset.mode);
  });

  STATE.container.parentNode.insertBefore(bar, STATE.container);
  renderToolbar();
}

// ============================================================
//  INIT
// ============================================================
function init() {
  STATE.container = document.querySelector('.problem-statement');
  if (!STATE.container) return;

  STATE.originalHTML = STATE.container.innerHTML;

  const style = document.createElement('style');
  style.textContent = '.cf-btn:active{opacity:.8}';
  document.head.appendChild(style);

  chrome.storage.local.get('targetLang', (res) => {
    if (res.targetLang) STATE.lang = res.targetLang;
    injectToolbar();
  });
}

// ============================================================
//  MESSAGING (from popup)
// ============================================================
chrome.runtime.onMessage.addListener((req, _, send) => {
  if (req.action === 'setLang') {
    STATE.lang = req.lang;
    STATE.translatedHTML = '';
    if (STATE.mode !== 'original') {
      setMode(STATE.mode);
    } else {
      renderToolbar();
    }
    send({ ok: true });
  }
  return true;
});

// ============================================================
//  BOOT
// ============================================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
