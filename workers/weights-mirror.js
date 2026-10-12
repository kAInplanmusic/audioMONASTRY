export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const model = url.searchParams.get("model");
    const rev   = url.searchParams.get("rev");
    if (!model || !rev) return new Response("Missing model/rev", {status:400});

    const hfUrl = `https://huggingface.co/${model}/resolve/main/${rev}.tar`;
    const r2Key = `weights/${model}/${rev}.tar`;

    const resp = await fetch(hfUrl, {
      headers: { "User-Agent": "audioMONASTRY-mirror/1.0" }
    });
    if (!resp.ok) return new Response(`HF ${resp.status}`, {status:502});

    const upload = await env.R2_BUCKET.createMultipartUpload(r2Key);
    const reader = resp.body.getReader();
    const CHUNK = 5 * 1024 * 1024;
    let part = 1, buffer = new Uint8Array(0);

    while (true) {
      const {done, value} = await reader.read();
      if (value) {
        const tmp = new Uint8Array(buffer.length + value.length);
        tmp.set(buffer); tmp.set(value, buffer.length);
        buffer = tmp;
      }
      while (buffer.length >= CHUNK) {
        const chunk = buffer.slice(0, CHUNK);
        buffer = buffer.slice(CHUNK);
        await upload.uploadPart(part++, chunk);
      }
      if (done) break;
    }
    if (buffer.length) await upload.uploadPart(part, buffer);
    await upload.complete();

    // SHA256 sidecar
    const shaResp = await fetch(hfUrl);
    const sha = await crypto.subtle.digest("SHA-256", await shaResp.arrayBuffer());
    const shaHex = Array.from(new Uint8Array(sha)).map(b=>b.toString(16).padStart(2,'0')).join('');
    await env.R2_BUCKET.put(`${r2Key}.sha256`, shaHex);

    return new Response(`OK ${r2Key}`, {status:200});
  }
};