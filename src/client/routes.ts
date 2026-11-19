const BASE = '/beaver/chat';

/** Route name -> path. The only place that knows the URL prefix. */
export const ROUTES = {
  info: `${BASE}/info`,
  threads: `${BASE}/threads`,
  open: `${BASE}/open`,
  send: `${BASE}/send`,
  status: `${BASE}/status`,
  approve: `${BASE}/approve`,
  apply: `${BASE}/apply`,
  stop: `${BASE}/stop`,
  thread: `${BASE}/thread`,
} as const;

export type RouteName = keyof typeof ROUTES;

/** Routes served by a Zotero window: they carry the pinned `window_id`. */
export const WINDOW_ROUTES: ReadonlySet<RouteName> = new Set(['open', 'send', 'status', 'approve', 'apply', 'stop', 'thread']);

/** The `interface_version` of `info` this command reads. */
export const INTERFACE_VERSION = 1;
