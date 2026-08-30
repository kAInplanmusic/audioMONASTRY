/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_SOCKET_IO_SIGNALING_URL?: string;
  readonly VITE_SIGNALING_WS_URL?: string;
  readonly VITE_SIGNALING_HTTP_URL?: string;
  readonly VITE_SIGNALING_TRANSPORT_URL?: string;
  // --- Cloud-Anbindung (Supabase + Cloudflare R2) ---
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_PUB?: string;
  readonly VITE_CFR2_ACCOUNT_ID?: string;
  readonly VITE_CFR2_BUCKET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
