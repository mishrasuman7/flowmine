/**
 * FlowMine extension — local type contracts.
 *
 * Mirrors the BrowserEvent / BrowserEventType shapes from web/lib/types.ts so
 * the extension and the server agree on the wire format. We duplicate rather
 * than import across the monorepo because the extension is a fully separate
 * build (no bundler path mapping into web/) and one tiny file is cheaper than
 * shipping a shared package.
 */

export type BrowserEventType = 'navigate' | 'tab_activate' | 'tab_close';

export interface BrowserEvent {
  team_id: string;
  user_id: string;
  domain: string;
  event_type: BrowserEventType;
  tab_id: string;
  session_id: string;
  timestamp: number;
}

/** Persisted configuration read from chrome.storage.local. */
export interface FlowMineConfig {
  team_id: string;
  user_id: string;
  api_url: string;
}

/** Diagnostic snapshot the popup reads to show last-flush status. */
export interface FlushStatus {
  last_flush_at: number | null;
  last_flush_count: number;
  last_flush_error: string | null;
  buffered_count: number;
}
