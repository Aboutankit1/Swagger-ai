import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../server.js';

/* ---- a "foreign" site that plays the role of the public petstore ------------------------------ */
const foreignSpec = { openapi: '3.0.1', info: { title: 'Foreign Petstore', version: '1' }, paths: { '/pet': { get: { responses: { 200: { description: 'ok' } } } } } };

/* ---- a springdoc-like local API -------------------------------------------------------------- */
const users = new Map();
let nextId = 1;

function localSpec() {
  return {
    openapi: '3.0.1',
    info: { title: 'Local Shop API', version: '1.0' },
    servers: [{ url: 'http://localhost:8081', description: 'Generated server url' }], // deliberately the wrong port
    paths: {
      '/api/auth/register': {
        post: {
          tags: ['Auth'],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Register' } } } },
          responses: { 201: { description: 'created' } },
        },
      },
      '/api/auth/login': {
        post: { tags: ['Auth'], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Login' } } } }, responses: { 200: { description: 'ok' } } },
      },
      '/api/users/{id}': {
        get: { tags: ['Users'], security: [{ bearer: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok' } } },
      },
    },
    components: {
      schemas: {
        Register: {
          type: 'object',
          required: ['email', 'username', 'password'],
          properties: {
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            username: { type: 'string' },
            phone: { type: 'string' },
            password: { type: 'string', format: 'password' },
          },
        },
        Login: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password' } } },
      },
    },
  };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

let foreign, local, pageOnly, tester, FOREIGN, LOCAL, PAGE_ONLY, T;

test.before(async () => {
  foreign = await startServer((req, res) => (req.url === '/v2/swagger.json' ? json(res, 200, foreignSpec) : json(res, 404, {})));
  FOREIGN = `http://127.0.0.1:${foreign.address().port}`;

  local = await startServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const html = (b) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(b);
      };
      const js = (b) => {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(b);
      };
      // stock swagger-ui initializer that still points at the public petstore (the trap)
      if (u.pathname === '/swagger-ui/index.html') return html('<html><script src="./swagger-initializer.js"></script></html>');
      if (u.pathname === '/swagger-ui/swagger-initializer.js') return js(`window.ui = SwaggerUIBundle({ url: "${FOREIGN}/v2/swagger.json", dom_id: "#swagger-ui" });`);
      // springdoc style initializer using configUrl
      if (u.pathname === '/ui2/index.html') return html('<html><script src="./swagger-initializer.js"></script></html>');
      if (u.pathname === '/ui2/swagger-initializer.js') return js(`window.ui = SwaggerUIBundle({ url: "${FOREIGN}/v2/swagger.json", configUrl: "/v3/api-docs/swagger-config" });`);

      if (u.pathname === '/v3/api-docs/swagger-config') return json(res, 200, { configUrl: '/v3/api-docs/swagger-config', urls: [{ url: '/v3/api-docs', name: 'default' }] });
      if (u.pathname === '/v3/api-docs') return json(res, 200, localSpec());

      if (u.pathname === '/api/auth/register' && req.method === 'POST') {
        const b = JSON.parse(raw || '{}');
        if (!b.email || !b.email.includes('@') || !b.username) return json(res, 400, { error: 'invalid' });
        if ([...users.values()].some((x) => x.email === b.email || x.username === b.username)) return json(res, 409, { error: 'duplicate' });
        const id = nextId++;
        users.set(id, { id, ...b });
        return json(res, 201, { id, email: b.email });
      }
      if (u.pathname === '/api/auth/login' && req.method === 'POST') {
        const b = JSON.parse(raw || '{}');
        const found = [...users.values()].find((x) => x.email === b.email && x.password === b.password);
        return found ? json(res, 200, { accessToken: `jwt-${found.id}` }) : json(res, 401, { error: 'bad credentials' });
      }
      const m = u.pathname.match(/^\/api\/users\/(\d+)$/);
      if (m) {
        if (!(req.headers.authorization || '').startsWith('Bearer jwt-')) return json(res, 401, { error: 'unauthorized' });
        return users.has(+m[1]) ? json(res, 200, users.get(+m[1])) : json(res, 404, { error: 'nf' });
      }
      json(res, 404, { error: 'not found' });
    });
  });
  LOCAL = `http://127.0.0.1:${local.address().port}`;

  // a host that has NO spec of its own, only a Swagger UI page pointing at another site
  pageOnly = await startServer((req, res) => {
    if (req.url.startsWith('/only-foreign/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><script>SwaggerUIBundle({ url: "${FOREIGN}/v2/swagger.json" })</script></html>`);
    }
    res.writeHead(404);
    res.end();
  });
  PAGE_ONLY = `http://127.0.0.1:${pageOnly.address().port}`;

  tester = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  T = `http://127.0.0.1:${tester.address().port}`;
});

test.after(() => {
  for (const s of [foreign, local, pageOnly, tester]) s?.close();
});

const post = async (p, body) => {
  const r = await fetch(T + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

test('pasting the Swagger UI page loads the LOCAL api, not the petstore in swagger-initializer.js', async () => {
  const { status, data } = await post('/api/spec', { url: `${LOCAL}/swagger-ui/index.html#/` });
  assert.equal(status, 200);
  assert.equal(data.title, 'Local Shop API');
  assert.equal(data.foreign, false);
  assert.equal(data.endpoints.length, 3);
});

test('base URL defaults to the pasted site, spec server stays as an alternative', async () => {
  const { data } = await post('/api/spec', { url: `${LOCAL}/swagger-ui/index.html` });
  assert.equal(data.baseUrls[0], LOCAL);
  assert.ok(data.baseUrls.includes('http://localhost:8081'));
});

test('configUrl based page and bare host both work', async () => {
  const a = await post('/api/spec', { url: `${LOCAL}/ui2/index.html` });
  assert.equal(a.data.title, 'Local Shop API');
  const b = await post('/api/spec', { url: LOCAL.replace('http://', '') }); // no scheme typed
  assert.equal(b.data.title, 'Local Shop API');
});

test('another-site spec is used only as a last resort, and is flagged', async () => {
  const { status, data } = await post('/api/spec', { url: `${PAGE_ONLY}/only-foreign/index.html` });
  assert.equal(status, 200);
  assert.equal(data.title, 'Foreign Petstore');
  assert.equal(data.foreign, true);
});

test('cloud metadata addresses are blocked', async () => {
  const { status } = await post('/api/spec', { url: 'http://169.254.169.254/latest/meta-data/' });
  assert.equal(status, 400);
  const r = await post('/api/execute', { baseUrl: 'http://169.254.169.254', method: 'GET', path: '/latest' });
  assert.equal(r.data.ok, false);
});

test('register payload gets dynamic tokens, login payload stays real', async () => {
  const { data } = await post('/api/spec', { url: `${LOCAL}/swagger-ui/index.html` });
  const reg = data.endpoints.find((e) => e.path === '/api/auth/register');
  const login = data.endpoints.find((e) => e.path === '/api/auth/login');
  assert.equal(reg.sample.body.email, '{{email}}');
  assert.equal(reg.sample.body.username, '{{username}}');
  assert.equal(reg.sample.body.phone, '{{phone}}');
  assert.equal(reg.sample.body.name, '{{name}}');
  assert.equal(reg.sample.body.password, 'Test@12345');
  assert.ok(!JSON.stringify(login.sample.body).includes('{{'));

  const g = await post('/api/generate', { endpoint: reg, scenario: 'valid', useAI: false });
  assert.equal(g.data.payload.body.email, '{{email}}');
});

test('running register twice sends different data every time and both succeed', async () => {
  const { data } = await post('/api/spec', { url: `${LOCAL}/swagger-ui/index.html` });
  const reg = data.endpoints.find((e) => e.path === '/api/auth/register');
  const run = () => post('/api/execute', { baseUrl: LOCAL, method: 'POST', path: reg.path, body: reg.sample.body, contentType: 'application/json', emailDomain: 'testmail.dev' });
  const a = await run();
  const b = await run();
  assert.equal(a.data.status, 201);
  assert.equal(b.data.status, 201);
  assert.notEqual(a.data.sent.body.email, b.data.sent.body.email);
  assert.notEqual(a.data.sent.body.username, b.data.sent.body.username);
  assert.match(a.data.sent.body.email, /^[a-z]+\.[a-z]+\.[0-9a-f]{8}@testmail\.dev$/);
  assert.match(a.data.sent.body.phone, /^[6-9]\d{9}$/);
  assert.ok(!JSON.stringify(a.data.sent).includes('{{'));
});

test('register → login → token → protected call works with the values that were sent', async () => {
  const { data } = await post('/api/spec', { url: `${LOCAL}/swagger-ui/index.html` });
  const reg = data.endpoints.find((e) => e.path === '/api/auth/register');
  const r = await post('/api/execute', { baseUrl: LOCAL, method: 'POST', path: reg.path, body: reg.sample.body, contentType: 'application/json' });
  const { email, password } = r.data.sent.body;
  const l = await post('/api/execute', { baseUrl: LOCAL, method: 'POST', path: '/api/auth/login', body: { email, password }, contentType: 'application/json' });
  assert.equal(l.data.status, 200);
  const me = await post('/api/execute', { baseUrl: LOCAL, method: 'GET', path: '/api/users/{id}', pathParams: { id: r.data.body.id }, headers: { Authorization: `Bearer ${l.data.body.accessToken}` } });
  assert.equal(me.data.status, 200);
  const noAuth = await post('/api/execute', { baseUrl: LOCAL, method: 'GET', path: '/api/users/{id}', pathParams: { id: r.data.body.id } });
  assert.equal(noAuth.data.status, 401);
});

test('security headers are set and bad JSON is a clean 400', async () => {
  const r = await fetch(`${T}/api/health`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const bad = await fetch(`${T}/api/spec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
});

/* ---- AI provider failure handling (mock provider) ---- */
test('provider 402 → aiFailed + clear message; /api/ai/test reports it; good key works', async () => {
  const mock = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const auth = req.headers.authorization || '';
    if (auth.includes('nocredits')) { res.statusCode = 402; return res.end(JSON.stringify({ error: 'Payment required' })); }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ pathParams: {}, query: {}, headers: {}, body: { name: 'AI Widget' } }) } }] }));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const prev = process.env.HF_BASE_URL;
  process.env.HF_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  try {
    const ep = { method: 'POST', path: '/x', parameters: [], body: { schema: { type: 'object', properties: { name: { type: 'string' } } }, contentType: 'application/json' }, sample: { body: { name: 'string' } } };
    const bad = await post('/api/generate', { endpoint: ep, scenario: 'valid', provider: 'huggingface', apiKey: 'nocredits', useAI: true });
    assert.equal(bad.data.source, 'schema');
    assert.equal(bad.data.aiFailed, true);
    assert.equal(bad.data.aiStatus, 402);
    assert.match(bad.data.aiMessage, /out of credits/);
    const t1 = await post('/api/ai/test', { provider: 'huggingface', apiKey: 'nocredits' });
    assert.equal(t1.data.ok, false);
    assert.match(t1.data.message, /credits/);
    const t2 = await post('/api/ai/test', { provider: 'huggingface', apiKey: 'good' });
    assert.equal(t2.data.ok, true);
    const good = await post('/api/generate', { endpoint: ep, scenario: 'valid', provider: 'huggingface', apiKey: 'good', useAI: true });
    assert.equal(good.data.source, 'ai');
  } finally {
    if (prev === undefined) delete process.env.HF_BASE_URL; else process.env.HF_BASE_URL = prev;
    mock.close();
  }
});

/* ---- Ollama (cloud key or local, native /api/chat) ---- */
test('ollama: API key is sent as Bearer, local works without a key, errors are clear', async () => {
  let lastAuth = '';
  let lastUrl = '';
  const mock = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      lastAuth = req.headers.authorization || '';
      lastUrl = req.url;
      res.setHeader('content-type', 'application/json');
      const j = JSON.parse(b);
      if (j.model === 'missing') { res.statusCode = 404; return res.end(JSON.stringify({ error: 'model not found' })); }
      if (lastAuth === 'Bearer badkey') { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
      res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify({ pathParams: {}, query: {}, headers: {}, body: { name: 'Ollama Widget' } }) } }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const prev = process.env.OLLAMA_BASE_URL;
  const ep = { method: 'POST', path: '/x', parameters: [], body: { schema: { type: 'object', properties: { name: { type: 'string' } } }, contentType: 'application/json' }, sample: { body: { name: 'string' } } };
  try {
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
    const withKey = await post('/api/generate', { endpoint: ep, scenario: 'valid', provider: 'ollama', apiKey: 'goodkey', useAI: true });
    assert.equal(withKey.data.source, 'ai');
    assert.equal(withKey.data.payload.body.name, 'Ollama Widget');
    assert.equal(lastAuth, 'Bearer goodkey');
    assert.equal(lastUrl, '/api/chat');
    const noKey = await post('/api/generate', { endpoint: ep, scenario: 'valid', provider: 'ollama', useAI: true });
    assert.equal(noKey.data.source, 'ai');
    assert.equal(lastAuth, '');
    const bad = await post('/api/ai/test', { provider: 'ollama', apiKey: 'badkey' });
    assert.equal(bad.data.ok, false);
    assert.match(bad.data.message, /invalid/);
    const miss = await post('/api/ai/test', { provider: 'ollama', model: 'missing' });
    assert.match(miss.data.message, /ollama pull/);
    mock.close();
    const down = await post('/api/ai/test', { provider: 'ollama' });
    assert.match(down.data.message, /cannot reach Ollama/);
  } finally {
    if (prev === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = prev;
    mock.close();
  }
});
