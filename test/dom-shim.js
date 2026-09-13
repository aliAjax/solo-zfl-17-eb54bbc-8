/*
 * dom-shim.js —— 极简 DOM 垫片（仅 Node 走查用，不参与浏览器运行）
 * 提供：HTML 解析、#id/.class/tag/[attr] 选择器、事件冒泡与委托、
 * innerHTML 重解析、FormData、FileReader/Blob/URL 存根。
 */
"use strict";

const VOID_TAGS = new Set(("AREA BASE BR COL EMBED HR IMG INPUT LINK META SOURCE TRACK WBR").split(" "));
const FORM_FIELDS = new Set(("INPUT SELECT TEXTAREA").split(" "));
const RAW_TAGS = new Set(("SCRIPT STYLE").split(" "));

let NODE_SEQ = 0;

class Node {
  constructor(tag) {
    this.tagName = (tag || "").toUpperCase();
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this._text = null;
    this._listeners = {};
    this._onclick = null;
    this.style = {};
    this.dataset = {};
    this.files = [];
    this._value = null;
    this.checked = false;
    this.disabled = false;
    this.options = null;
    this.seq = ++NODE_SEQ;
  }

  get id() { return this.attrs.id || ""; }
  set id(v) { this.attrs.id = v; }
  get className() { return this.attrs["class"] || ""; }
  set className(v) { this.attrs["class"] = v; }
  get type() { return (this.attrs.type || "").toLowerCase(); }
  set type(v) { this.attrs.type = v; }
  get name() { return this.attrs.name || ""; }
  get src() { return this.attrs.src || ""; }
  set src(v) { this.attrs.src = v; }
  get href() { return this.attrs.href || ""; }
  set href(v) { this.attrs.href = v; }
  get disabled() { return this._disabled; }
  set disabled(v) { this._disabled = !!v; if (v) this.attrs.disabled = ""; else delete this.attrs.disabled; }
  get checked() { return this._checked; }
  set checked(v) { this._checked = !!v; if (v) this.attrs.checked = ""; else delete this.attrs.checked; }
  get files() { return this._files || []; }
  set files(v) { this._files = v; }
  get onclick() { return this._onclick; }
  set onclick(fn) { this._onclick = fn; }

  get classList() {
    const self = this;
    const api = {
      contains(c) { return (self.attrs["class"] || "").split(/\s+/).includes(c); },
      add(...cs) { const s = new Set((self.attrs["class"] || "").split(/\s+/).filter(Boolean)); cs.forEach((c) => s.add(c)); self.attrs["class"] = [...s].join(" "); },
      remove(...cs) { const s = new Set((self.attrs["class"] || "").split(/\s+/).filter(Boolean)); cs.forEach((c) => s.delete(c)); self.attrs["class"] = [...s].join(" "); },
      toggle(c, force) {
        const has = api.contains(c);
        if (force === true || (force === undefined && !has)) api.add(c);
        else api.remove(c);
      }
    };
    return api;
  }

  appendChild(c) { this.children.push(c); c.parentNode = this; this.doc && this.doc._index(c); return c; }
  remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }
  removeChild(c) { c.remove(); return c; }

  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((x) => x !== fn); }

  dispatch(eventLike) { return dispatchEvent(this, eventLike); }
  click(init) { return dispatchEvent(this, { type: "click", ...(init || {}) }); }

  querySelector(sel) { return querySubtree(this, sel)[0] || null; }
  querySelectorAll(sel) { return querySubtree(this, sel); }
  getElementsByTagName(tag) { return querySubtree(this, tag); }
  closest(sel) {
    let n = this;
    while (n && n.tagName !== "DOCUMENT") { if (matches(n, sel)) return n; n = n.parentNode; }
    return null;
  }
  contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parentNode; } return false; }

  get innerHTML() { return this.children.map(serialize).join(""); }
  set innerHTML(markup) {
    this.children = [];
    this._text = null;
    const nodes = parseFragment(String(markup == null ? "" : markup), this.doc);
    for (const n of nodes) { this.children.push(n); n.parentNode = this; }
    if (this.doc) this.doc._reindex();
    if (this.tagName === "SELECT") syncSelect(this);
  }

  get textContent() {
    if (this._text != null) return this._text;
    return this.children.map((c) => (c.tagName === "#TEXT" ? c._text : c.textContent)).join("");
  }
  set textContent(v) { this.children = []; this._text = String(v == null ? "" : v); const t = new Node("#text"); t._text = this._text; t.parentNode = this; if (this.doc) this.doc._reindex(); }

  get value() {
    if (this.tagName === "SELECT") return this._value == null ? "" : this._value;
    if (this.tagName === "TEXTAREA") return this._value != null ? this._value : this.textContent;
    return this._value != null ? this._value : this.attrs.value || "";
  }
  set value(v) {
    const s = v == null ? "" : String(v);
    if (this.tagName === "TEXTAREA") {
      // 与真实浏览器一致：设置 value 即覆盖默认内容
      this._value = s;
      this.children = [];
      if (s) { const t = new Node("#text"); t._text = s; t.parentNode = this; this.children.push(t); }
      return;
    }
    this._value = s;
    this.attrs.value = s;
    if (this.tagName === "SELECT") syncSelect(this, s);
  }

  focus() {}
  blur() {}
  reset() {
    for (const f of this.querySelectorAll("input,select,textarea")) {
      if (f.type === "checkbox" || f.type === "radio") f.checked = !!f.attrs._defaultChecked;
      else f.value = f.attrs.value != null ? f.attrs.value : "";
    }
  }
}

