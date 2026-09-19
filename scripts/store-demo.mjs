// Fictional documentation site and pre-captured skill used to render the
// store screenshots. "Nimbus" is a made-up product, not a real service.

export const DEMO_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authentication · Nimbus SDK Docs</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 system-ui, sans-serif; color: #1f2937; display: grid; grid-template-columns: 200px 1fr; }
  nav { background: #f8fafc; border-right: 1px solid #e5e7eb; padding: 20px 16px; min-height: 100vh; }
  nav b { display: block; font-size: 17px; margin-bottom: 16px; color: #0f766e; }
  nav a { display: block; color: #475569; text-decoration: none; padding: 4px 0; font-size: 14px; }
  nav a.on { color: #0f766e; font-weight: 600; }
  main { padding: 28px 36px; max-width: 680px; }
  h1 { margin: 0 0 8px; font-size: 30px; }
  h2 { margin: 28px 0 6px; font-size: 21px; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 8px; font-size: 13px; overflow: auto; }
  code { font-family: ui-monospace, Menlo, monospace; }
  p code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; }
  th { background: #f8fafc; }
</style></head>
<body>
  <nav><b>☁ Nimbus SDK</b>
    <a href="#">Quickstart</a><a class="on" href="#">Authentication</a><a href="#">Uploads</a>
    <a href="#">Webhooks</a><a href="#">Errors</a><a href="#">Changelog</a></nav>
  <main>
    <h1>Authentication</h1>
    <p>Every request is authenticated with an API key sent in the <code>Authorization</code> header.</p>
    <section id="api-keys">
      <h2>API keys</h2>
      <p>Create keys in the dashboard. Keep secret keys on the server only.</p>
      <pre><code class="language-ts">const nimbus = new Nimbus({ apiKey: process.env.NIMBUS_KEY });
const files = await nimbus.files.list({ limit: 20 });</code></pre>
    </section>
    <section id="rate-limits">
      <h2>Rate limits</h2>
      <p>Limits are applied per key. When exceeded, the API returns <code>429</code> with a <code>Retry-After</code> header.</p>
      <table><thead><tr><th>Plan</th><th>Requests / min</th><th>Burst</th></tr></thead>
        <tbody><tr><td>Free</td><td>60</td><td>10</td></tr><tr><td>Team</td><td>600</td><td>100</td></tr></tbody></table>
    </section>
  </main>
</body></html>`;

export function demoState(base) {
  const src = (path, title) => ({ url: `${base}${path}`, title: `${title} · Nimbus SDK Docs` });
  const block = (id, content, source) => ({
    id,
    fingerprint: `demo-${id}`,
    capturedAt: Date.now(),
    format: 'markdown',
    content,
    images: [],
    source,
    selector: null,
  });
  const blocks = [
    block('q1', '# Quickstart\n\nInstall the SDK:\n\n```bash\nnpm install @nimbus/sdk\n```', src('/docs/quickstart', 'Quickstart')),
    block(
      'a1',
      '## API keys\n\nCreate keys in the dashboard. Keep secret keys on the server only.\n\n```ts\nconst nimbus = new Nimbus({ apiKey: process.env.NIMBUS_KEY });\n```',
      src('/docs/authentication', 'Authentication'),
    ),
    block('a2', '## OAuth apps\n\nUse OAuth when acting on behalf of other users.', src('/docs/oauth', 'OAuth')),
    block('u1', '## Multipart uploads\n\nFiles over 100 MB must use multipart uploads.', src('/docs/uploads', 'Uploads')),
    block('u2', '## Resumable uploads\n\nResume interrupted uploads with the upload ID.', src('/docs/uploads', 'Uploads')),
    block('w1', '## Verifying signatures\n\nCheck the `Nimbus-Signature` header on every event.', src('/docs/webhooks', 'Webhooks')),
  ];
  return {
    version: 1,
    meta: { name: 'Nimbus SDK', description: 'Use when writing code that calls the Nimbus SDK or its REST API.' },
    sections: [
      { id: 'root', title: 'Overview', parentId: null, blockIds: ['q1'] },
      { id: 'auth', title: 'Authentication', parentId: null, blockIds: ['a1', 'a2'] },
      { id: 'uploads', title: 'Uploads', parentId: null, blockIds: ['u1', 'u2'] },
      { id: 'hooks', title: 'Webhooks', parentId: 'uploads', blockIds: ['w1'] },
    ],
    blocks: Object.fromEntries(blocks.map((b) => [b.id, b])),
    fingerprints: Object.fromEntries(blocks.map((b) => [b.fingerprint, b.id])),
  };
}
