/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where "Find a home" and every "Book nearby" button point. Defaults to the local app. */
  readonly SITE_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