function syncSelect(sel, force) {
  const opts = sel.querySelectorAll("option");
  const vals = opts.map((o) => (o.attrs.value != null ? o.attrs.value : o.textContent.trim()));
  if (force != null && vals.includes(force)) {
    sel._value = force;
    return;
  }
  if (vals.includes(sel._value)) return;
  const marked = opts.find((o) => "selected" in o.attrs);
  sel._value = marked ? (marked.attrs.value != null ? marked.attrs.value : marked.textContent.trim()) : vals[0] || "";
}

function serialize(n) {
  if (n.tagName === "#TEXT") return n._text;
  return `<${n.tagName.toLowerCase()}>`;
}

/* ============================== 事件 ============================== */

function dispatchEvent(target, ev) {
  ev.target = target;
  ev.preventDefault = ev.preventDefault || (() => { ev.defaultPrevented = true; });
  ev.stopPropagation = ev.stopPropagation || (() => { ev._stopped = true; });
  let n = target;
  while (n) {
    ev.currentTarget = n;
    for (const fn of n._listeners[ev.type] || []) fn.call(n, ev);
    if (ev.type === "click" && n._onclick) n._onclick.call(n, ev);
    if (ev._stopped) break;
    n = n.parentNode;
  }
  return !ev.defaultPrevented;
}

/* ============================== HTML 解析 ============================== */

function parseFragment(html, doc) {
  const roots = [];
  const stack = [];
  let i = 0;
  const top = () => stack[stack.length - 1];
  const addText = (t) => {
    if (!t) return;
    const tn = new Node("#text");
    tn._text = t;
    tn.doc = doc;
    if (stack.length) { const p = top(); p.children.push(tn); tn.parentNode = p; }
    else roots.push(tn);
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { addText(html.slice(i)); break; }
    if (lt > i) addText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt + 4); i = e === -1 ? html.length : e + 3; continue; }
    if (html[lt + 1] === "!") { const e = html.indexOf(">", lt); i = e === -1 ? html.length : e + 1; continue; }
    const gt = findGt(html, lt);
    if (gt === -1) { addText(html.slice(lt)); break; }
    const token = html.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!token) continue;
    if (token[0] === "/") {
      const name = token.slice(1).split(/[\s>]/)[0].toUpperCase();
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].tagName === name) { stack.length = k; break; }
      continue;
    }
    const selfClose = token.endsWith("/");
    const head = selfClose ? token.slice(0, -1).trim() : token;
    const pm = /^([a-zA-Z][\w-]*)([\s\S]*)$/.exec(head);
    if (!pm) continue;
    const tag = pm[1].toUpperCase();

    if (RAW_TAGS.has(tag)) {
      const el = new Node(tag);
      el.doc = doc;
      const re = new RegExp(`</${tag}\\s*>`, "i");
      const m = re.exec(html.slice(i));
      const raw = m ? html.slice(i, i + m.index) : html.slice(i);
      const tn = new Node("#text");
      tn._text = raw;
      el.children.push(tn);
      tn.parentNode = el;
      if (m) i += m.index + m[0].length;
      else i = html.length;
      place(el);
      continue;
    }

    const el = new Node(tag);
    el.doc = doc;
    parseAttrs(pm[2], el);
    if (tag === "SELECT") {
      // select 的初值交给 postWalk 阶段按 selected 属性/首项决定
      el._value = null;
    } else if (tag === "INPUT") {
      el._value = el.attrs.value != null ? el.attrs.value : "";
    }
    place(el);
    if (VOID_TAGS.has(tag) || selfClose) {
      if (tag === "SELECT") syncSelect(el);
    } else stack.push(el);

    function place(el) {
      if (stack.length) { const p = top(); p.children.push(el); el.parentNode = p; }
      else roots.push(el);
    }
  }
  postWalk(roots);
  return roots;
}

