/**
 * Shared "copy the example config" template resolver. For a config file a repo
 * does not ship directly (commonly gitignored and provided as a template), find a
 * sibling template variant: example.NAME.EXT, NAME.EXT.example, NAME.example.EXT
 * (and .sample/.dist/.template/.default). Used by both config detection (the
 * install wizard) and volume delivery so the two stay consistent.
 */
import * as fs from 'fs';
import * as path from 'path';

export function findConfigTemplate(filePath: string): string | null {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const markers = ['example', 'sample', 'dist', 'template', 'default'];
  const names: string[] = [];
  for (const m of markers) {
    names.push(`${m}.${base}`);
    names.push(`${base}.${m}`);
    if (ext) names.push(`${stem}.${m}${ext}`);
  }
  for (const name of names) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  return null;
}
