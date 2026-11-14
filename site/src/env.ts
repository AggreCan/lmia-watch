import type { Lang } from "./i18n";
import type { SiteRows } from "./pages/employer";

export interface Env {
  DB: D1Database;
  // The hosted search database (wrangler.jsonc, binding SEARCH), filled by
  // the nightly sync and read by GET /api/search (src/search_db.ts) and the
  // search page's first view. Optional: without it the API answers 503 and
  // the search page renders its fallback from search/first.json.
  SEARCH?: D1Database;
  DATA?: R2Bucket;
  ASSETS?: Fetcher;
  SCHEMA_SQL?: string;
  SEED_SQL?: string;
  // Support page: the payment page address and the button text in English
  // and French. Empty or unset DONATE_URL keeps donations closed (no button).
  DONATE_URL?: string;
  DONATE_LABEL?: string;
  DONATE_LABEL_FR?: string;
  // The donation page's webhook token (a Worker secret). Unset keeps the
  // webhook route closed; a notice is stored only when its token matches.
  KOFI_VERIFICATION_TOKEN?: string;
  // Rate limiters (wrangler.jsonc "ratelimits"). Absent in a bare test
  // environment, in which case nothing is limited.
  // Daily check: the email binding, the sender on the zone, and the operator's
  // address (a secret, never in the repository).
  ALERTS?: SendEmail;
  ALERT_FROM?: string;
  ALERT_EMAIL?: string;
  PAGE_LIMIT?: RateLimit;
  API_LIMIT?: RateLimit;
  DOWNLOAD_LIMIT?: RateLimit;
  FORM_LIMIT?: RateLimit;
  FEED_LIMIT?: RateLimit;
  // An AI crawler's requests, counted by the crawler's name across all its
  // addresses (wrangler.jsonc "ratelimits", src/limits.ts AI_CRAWLERS).
  CRAWLER_LIMIT?: RateLimit;
  // Aggregate response counts (src/views.ts). Absent in tests and local
  // development, in which case nothing is counted.
  VIEWS?: AnalyticsEngineDataset;
  // The secret behind the daily visitor code (src/views.ts): the day's salt
  // is HMAC-SHA-256 of the UTC date under it. Unset: no code is written and
  // the roll-up counts no unique visitors. Set with `wrangler secret put`.
  VIEWS_SALT_KEY?: string;
  // The deployed version (wrangler.jsonc "version_metadata"). Its id is part
  // of every page cache key (src/pagecache.ts); without it nothing is cached.
  CF_VERSION_METADATA?: { id: string; tag: string };
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    lang: Lang;
    // Set by the page cache (src/pagecache.ts): "hit" when the page came from
    // the cache, "miss" when it was rendered for a request the cache could
    // have answered; unset otherwise. The views counter records it (blob11).
    pageCache?: "hit" | "miss";
    // A profile's published responses and corrections, read by the page cache
    // for its key and handed to the employer page so it does not read them again.
    siteRows?: SiteRows;
  };
};