function postWalk(nodes) {
  for (const n of nodes) {
    for (const k of Object.keys(n.attrs)) if (k.startsWith("data-")) n.dataset[camel(k.slice(5))] = n.attrs[k];
    if (n.tagName === "SELECT") syncSelect(n);
    if (n.tagName === "INPUT" && n.attrs.checked != null) n._checked = true;
    if ("disabled" in n.attrs) n._disabled = true;
    postWalk(n.children);
  }
}

function findGt(html, from) {
  let q = null;
  for (let i = from + 1; i < html.length; i++) {
    const ch = html[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ">") return i;
  }
  return -1;
}

function parseAttrs(rest, el) {
  const re = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+)))?/g;
  let m;
  while ((m = re.exec(rest))) el.attrs[m[1].toLowerCase()] = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : "";
}

function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

/* ============================== 选择器 ============================== */

function walkAll(node, fn) {
  for (const c of node.children) {
    if (c.tagName !== "#TEXT") fn(c);
    walkAll(c, fn);
  }
}

function querySubtree(root, selector) {
  const out = [];
  walkAll(root, (el) => { if (matches(el, selector)) out.push(el); });
  return out;
}

function matches(el, selector) {
  return selector.split(",").map((s) => s.trim()).some((sel) => matchComplex(el, sel.trim()));
}

function matchComplex(el, sel) {
  // 支持后代组合子（空格）：a b c —— 最后一段匹配 el，其余依次向上找严格祖先
  const parts = sel.split(/\s+/).filter(Boolean).map(matchCompound);
  if (parts.some((p) => !p)) return false;
  if (!parts[parts.length - 1](el)) return false;
  let node = el;
  for (let pi = parts.length - 2; pi >= 0; pi--) {
    const anc = findStrictAncestor(node, parts[pi]);
    if (!anc) return false;
    node = anc;
  }
  return true;
}
function findStrictAncestor(start, test) {
  let n = start.parentNode;
  while (n && n.tagName !== "DOCUMENT") {
    if (test(n)) return n;
    n = n.parentNode;
  }
  return null;
}
function matchCompound(sel) {
  // tag#id.cls[a="b"][c]
  const ops = [];
  let i = 0;
  if (/^[a-zA-Z][\w-]*/.test(sel)) {
    const t = /^[a-zA-Z][\w-]*/.exec(sel)[0].toUpperCase();
    ops.push((el) => el.tagName === t);
    i += t.length;
  }
  while (i < sel.length) {
    const ch = sel[i];
    let m;
    if (ch === ".") {
      m = /^\.([\w-]+)/.exec(sel.slice(i));
      if (!m) return null;
      const cls = m[1];
      ops.push((el) => el.classList.contains(cls));
      i += m[0].length;
    } else if (ch === "#") {
      m = /^#([\w-]+)/.exec(sel.slice(i));
      if (!m) return null;
      const idv = m[1];
      ops.push((el) => el.id === idv);
      i += m[0].length;
    } else if (ch === "[") {
      m = /^\[([\w-]+)(?:([~^$|*]?=)("([^"]*)"|'([^']*)'|([^\]]+)))?\]/.exec(sel.slice(i));
      if (!m) return null;
      const name = m[1];
      const op = m[2] || "";
      const v = m[4] != null ? m[4] : m[5] != null ? m[5] : m[6];
      ops.push((el) => {
        if (!(name in el.attrs)) return false;
        if (!op) return true;
        const av = el.attrs[name] == null ? "" : el.attrs[name];
        if (op === "=") return av === v;
        if (op === "^=") return av.startsWith(v);
        if (op === "$=") return av.endsWith(v);
        if (op === "*=") return av.includes(v);
        if (op === "~=") return av.split(/\s+/).includes(v);
        return true;
      });
      i += m[0].length;
    } else if (ch === ":") {
      m = /^:([\w-]+)(?:\(([^)]*)\))?/.exec(sel.slice(i));
      if (!m) return null;
      const pseudo = m[1];
      const arg = m[2];
      if (pseudo === "checked") ops.push((el) => el.checked);
      else if (pseudo === "disabled") ops.push((el) => el.disabled);
      else if (pseudo === "first-child") ops.push((el) => el.parentNode && el.parentNode.children.filter((c) => c.tagName !== "#TEXT")[0] === el);
      else if (pseudo === "not") {
        const inner = matchCompound(arg);
        if (!inner) return null;
        ops.push((el) => !inner(el));
      } else return null;
      i += m[0].length;
    } else if (ch === "*") {
      i += 1;
    } else return null;
  }
  return (el) => ops.every((f) => f(el));
}

