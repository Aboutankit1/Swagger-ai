import express from 'express';
import yaml from 'js-yaml';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetch, Agent, FormData } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // local only by default (this app can call any URL you give it)
const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

export const app = express();
app.disable('x-powered-by');

/* -------------------------------------------------------------------------- */
/*  Hardening: headers, optional password, rate limit                         */
/* -------------------------------------------------------------------------- */

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  next();
});

// Set APP_PASSWORD (and optionally APP_USER) to put the whole app behind HTTP Basic auth.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const APP_USER = process.env.APP_USER || 'admin';
const safeEq = (a, b) => {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
app.use((req, res, next) => {
  if (!APP_PASSWORD || req.path === '/api/health') return next();
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    if (safeEq(u, APP_USER) && safeEq(p.join(':'), APP_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Swagger AI Tester"').status(401).send('Authentication required');
});

const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 600);
const hits = new Map();
app.use('/api', (req, res, next) => {
  const now = Date.now();
  let e = hits.get(req.ip);
  if (!e || now - e.t > 60000) {
    e = { t: now, n: 0 };
    hits.set(req.ip, e);
  }
  if (++e.n > RATE) return res.status(429).json({ error: 'Too many requests — please slow down.' });
  next();
});
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of hits) if (now - e.t > 60000) hits.delete(k);
}, 60000).unref();

