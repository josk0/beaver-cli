import type { CliIO } from '../cli.js';
import { BeaverClient } from '../client/http.js';
import type { WindowInfo } from '../client/types.js';
import { EXIT_CODES } from '../core/errors.js';
import { errorInfo, writeError, writeJson, type ErrorInfo } from './output.js';

export interface StatusReport {
  /** The port probed; not part of the JSON output. */
  port: number;
  reachable: boolean;
  beaver_available: boolean;
  plugin_version: string | null;
  interface_version: number | null;
  default_window_id: string | null;
  windows: number;
  error: ErrorInfo | null;
}

/** Probes Zotero and Beaver's chat routes. Never throws. */
export async function collectStatus(port: number): Promise<StatusReport> {
  const report: StatusReport = {
    port,
    reachable: false,
    beaver_available: false,
    plugin_version: null,
    interface_version: null,
    default_window_id: null,
    windows: 0,
    error: null,
  };
  try {
    const info = await new BeaverClient({ port }).info();
    report.reachable = true;
    report.beaver_available = true;
    report.plugin_version = info.plugin_version ?? null;
    report.interface_version = info.interface_version;
    report.default_window_id = info.default_window_id ?? null;
    report.windows = info.windows.length;
  } catch (e) {
    const info = errorInfo(e, port);
    report.error = info;
    // Anything but a refused connection means a server answered.
    report.reachable = info.code !== 'zotero_unreachable';
  }
  return report;
}

export function formatStatus(r: StatusReport): string {
  const beaver = r.beaver_available
    ? `available${r.plugin_version ? ` (${r.plugin_version})` : ''}`
    : r.error?.code === 'not_authenticated'
      ? 'signed out'
      : r.error?.code === 'beaver_unavailable'
        ? 'terminal access off, or not in this build'
        : 'not available';
  const lines = [`Zotero: ${r.reachable ? 'reachable' : `not running (nothing answers on port ${r.port})`}`];
  if (r.reachable) lines.push(`Beaver: ${beaver}`);
  if (r.beaver_available) lines.push(`Windows: ${r.windows}${r.default_window_id ? ` (default ${r.default_window_id})` : ''}`);
  return lines.join('\n');
}

export async function runStatus(opts: { port: number; json: boolean }, io: CliIO): Promise<number> {
  const report = await collectStatus(opts.port);
  const { port: _port, ...shown } = report;
  if (opts.json) writeJson(io, { ...shown });
  else {
    io.stdout.write(`${formatStatus(report)}\n`);
    if (report.error) writeError(io, report.error);
  }
  return report.error ? EXIT_CODES[report.error.code] : 0;
}

export async function runWindows(opts: { port: number; json: boolean }, io: CliIO): Promise<number> {
  let windows: WindowInfo[] = [];
  let defaultId: string | null = null;
  let error: ErrorInfo | null = null;
  try {
    const info = await new BeaverClient({ port: opts.port }).info();
    windows = info.windows;
    defaultId = info.default_window_id ?? null;
  } catch (e) {
    error = errorInfo(e, opts.port);
  }
  if (opts.json) {
    writeJson(io, { windows: windows.map((w) => ({ id: w.id, kind: w.kind, status: w.status })), default_window_id: defaultId, error });
  } else {
    if (windows.length > 0) {
      io.stdout.write(`${windows.map((w) => `${w.id}  ${w.kind}  ${w.status}${w.id === defaultId ? '  (default)' : ''}`).join('\n')}\n`);
    } else if (!error) io.stdout.write('No Zotero window runs Beaver.\n');
    if (error) writeError(io, error);
  }
  return error ? EXIT_CODES[error.code] : 0;
}
