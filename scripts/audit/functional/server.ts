/** Loopback functional app fixture. Production handlers and UI; no provider keys. */
process.env.NODE_ENV = 'test'; process.env.VITEST = 'true';
process.env.AUDIOMONASTRY_NO_AUTOSTART = '1'; process.env.SESSION_STATE_FILE = 'off';
process.env.ENABLE_SFU = '0'; process.env.AI_MODE = 'off';
process.env.AUDIOMONASTRY_TEST_RESET = '1'; process.env.STUDIO_ACCESS_TOKEN = 'r8-local-functional';
for (const key of Object.keys(process.env)) if (/^(?:VAST_|RUNPOD_|HCLOUD_|HETZNER_|SUPABASE_|CFS3_|CLOUDFLARE_)/.test(key)) delete process.env[key];
const { startServer } = await import('../../../server');
await startServer(8188);