app.use(express.json({ limit: '8mb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '1h',
    setHeaders: (res, p) => {
      if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

/* -------------------------------------------------------------------------- */
/*  HTTP helpers                                                              */
/* -------------------------------------------------------------------------- */

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

function isLocalHost(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

// Self-signed dev certificates (e.g. .NET https://localhost:7xxx) are accepted for local hosts,
// or for anything when the user explicitly turns the option on.
function dispatcherFor(url, insecure) {
  return insecure || isLocalHost(url) ? insecureAgent : undefined;
}

// Localhost and private networks are allowed on purpose (that is the main use case),
// but http(s) only, and never cloud metadata endpoints.
function assertTarget(u) {
  let x;
  try {
    x = new URL(u);
  } catch {
    throw new Error('That URL is not valid.');
  }
  if (!/^https?:$/.test(x.protocol)) throw new Error('Only http / https URLs are allowed.');
  const h = x.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h.startsWith('169.254.') || h === 'metadata.google.internal' || h === 'fd00:ec2::254' || h === '100.100.100.200') {
    throw new Error('This address is blocked (cloud metadata).');
  }
  return x;
}

async function getText(url, insecure, headers = {}) {
  assertTarget(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      dispatcher: dispatcherFor(url, insecure),
      headers: { accept: 'application/json, application/yaml, text/yaml, text/html, */*', ...headers },
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text, ct: r.headers.get('content-type') || '', url: r.url || url };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/*  Spec discovery                                                            */
/* -------------------------------------------------------------------------- */

const CANDIDATES = [
  '/v3/api-docs',
  '/v3/api-docs/swagger-config',
  '/swagger-ui/swagger-config',
  '/openapi.json',
  '/swagger.json',
  '/v2/api-docs',
  '/api-docs',
  '/api-docs/swagger.json',
  '/swagger/v1/swagger.json',
  '/swagger/v2/swagger.json',
  '/swagger/docs/v1',
  '/api/swagger.json',
  '/api/openapi.json',
  '/api/v1/openapi.json',
  '/api/v3/openapi.json',
  '/docs/openapi.json',
  '/openapi.yaml',
  '/swagger.yaml',
  '/api-json',
  '/docs-json',
  '/swagger-json',
];

function parseSpec(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* not JSON */
  }
  try {
    const o = yaml.load(text);
    if (o && typeof o === 'object') return o;
  } catch {
    /* not YAML */
  }
  return null;
}

const isSpec = (o) => !!(o && (o.openapi || o.swagger) && o.paths && typeof o.paths === 'object');

// swagger-ui-express embeds the whole document as `"swaggerDoc": { ... }` inside swagger-ui-init.js
function extractEmbeddedDoc(text) {
  const i = text.search(/["']?swaggerDoc["']?\s*:\s*\{/);
  if (i < 0) return null;
  const start = text.indexOf('{', i);
  let depth = 0;
  let inStr = false;
  let q = '';
  let esc = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      q = c;
    } else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function linksFromHtmlOrJs(text, baseUrl) {
  const out = new Set();
  const add = (v) => {
    try {
      out.add(new URL(v, baseUrl).href);
    } catch {
      /* ignore */
    }
  };
  for (const m of text.matchAll(/["']?(?:url|configUrl|specUrl)["']?\s*[:=]\s*["']([^"']+)["']/g)) {
    if (/\.(json|ya?ml)(\?|$)|api-docs|openapi|swagger|swagger-config/i.test(m[1])) add(m[1]);
  }
  for (const m of text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    if (/init|config|initializer/i.test(m[1])) add(m[1]);
  }
  return [...out];
}

/**
 * Finds the OpenAPI / Swagger document(s) behind any pasted link.
 *
 * Important: links found inside a Swagger UI page are followed ONLY when they stay on the same
 * site. The stock swagger-initializer.js ships with the public petstore URL, and following that
 * would load the wrong API. Other-site links are kept as a last resort only.
 */
async function discoverSpec(input, insecure) {
  const start = new URL(input);
  start.hash = '';
  const origin = start.origin;
  const tried = new Set();
  const foreign = [];

  async function load(u, depth = 0, allowForeign = false) {
    const key = u.split('#')[0];
    if (tried.has(key) || depth > 3) return null;
    tried.add(key);
    let r;
    try {
      r = await getText(key, insecure);
    } catch {
      return null;
    }
    if (!r.ok) return null;

    const parsed = parseSpec(r.text);
    if (isSpec(parsed)) return [{ spec: parsed, url: r.url }];

    // springdoc / swagger-ui config: { url } or { urls: [{ url, name }, ...] } (API groups)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const list = Array.isArray(parsed.urls) ? parsed.urls.map((x) => x && x.url).filter(Boolean) : typeof parsed.url === 'string' ? [parsed.url] : [];
      const out = [];
      for (const n of list.slice(0, 12)) {
        let abs;
        try {
          abs = new URL(n, r.url).href;
        } catch {
          continue;
        }
        if (!allowForeign && new URL(abs).origin !== origin) {
          foreign.push(abs);
          continue;
        }
        const hit = await load(abs, depth + 1, allowForeign);
        if (hit) out.push(...hit);
      }
      return out.length ? out : null;
    }

    const embedded = extractEmbeddedDoc(r.text);
    if (isSpec(embedded)) return [{ spec: embedded, url: r.url }];

    // HTML / JS: follow what it references
    for (const link of linksFromHtmlOrJs(r.text, r.url)) {
      if (new URL(link).origin !== origin && !allowForeign) {
        foreign.push(link);
        continue;
      }
      const hit = await load(link, depth + 1, allowForeign);
      if (hit) return hit;
    }
    return null;
  }

  let hit = await load(start.href);
  if (hit) return { specs: hit, foreign: false };

  // Guess the usual locations on the same site (and under the context path of the pasted URL)
  const segs = start.pathname.split('/').filter(Boolean);
  if (segs.length && segs[segs.length - 1].includes('.')) segs.pop();
  const bases = [origin];
  for (let i = 1; i <= segs.length; i++) bases.push(origin + '/' + segs.slice(0, i).join('/'));
  for (const b of bases) {
    for (let i = 0; i < CANDIDATES.length; i += 8) {
      const batch = CANDIDATES.slice(i, i + 8);
      const results = await Promise.all(batch.map((c) => load(b + c)));
      hit = results.find(Boolean);
      if (hit) return { specs: hit, foreign: false };
    }
  }

  // Last resort: a spec on another site that the page pointed at
  for (const f of [...new Set(foreign)]) {
    hit = await load(f, 0, true);
    if (hit) return { specs: hit, foreign: true };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  $ref resolving + schema sampling                                          */
/* -------------------------------------------------------------------------- */

function deref(node, root, stack = []) {
  if (Array.isArray(node)) return node.map((n) => deref(n, root, stack));
  if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
      const ref = node.$ref;
      if (stack.includes(ref)) return { type: 'object', description: `(circular: ${ref.split('/').pop()})` };
      const target = ref
        .slice(2)
        .split('/')
        .map((s) => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce((a, k) => (a == null ? a : a[k]), root);
      return deref(target ?? {}, root, [...stack, ref]);
    }
    const out = {};
    for (const k of Object.keys(node)) out[k] = deref(node[k], root, stack);
    return out;
  }
  return node;
}

function mergeAllOf(schema) {
  if (!schema || !Array.isArray(schema.allOf)) return schema;
  const merged = { ...schema };
  delete merged.allOf;
  for (const part of schema.allOf) {
    const p = mergeAllOf(part) || {};
    merged.type = merged.type || p.type;
    merged.properties = { ...(merged.properties || {}), ...(p.properties || {}) };
    merged.required = [...new Set([...(merged.required || []), ...(p.required || [])])];
  }
  return merged;
}

function sampleString(name, s) {
  const n = String(name || '').toLowerCase();
  const f = s.format;
  if (f === 'date-time') return new Date().toISOString();
  if (f === 'date') return new Date().toISOString().slice(0, 10);
  if (f === 'time') return '10:30:00';
  if (f === 'email' || n.includes('email')) return 'test.user@example.com';
  if (f === 'uuid' || n.endsWith('uuid')) return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  if (f === 'uri' || f === 'url' || n.includes('url') || n.includes('link')) return 'https://example.com';
  if (f === 'password' || n.includes('password') || n === 'pass') return 'Test@12345';
  if (f === 'byte') return 'dGVzdA==';
  if (f === 'binary') return 'file-content';
  if (n.includes('phone') || n.includes('mobile')) return '9876543210';
  if (n.includes('first')) return 'Aarav';
  if (n.includes('last') || n.includes('surname')) return 'Sharma';
  if (n.includes('username') || n === 'login') return 'testuser01';
  if (n.includes('name')) return 'Test Name';
  if (n.includes('city')) return 'Delhi';
  if (n.includes('country')) return 'India';
  if (n.includes('zip') || n.includes('pin') || n.includes('postal')) return '110001';
  if (n.includes('address')) return '12, MG Road, Delhi';
  if (n.includes('title')) return 'Sample title';
  if (n.includes('desc') || n.includes('comment') || n.includes('message')) return 'Sample text for testing';
  if (n.includes('status')) return 'active';
  const WORDS = [['department', 'Engineering'], ['company', 'Acme Corp'], ['organi', 'Acme Corp'], ['role', 'Developer'], ['designation', 'Software Engineer'], ['position', 'Software Engineer'],
    ['gender', 'Female'], ['state', 'Delhi'], ['street', 'MG Road'], ['category', 'General'], ['type', 'standard'], ['brand', 'Acme'], ['color', 'Blue'], ['colour', 'Blue'],
    ['language', 'English'], ['currency', 'INR'], ['note', 'Created by API test'], ['remark', 'Created by API test'], ['bio', 'Created by API test'], ['tag', 'test'], ['label', 'Sample label'],
    ['subject', 'Test subject'], ['reason', 'Created by API test'], ['code', 'TST001'], ['gst', '22AAAAA0000A1Z5'], ['pan', 'ABCDE1234F'], ['country', 'India']];
  const hit = WORDS.find(([k]) => n.includes(k));
  let v = hit ? hit[1] : n ? `Sample ${n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-]+/g, ' ').trim()}` : 'Sample text';
  if (s.minLength && v.length < s.minLength) v = v.padEnd(s.minLength, 'x');
  if (s.maxLength && v.length > s.maxLength) v = v.slice(0, s.maxLength);
  return v;
}

function sampleFromSchema(schema, name = '', depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;

  schema = mergeAllOf(schema);
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return sampleFromSchema(schema.oneOf[0], name, depth + 1);
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return sampleFromSchema(schema.anyOf[0], name, depth + 1);

  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type || (schema.properties ? 'object' : schema.items ? 'array' : 'string')) {
    case 'object': {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties || {})) {
        if (v && v.readOnly) continue;
        out[k] = sampleFromSchema(v, k, depth + 1);
      }
      if (!Object.keys(out).length && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        out.key = sampleFromSchema(schema.additionalProperties, 'key', depth + 1);
      }
      return out;
    }
    case 'array':
      return [sampleFromSchema(schema.items || {}, name, depth + 1)];
    case 'integer': {
      const n = String(name).toLowerCase();
      let v = n.endsWith('id') || n === 'id' ? 1 : n.includes('age') ? 25 : n.includes('page') ? 1 : n.includes('limit') || n.includes('size') ? 10 : 1;
      if (schema.minimum !== undefined && v < schema.minimum) v = schema.minimum;
      if (schema.maximum !== undefined && v > schema.maximum) v = schema.maximum;
      return v;
    }
    case 'number': {
      let v = String(name).toLowerCase().includes('price') || String(name).toLowerCase().includes('amount') ? 99.5 : 1.5;
      if (schema.minimum !== undefined && v < schema.minimum) v = schema.minimum;
      if (schema.maximum !== undefined && v > schema.maximum) v = schema.maximum;
      return v;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return sampleString(name, schema);
  }
}

function requiredNames(schema) {
  const s = mergeAllOf(schema) || {};
  return Array.isArray(s.required) ? s.required : [];
}

/* -------------------------------------------------------------------------- */
/*  Unique data: {{email}}, {{username}}, {{phone}} ... resolved on every run  */
/* -------------------------------------------------------------------------- */

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Ayaan', 'Krishna', 'Ishaan', 'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Myra', 'Anika', 'Kavya', 'Riya', 'Meera', 'Priya'];
const LAST = ['Sharma', 'Verma', 'Gupta', 'Singh', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Mehta', 'Joshi', 'Kapoor', 'Malhotra', 'Bose', 'Das', 'Khan'];
const pick = (a) => a[crypto.randomInt(a.length)];

// One identity per request, so email / username / name inside the same body match each other.
function makeCtx(domain) {
  return {
    first: pick(FIRST),
    last: pick(LAST),
    uid: crypto.randomBytes(4).toString('hex'),
    domain: String(domain || 'example.com').trim().replace(/^@/, '') || 'example.com',
  };
}

const TOKEN_FN = {
  email: (c) => `${c.first}.${c.last}.${c.uid}@${c.domain}`.toLowerCase(),
  username: (c) => `${c.first.slice(0, 5)}${c.uid.slice(0, 6)}`.toLowerCase(),
  phone: () => `${pick(['6', '7', '8', '9'])}${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`,
  uuid: () => crypto.randomUUID(),
  firstName: (c) => c.first,
  lastName: (c) => c.last,
  name: (c) => `${c.first} ${c.last}`,
  timestamp: () => String(Date.now()),
  random: () => String(crypto.randomInt(100000, 1000000)),
  date: () => new Date().toISOString().slice(0, 10),
  datetime: () => new Date().toISOString(),
};

function resolveTokens(v, ctx) {
  if (typeof v === 'string') return v.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (m, k) => (TOKEN_FN[k] ? TOKEN_FN[k](ctx) : m));
  if (Array.isArray(v)) return v.map((x) => resolveTokens(x, ctx));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = resolveTokens(v[k], ctx);
    return o;
  }
  return v;
}

// Login / token / reset style endpoints need REAL existing values, so they are never randomised.
const AUTH_PATH = /(login|log-in|signin|sign-in|authenticate|oauth|\/token|refresh|logout|forgot|reset|verify|otp)/i;
const USERISH_PATH = /(user|register|signup|sign-up|customer|account|member|employee|student|patient|profile|person|people|contact|client|admin|staff)/i;
const isAuthPath = (p) => AUTH_PATH.test(p || '');
const isUserish = (p) => USERISH_PATH.test(p || '');

function uniqueTokenFor(key, schema, userish, current) {
  const k = String(key || '').toLowerCase().replace(/[_\-\s]/g, '');
  if (schema.format === 'email' || /email|^mail$/.test(k)) return '{{email}}';
  if (schema.format === 'uuid' || /uuid|guid/.test(k)) return '{{uuid}}';
  if (/phone|mobile|msisdn|^cell/.test(k)) return '{{phone}}';
  if (/^(username|loginname|login|handle|nickname|screenname)$/.test(k)) return '{{username}}';
  if (/^(firstname|givenname|fname)$/.test(k)) return '{{firstName}}';
  if (/^(lastname|surname|familyname|lname)$/.test(k)) return '{{lastName}}';
  if (/^(fullname|displayname)$/.test(k) || (k === 'name' && userish)) return '{{name}}';
  if (/^(sku|slug|code|barcode|reference|referenceno|referencenumber|externalid|ref|serial|serialnumber|invoiceno|ordernumber)$/.test(k)) {
    const base = typeof current === 'string' && current && current !== 'string' ? current : '';
    const max = schema.maxLength;
    if (!base || (max && base.length + 7 > max)) return max && max < 6 ? null : '{{random}}';
    return `${base}-{{random}}`;
  }
  return null;
}

function applyUnique(val, schema, key, userish) {
  schema = mergeAllOf(schema) || {};
  if (Array.isArray(val)) return val.map((v) => applyUnique(v, schema.items, key, userish));
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = applyUnique(v, (schema.properties || {})[k], k, userish);
    return out;
  }
  if (typeof val === 'string') return uniqueTokenFor(key, schema, userish, val) ?? val;
  return val;
}

function finalizePayload(p, ep) {
  if (p && ep.body && p.body !== undefined && ['POST', 'PUT', 'PATCH'].includes(ep.method) && !isAuthPath(ep.path)) {
    p.body = applyUnique(p.body, ep.body.schema, '', isUserish(ep.path));
  }
  return p;
}

/* -------------------------------------------------------------------------- */
/*  Normalise Swagger 2 / OpenAPI 3 into a flat endpoint list                 */
/* -------------------------------------------------------------------------- */

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function paramSchema(p) {
  if (p.schema) return p.schema;
  const s = {};
  for (const k of ['type', 'format', 'enum', 'items', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'example']) {
    if (p[k] !== undefined) s[k] = p[k];
  }
  return s;
}

function buildBaseUrls(spec) {
  if (spec.swagger) {
    const scheme = (spec.schemes && spec.schemes[0]) || 'https';
    return spec.host ? [`${scheme}://${spec.host}${spec.basePath || ''}`.replace(/\/$/, '')] : spec.basePath ? [spec.basePath] : [];
  }
  return (spec.servers || []).map((s) => {
    let url = s.url || '';
    for (const [k, v] of Object.entries(s.variables || {})) url = url.replaceAll(`{${k}}`, v.default ?? '');
    return url;
  });
}

// The base URL defaults to the site the user pasted (local or live). Servers declared inside
// the spec are kept as alternatives, because generated specs often declare the wrong host or port.
function computeBaseUrls(spec, specUrl, inputOrigin) {
  const list = buildBaseUrls(spec)
    .map((b) => {
      try {
        return new URL(b || '/', specUrl).href.replace(/\/$/, '');
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const specOrigin = new URL(specUrl).origin;
  if (specOrigin !== inputOrigin) return list.length ? [...new Set(list)] : [specOrigin];
  const ctxPath = list[0] ? new URL(list[0]).pathname.replace(/\/$/, '') : '';
  return [...new Set([inputOrigin + ctxPath, ...list, inputOrigin])];
}

function normalise(spec) {
  const v2 = !!spec.swagger;
  const globalSecurity = Array.isArray(spec.security) && spec.security.length > 0;
  const endpoints = [];

  for (const [p, item] of Object.entries(spec.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    const common = item.parameters || [];

    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;

      const resolved = deref({ ...op, parameters: [...common, ...(op.parameters || [])] }, spec);
      // operation-level params override path-level params with the same name+in
      const seen = new Map();
      for (const prm of resolved.parameters || []) seen.set(`${prm.in}:${prm.name}`, prm);
      const params = [...seen.values()];

      const parameters = [];
      let body = null;
      const formFields = [];

      for (const prm of params) {
        if (prm.in === 'body') {
          body = { contentType: (op.consumes || spec.consumes || ['application/json'])[0], schema: prm.schema || {}, required: !!prm.required };
        } else if (prm.in === 'formData') {
          formFields.push(prm);
        } else if (['path', 'query', 'header'].includes(prm.in)) {
          parameters.push({
            in: prm.in,
            name: prm.name,
            required: prm.in === 'path' ? true : !!prm.required,
            description: prm.description || '',
            schema: paramSchema(prm),
            example: prm.example,
          });
        }
      }

      if (formFields.length) {
        const props = {};
        for (const f of formFields) props[f.name] = paramSchema(f);
        const consumes = op.consumes || spec.consumes || [];
        body = {
          contentType: consumes.find((c) => /multipart|urlencoded/.test(c)) || 'application/x-www-form-urlencoded',
          schema: { type: 'object', properties: props, required: formFields.filter((f) => f.required).map((f) => f.name) },
          required: true,
        };
      }

      if (!v2 && resolved.requestBody && resolved.requestBody.content) {
        const content = resolved.requestBody.content;
        const ct = Object.keys(content).find((c) => /json/.test(c)) || Object.keys(content)[0];
        const media = content[ct] || {};
        let example = media.example;
        if (example === undefined && media.examples) {
          const first = Object.values(media.examples)[0];
          if (first) example = first.value;
        }
        body = { contentType: ct, schema: media.schema || {}, example, required: !!resolved.requestBody.required };
      }

      // Starter payload from the schema (AI improves on this)
      const sample = { pathParams: {}, query: {}, headers: {}, body: undefined };
      for (const prm of parameters) {
        const val = prm.example !== undefined ? prm.example : sampleFromSchema(prm.schema, prm.name);
        if (prm.in === 'path') sample.pathParams[prm.name] = val;
        else if (prm.in === 'query' && (prm.required || prm.example !== undefined || prm.schema?.default !== undefined)) sample.query[prm.name] = val;
        else if (prm.in === 'header' && prm.required && prm.name.toLowerCase() !== 'authorization') sample.headers[prm.name] = val;
      }
      for (const m2 of p.matchAll(/\{([^}]+)\}/g)) if (!(m2[1] in sample.pathParams)) sample.pathParams[m2[1]] = 1;
      if (body) sample.body = body.example !== undefined ? body.example : sampleFromSchema(body.schema, 'body');

      const method = m.toUpperCase();
      finalizePayload(sample, { method, path: p, body });

      const secured = Array.isArray(resolved.security) ? resolved.security.length > 0 : globalSecurity;

      endpoints.push({
        id: `${method} ${p}`,
        method,
        path: p,
        summary: resolved.summary || '',
        description: resolved.description || '',
        operationId: resolved.operationId || '',
        tags: resolved.tags && resolved.tags.length ? resolved.tags : ['default'],
        deprecated: !!resolved.deprecated,
        secured,
        parameters,
        body,
        responses: Object.keys(resolved.responses || {}),
        sample,
      });
    }
  }
  return endpoints;
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                    */
/* -------------------------------------------------------------------------- */

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, env: { huggingface: !!process.env.HF_TOKEN, openai: !!process.env.OPENAI_API_KEY, anthropic: !!process.env.ANTHROPIC_API_KEY, ollama: !!process.env.OLLAMA_API_KEY } }),
);

app.post('/api/spec', async (req, res) => {
  try {
    let { url, insecure } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Enter a Swagger / OpenAPI URL.' });
    url = url.trim();

    // no scheme typed: localhost → http first (then https), everything else → https
    let attempts;
    if (/^https?:\/\//i.test(url)) attempts = [url];
    else if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(url)) attempts = ['http://' + url, 'https://' + url];
    else attempts = ['https://' + url];

    let found = null;
    let input = null;
    for (const a of attempts) {
      let target;
      try {
        target = assertTarget(a);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      found = await discoverSpec(target.href, !!insecure);
      if (found) {
        input = target;
        break;
      }
    }
    if (!found) {
      return res.status(404).json({
        error:
          'No Swagger / OpenAPI document was found at this link. Try the direct JSON link (for example /v3/api-docs or /swagger/v1/swagger.json). If the HTTPS certificate is self-signed, turn on "Allow self-signed HTTPS" in Settings.',
      });
    }

    const [primary] = found.specs;
    const seen = new Set();
    const endpoints = [];
    for (const { spec } of found.specs) {
      for (const e of normalise(spec)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        endpoints.push(e);
      }
    }
    const { spec, url: specUrl } = primary;

    res.json({
      specUrl,
      title: spec.info?.title || 'Untitled API',
      version: spec.info?.version || '',
      description: spec.info?.description || '',
      format: spec.openapi ? `OpenAPI ${spec.openapi}` : `Swagger ${spec.swagger}`,
      baseUrls: computeBaseUrls(spec, specUrl, input.origin),
      groups: found.specs.length,
      foreign: found.foreign,
      endpoints,
    });
  } catch (e) {
    res.status(500).json({ error: `Spec load fail: ${e.message}` });
  }
});

/* ---- AI payload generation (Hugging Face / OpenAI / Claude) --------------- */

const SCENARIOS = {
  valid: 'Generate a VALID request that should succeed with a 2xx response. Use realistic, meaningful values.',
  negative:
    'Generate an INVALID request that the API should reject with a 4xx response (for example a missing required field, a wrong data type, or an out-of-range value). Keep the overall structure intact so it still reaches validation.',
  edge: 'Generate a VALID request that uses boundary values (minimum/maximum lengths and numbers, unicode text, optional fields filled) and should still succeed.',
};

// Base URLs can be overridden with env vars (corporate proxies, local gateways, tests).
const PROVIDERS = {
  huggingface: { label: 'Hugging Face', env: 'HF_TOKEN', model: 'meta-llama/Llama-3.1-8B-Instruct', url: () => (process.env.HF_BASE_URL || 'https://router.huggingface.co') + '/v1/chat/completions' },
  // Ollama: with an API key it uses Ollama Cloud (https://ollama.com, no install). Without a key it talks to Ollama on this PC.
  // 127.0.0.1 (not "localhost") avoids IPv6 lookup problems. Uses Ollama's native /api/chat.
  ollama: { label: 'Ollama', env: 'OLLAMA_API_KEY', keyOptional: true, model: 'gpt-oss:20b', timeout: 180000, url: (key) => (process.env.OLLAMA_BASE_URL || (key ? 'https://ollama.com' : 'http://127.0.0.1:11434')) + '/api/chat' },
  openai: { label: 'OpenAI', env: 'OPENAI_API_KEY', model: 'gpt-4o-mini', url: () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com') + '/v1/chat/completions' },
  anthropic: { label: 'Claude', env: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5', url: () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages' },
};

function httpHint(status, fallback, provider) {
  if (status === 401) return 'the API key is invalid';
  if (status === 402) return 'out of credits — Hugging Face free monthly credits are used up. Try a smaller model (Llama-3.1-8B), wait for the monthly reset, or switch provider';
  if (status === 403) return 'this key does not have access to that model';
  if (status === 404) return provider === 'ollama' ? 'model not found — download it first with: ollama pull <model>' : 'model not found — check the model name';
  if (status === 429) return 'rate limit or quota reached';
  return fallback || `HTTP ${status}`;
}

// One function for all three providers. Returns the model's text reply.
async function callAI(provider, key, model, system, user) {
  const P = PROVIDERS[provider];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), P.timeout || 60000);
  try {
    let headers;
    let body;
    if (provider === 'anthropic') {
      headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      body = { model, max_tokens: 1500, system, messages: [{ role: 'user', content: user }] };
    } else if (provider === 'ollama') {
      headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
      body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false, format: 'json', options: { temperature: 0.4, num_predict: 1500 } };
    } else {
      headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
      const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
      body = provider === 'openai' ? { model, messages, max_completion_tokens: 1500, response_format: { type: 'json_object' } } : { model, messages, max_tokens: 1500, temperature: 0.4, stream: false };
    }
    const r = await fetch(P.url(key), { method: 'POST', signal: ctrl.signal, headers, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || (typeof data?.error === 'string' ? data.error : '');
      const err = new Error(httpHint(r.status, msg, provider));
      err.status = r.status;
      throw err;
    }
    if (provider === 'anthropic') return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (provider === 'ollama') return data?.message?.content || '';
    return data?.choices?.[0]?.message?.content || '';
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout');
    if (provider === 'ollama' && !e.status) throw new Error(key ? 'cannot reach Ollama Cloud (ollama.com) — check your internet connection' : `cannot reach Ollama at ${P.url('').replace('/api/chat', '')} — is it running? (start it with: ollama serve). Using an Ollama API key instead? Paste it in Settings.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text) {
  if (!text) return null;
  const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function fallbackPayload(ep, scenario) {
  const p = JSON.parse(JSON.stringify(ep.sample || { pathParams: {}, query: {}, headers: {} }));
  if (scenario === 'negative') {
    if (p.body && typeof p.body === 'object' && !Array.isArray(p.body)) {
      const req = requiredNames(ep.body?.schema);
      const keys = Object.keys(p.body);
      const target = req[0] && req[0] in p.body ? req[0] : keys[0];
      if (target) {
        if (req[0] && req[0] in p.body) delete p.body[target];
        else p.body[target] = { invalid: true };
      }
    } else {
      const k = Object.keys(p.pathParams || {})[0];
      if (k) p.pathParams[k] = 'invalid-id-!@#';
    }
  } else if (scenario === 'edge' && p.body && typeof p.body === 'object' && !Array.isArray(p.body)) {
    // add unicode to plain text fields only — leave emails, urls, dates, tokens and uuids valid
    const formatted = /@|\{\{|^https?:|^\d{4}-\d{2}-\d{2}|^[0-9a-f]{8}-[0-9a-f-]{27}$|^\d+$/i;
    for (const [k, v] of Object.entries(p.body)) if (typeof v === 'string' && !formatted.test(v)) p.body[k] = `${v} – ünïcödé ✓`;
  }
  return p;
}

function cleanPayload(raw, ep) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    pathParams: raw.pathParams && typeof raw.pathParams === 'object' ? raw.pathParams : {},
    query: raw.query && typeof raw.query === 'object' ? raw.query : {},
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
    body: raw.body,
  };
  for (const k of Object.keys(out.headers)) if (k.toLowerCase() === 'authorization') delete out.headers[k];
  // make sure every {placeholder} has a value
  for (const m of ep.path.matchAll(/\{([^}]+)\}/g)) if (out.pathParams[m[1]] === undefined) out.pathParams[m[1]] = ep.sample?.pathParams?.[m[1]] ?? 1;
  if (!ep.body) out.body = undefined;
  return out;
}

app.post('/api/generate', async (req, res) => {
  const { endpoint: ep, scenario = 'valid', provider: reqProvider, apiKey, model, useAI = true } = req.body || {};
  if (!ep || !ep.path) return res.status(400).json({ error: 'endpoint missing' });

  const provider = PROVIDERS[reqProvider] ? reqProvider : 'huggingface';
  const P = PROVIDERS[provider];
  const key = (apiKey || process.env[P.env] || '').trim();
  const chosenModel = (model || P.model).trim();
  const fallback = () => finalizePayload(cleanPayload(fallbackPayload(ep, scenario), ep), ep);

  if (!useAI || (!key && !P.keyOptional)) {
    return res.json({
      payload: fallback(),
      source: 'schema',
      note: !useAI ? 'AI is off — using a schema-based payload.' : `No ${P.label} API key found — using a schema-based payload.`,
    });
  }

  const spec = {
    method: ep.method,
    path: ep.path,
    summary: ep.summary,
    description: (ep.description || '').slice(0, 400),
    parameters: (ep.parameters || []).map((p) => ({ in: p.in, name: p.name, required: p.required, schema: p.schema })),
    requestBody: ep.body ? { contentType: ep.body.contentType, required: ep.body.required, schema: ep.body.schema } : null,
  };
  let specText = JSON.stringify(spec);
  if (specText.length > 7000) specText = specText.slice(0, 7000) + '…(truncated)';

  const system =
    'You are an API test-data generator. Reply with ONE JSON object only — no prose, no markdown fences. ' +
    'The object has exactly these keys: "pathParams" (object), "query" (object), "headers" (object), "body" (any JSON, or omit when the endpoint takes no body). ' +
    'Follow the schema strictly: include all required fields, honour enums, formats, min/max and types. Never include an Authorization header. ' +
    'Values must be realistic (real-looking names, emails, ids), not placeholders like "string".';
  const user = `${SCENARIOS[scenario] || SCENARIOS.valid}\n\nEndpoint definition:\n${specText}`;

  try {
    const content = await callAI(provider, key, chosenModel, system, user);
    const payload = cleanPayload(extractJson(content), ep);
    if (!payload) return res.json({ payload: fallback(), source: 'schema', aiFailed: true, aiStatus: 0, aiMessage: 'it did not return valid JSON', note: `${P.label} did not return valid JSON — using a schema-based payload.` });
    res.json({ payload: finalizePayload(payload, ep), source: 'ai', provider, providerLabel: P.label, model: chosenModel });
  } catch (e) {
    res.json({ payload: fallback(), source: 'schema', aiFailed: true, aiStatus: e.status || 0, aiMessage: e.message, note: `${P.label} call failed (${e.message}) — using a schema-based payload.` });
  }
});

/* ---- "Test connection" button in Settings ---------------------------------- */

app.post('/api/ai/test', async (req, res) => {
  const { provider: reqProvider, apiKey, model } = req.body || {};
  const provider = PROVIDERS[reqProvider] ? reqProvider : 'huggingface';
  const P = PROVIDERS[provider];
  const key = (apiKey || process.env[P.env] || '').trim();
  if (!key && !P.keyOptional) return res.json({ ok: false, message: `No ${P.label} key found. Paste one here (or set ${P.env} on the server).` });
  const m = (model || P.model).trim();
  const t0 = performance.now();
  try {
    await callAI(provider, key, m, 'Reply with the JSON object {"ok": true} and nothing else.', 'ping');
    res.json({ ok: true, message: `Connected to ${P.label} · ${m} · ${Math.round(performance.now() - t0)} ms` });
  } catch (e) {
    res.json({ ok: false, status: e.status || 0, message: `${P.label}: ${e.message}` });
  }
});

/* ---- Execute a request on behalf of the browser (avoids CORS) ------------- */

app.post('/api/execute', async (req, res) => {
  const { baseUrl, method = 'GET', path: apiPath, contentType, insecure, emailDomain } = req.body || {};
  if (!baseUrl || !apiPath) return res.status(400).json({ error: 'baseUrl and path are required.' });

  try {
    // {{email}} / {{username}} / {{phone}} ... become fresh values on EVERY run
    const ctx = makeCtx(emailDomain);
    const pathParams = resolveTokens(req.body.pathParams || {}, ctx);
    const query = resolveTokens(req.body.query || {}, ctx);
    const headers = resolveTokens(req.body.headers || {}, ctx);
    const body = resolveTokens(req.body.body, ctx);

    const filled = apiPath.replace(/\{([^}]+)\}/g, (_, k) => encodeURIComponent(pathParams[k] ?? `{${k}}`));
    const url = new URL(baseUrl.replace(/\/$/, '') + (filled.startsWith('/') ? filled : `/${filled}`));
    assertTarget(url.href);
    for (const [k, v] of Object.entries(query)) {
      if (v === '' || v === null || v === undefined) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }

    const h = {};
    for (const [k, v] of Object.entries(headers)) if (v !== '' && v != null) h[k] = String(v);

    const init = { method: String(method).toUpperCase(), headers: h, redirect: 'manual', dispatcher: dispatcherFor(url.href, !!insecure) };
    const ct = (contentType || '').toLowerCase();
    const hasBody = body !== undefined && body !== null && body !== '' && !['GET', 'HEAD'].includes(init.method);

    if (hasBody) {
      const lower = Object.keys(h).map((k) => k.toLowerCase());
      if (ct.includes('multipart/form-data')) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(typeof body === 'object' ? body : {})) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        init.body = fd; // boundary header is set automatically
      } else if (ct.includes('x-www-form-urlencoded')) {
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(typeof body === 'object' ? body : {})) sp.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        init.body = sp.toString();
        if (!lower.includes('content-type')) h['content-type'] = 'application/x-www-form-urlencoded';
      } else if (typeof body === 'string') {
        init.body = body;
        if (!lower.includes('content-type')) h['content-type'] = ct || 'text/plain';
      } else {
        init.body = JSON.stringify(body);
        if (!lower.includes('content-type')) h['content-type'] = ct && ct.includes('json') ? ct : 'application/json';
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    init.signal = ctrl.signal;

    const t0 = performance.now();
    let r;
    try {
      r = await fetch(url, init);
    } finally {
      clearTimeout(timer);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const ms = Math.round(performance.now() - t0);

    const MAX = 2 * 1024 * 1024;
    const truncated = buf.length > MAX;
    const text = buf.subarray(0, MAX).toString('utf8');
    const respCt = r.headers.get('content-type') || '';
    let parsed;
    let isJson = false;
    if (/json/i.test(respCt) || /^\s*[\[{]/.test(text)) {
      try {
        parsed = JSON.parse(text);
        isJson = true;
      } catch {
        /* keep text */
      }
    }

    const respHeaders = {};
    r.headers.forEach((v, k) => (respHeaders[k] = v));

    res.json({
      ok: true,
      url: url.href,
      status: r.status,
      statusText: r.statusText,
      ms,
      size: buf.length,
      truncated,
      headers: respHeaders,
      isJson,
      body: isJson ? parsed : text,
      sent: { pathParams, query, body }, // the values that were really sent (tokens resolved)
    });
  } catch (e) {
    const code = e.cause?.code || e.code || '';
    let hint = e.message;
    if (e.name === 'AbortError') hint = 'The request timed out after 30 seconds.';
    else if (code === 'ECONNREFUSED') hint = 'Connection refused — is the server running? Check the port and the Base URL.';
    else if (code === 'ENOTFOUND') hint = 'Host not found — check the Base URL.';
    else if (String(code).startsWith('ERR_TLS') || /certificate/i.test(String(e.cause?.message || ''))) hint = 'TLS / certificate error — turn on "Allow self-signed HTTPS" in Settings.';
    else if (e.cause?.message) hint = `${e.message}: ${e.cause.message}`;
    res.json({ ok: false, error: hint, code });
  }
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

if (IS_MAIN) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`\n  Swagger AI Tester  →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
    if (!process.env.OLLAMA_API_KEY && !process.env.HF_TOKEN && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      console.log('  Tip: add an OpenAI / Claude / Hugging Face key in Settings inside the app (or set OPENAI_API_KEY / ANTHROPIC_API_KEY / HF_TOKEN). Ollama: paste your Ollama API key in Settings (cloud), or run Ollama locally without a key.\n');
    }
    if (HOST !== '127.0.0.1' && !APP_PASSWORD) console.log('  ⚠  HOST is open to the network but APP_PASSWORD is not set. Set APP_PASSWORD to protect this tool.\n');
  });
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
}