/* ============================== Document ============================== */

class Document {
  constructor(html, win) {
    this.win = win;
    this.tagName = "DOCUMENT";
    this.parentNode = null;
    this.children = [];
    this._listeners = {};
    this._byId = new Map();
    this._load(html);
  }
  _load(html) {
    this.children = parseFragment(html, this);
    for (const r of this.children) r.parentNode = this;
    this._reindex();
    this.body = this.querySelector("body");
    this.head = this.querySelector("head");
    this.documentElement = this.querySelector("html") || this;
  }
  _reindex() {
    this._byId.clear();
    walkAll(this, (el) => { if (el.id) this._byId.set(el.id, el); });
  }
  _index(el) { if (el.id && !this._byId.has(el.id)) this._byId.set(el.id, el); walkAll(el, (x) => x.id && !this._byId.has(x.id) && this._byId.set(x.id, x)); }
  querySelector(sel) {
    if (/^#[\w-]+$/.test(sel)) return this._byId.get(sel.slice(1)) || null;
    return querySubtree(this, sel)[0] || null;
  }
  querySelectorAll(sel) { return querySubtree(this, sel); }
  getElementById(id) { return this._byId.get(id) || null; }
  createElement(tag) { const el = new Node(tag); el.doc = this; return el; }
  createTextNode(t) { const n = new Node("#text"); n._text = t; return n; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this._listeners[t] = (this._listeners[t] || []).filter((x) => x !== fn); }
  closest() { return null; }
}

/* ============================== FormData / 其他 Web API ============================== */

class FormData {
  constructor(form) {
    this._entries = [];
    if (form) {
      for (const f of form.querySelectorAll("input,select,textarea")) {
        if (!f.name) continue;
        if ((f.type === "checkbox" || f.type === "radio")) { if (f.checked) this._entries.push([f.name, f.value]); }
        else this._entries.push([f.name, f.value]);
      }
    }
  }
  append(k, v) { this._entries.push([k, String(v)]); }
  get(k) { const e = this._entries.find((x) => x[0] === k); return e ? e[1] : null; }
  getAll(k) { return this._entries.filter((x) => x[0] === k).map((x) => x[1]); }
  forEach(fn) { for (const [k, v] of this._entries) fn(v, k); }
  entries() { return this._entries[Symbol.iterator](); }
}

class ShimFileReader {
  readAsDataURL(file) { setTimeout(() => { this.result = file && file.dataUrl ? file.dataUrl : "data:application/octet-stream;base64,"; this.onload && this.onload({ target: this }); }, 0); }
  readAsText(file) { setTimeout(() => { this.result = file && file.text != null ? file.text : ""; this.onload && this.onload({ target: this }); }, 0); }
}
class ShimBlob {
  constructor(parts, opts) { this.parts = parts || []; this.options = opts || {}; this.type = this.options.type || ""; this.size = this.parts.reduce((a, p) => a + String(p).length, 0); }
}
const ShimURL = {
  createObjectURL() { return "blob:shim/" + Math.random().toString(36).slice(2); },
  revokeObjectURL() {}
};

module.exports = { Node, Document, FormData, ShimFileReader, ShimBlob, ShimURL, dispatchEvent, parseFragment, matches, querySubtree };
