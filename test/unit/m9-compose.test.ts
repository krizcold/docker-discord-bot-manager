import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';

const root = path.join(__dirname, '..', '..');
// Merge keys are applied, so a value that reaches a service through an anchor is seen by every row.
const load = (f: string): any => YAML.parse(fs.readFileSync(path.join(root, f), 'utf8'), { merge: true });
const keysIn = (v: unknown): string[] => (v && typeof v === 'object'
  ? Object.entries(v as object).flatMap(([k, inner]) => [...(Array.isArray(v) ? [] : [k]), ...keysIn(inner)])
  : []);
const y = load('docker-compose.yml');
const shield = y.services.discordbotmanager;
const app = y.services.discordbotmanagerapp;
const term = y.services.discordbotmanagerterminal || {};

const list = (v: unknown): any[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v as object) : v === undefined ? [] : [v]);
const envKeys = (svc: any): string[] => {
  const env = svc.environment || {};
  return Array.isArray(env) ? env.map((e: string) => String(e).split('=')[0]) : Object.keys(env);
};
const mountsOf = (svc: any, volume: string): any[] => (svc.volumes || []).filter((v: any) =>
  typeof v === 'string' ? v.split(':')[0] === volume : v.type === 'volume' && v.source === volume);
const under = (file: string, folder: string): boolean => path.posix.dirname(path.posix.normalize(file)) === path.posix.normalize(folder);

describe('M9: the Yundera terminal service in the compose and the image', () => {
  it("1. the terminal runs the manager's image", () => {
    expect(typeof app.image).toBe('string');
    expect(term.image).toBe(app.image);
  });

  it('2. its only volume is the named socket volume, read-only, and nothing names the Docker socket', () => {
    expect(term.volumes).toEqual([{ type: 'volume', source: 'manager_socket', target: '/run/dbm', read_only: true }]);
    expect(Object.keys(y.volumes || {})).toContain('manager_socket');
    expect(JSON.stringify(term)).not.toContain('docker.sock');
    expect(term.volumes_from).toBeUndefined();
  });

  it('3. it is on the terminal network only, which is internal and shared with AppShield alone', () => {
    expect(list(term.networks)).toEqual(['terminal']);
    expect(term.network_mode).toBeUndefined();
    expect(y.networks.terminal.internal).toBe(true);
    expect(y.networks.terminal.external).toBeUndefined();
    const members = Object.keys(y.services).filter((name) => list(y.services[name].networks).includes('terminal')).sort();
    expect(members).toEqual(['discordbotmanager', 'discordbotmanagerterminal']);
    expect(list(app.networks)).not.toContain('terminal');
    expect(list(shield.networks).sort()).toEqual(['internal', 'pcs', 'terminal']);
  });

  it('4. it publishes nothing, holds no privilege and runs as the user the manager gives the socket to', () => {
    expect(term.ports).toBeUndefined();
    expect(term.privileged).toBeUndefined();
    expect(term.cap_add).toBeUndefined();
    expect(term.pid).toBeUndefined();
    expect(term.devices).toBeUndefined();
    expect(list(term.labels).filter((l) => /caddy/i.test(String(l)))).toEqual([]);
    expect(term.cap_drop).toEqual(['ALL']);
    expect(term.security_opt).toEqual(['no-new-privileges:true']);
    expect(term.read_only).toBe(true);
    expect(app.environment.MANAGER_SOCKET_OWNER).toBe('1000:1000');
    expect(term.user).toBe(app.environment.MANAGER_SOCKET_OWNER);
  });

  it('5. ttyd runs dbm directly: writable, origin-checked, one client, on the port AppShield calls', () => {
    const e: string[] = term.entrypoint || [];
    expect(Array.isArray(e)).toBe(true);
    expect(e[0]).toBe('ttyd');
    expect(e).toContain('-W');
    expect(e).toContain('-O');
    expect(e[e.indexOf('-m') + 1]).toBe('1');
    expect(e.indexOf('-m')).toBeGreaterThan(0);
    expect(e.indexOf('-p')).toBeGreaterThan(0);
    expect(e[e.indexOf('-p') + 1]).toBe(String(shield.environment.BACKEND_PORT));
    for (const banned of ['-a', '--url-arg', '-c', '--credential', '-H', '--auth-header', 'sh', 'bash', '/bin/sh', '/bin/bash']) {
      expect(e).not.toContain(banned);
    }
    expect(e.slice(-2)).toEqual(['node', '/app/dist/cli/dbm.js']);
    expect(e.indexOf('node')).toBe(e.length - 2);
    expect(term.command).toBeUndefined();
  });

  it("6. it gets the manager's socket path and data paths, and no check hook", () => {
    const env = term.environment || {};
    expect(app.environment.MANAGER_SOCKET).toBe('/run/dbm/manager.sock');
    expect(env.DBM_SOCKET).toBe(app.environment.MANAGER_SOCKET);
    const termMount = mountsOf(term, 'manager_socket')[0] || {};
    const appMount = mountsOf(app, 'manager_socket')[0] || {};
    expect(under(String(env.DBM_SOCKET), String(termMount.target))).toBe(true);
    expect(under(String(app.environment.MANAGER_SOCKET), String(appMount.target))).toBe(true);
    expect(env.DATA_DIR).toBe(app.environment.DATA_DIR);
    expect(env.HOST_DATA_DIR).toBe(app.environment.HOST_DATA_DIR);
    expect(typeof env.HOST_DATA_DIR).toBe('string');
    expect(envKeys(term).filter((k) => k.startsWith('DBM_TUI_CHECK_'))).toEqual([]);
    expect(envKeys(term)).not.toContain('PORT');
  });

  it('7. the socket volume is mounted by the manager, writable, and the terminal only', () => {
    const users = Object.keys(y.services).filter((name) => mountsOf(y.services[name], 'manager_socket').length > 0).sort();
    expect(users).toEqual(['discordbotmanagerapp', 'discordbotmanagerterminal']);
    const appMounts = mountsOf(app, 'manager_socket');
    expect(appMounts).toHaveLength(1);
    expect(appMounts[0].read_only).toBeUndefined();
    expect(y.volumes.manager_socket?.external).toBeUndefined();
  });

  it("8. AppShield's backend is the manager's gate alias or the terminal service", () => {
    expect(['discordbotmanagerapp-gate', 'discordbotmanagerterminal']).toContain(shield.environment.BACKEND_HOST);
    expect(app.networks.internal.aliases).toContain('discordbotmanagerapp-gate');
    expect(term.container_name).toBe('discordbotmanagerterminal');
    expect(shield.environment.BACKEND_PORT).toBe('8080');
  });

  it("9. AppShield lets no path through without its login", () => {
    const keys = envKeys(shield);
    for (const k of ['ALLOWED_PATHS', 'ALLOWED_EXTENSIONS', 'ALLOW_HASH_CONTENT_PATHS']) {
      expect(keys).not.toContain(k);
    }
  });

  it('10. the remote and standalone composes have no ttyd service and no MANAGER_SOCKET', () => {
    for (const f of ['docker-compose.remote.yml', 'docker-compose.standalone.yml']) {
      const other = load(f);
      for (const svc of Object.values<any>(other.services)) {
        expect(JSON.stringify([svc.command ?? null, svc.entrypoint ?? null])).not.toContain('ttyd');
        expect(envKeys(svc).filter((k) => k.startsWith('MANAGER_SOCKET') || k === 'DBM_SOCKET')).toEqual([]);
      }
    }
  });

  it('12. the terminal service is written out in full: no extends, no env_file and no merge key', () => {
    const unmerged = YAML.parse(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')).services.discordbotmanagerterminal;
    expect(keysIn(unmerged).filter((k) => k === '<<' || k === 'extends' || k === 'env_file')).toEqual([]);
    expect(term.extends).toBeUndefined();
    expect(term.env_file).toBeUndefined();
    const anchored = ['base: &b', '  env_file: x', 'svc:', '  <<: *b', '  environment:', '    <<: *b', ''].join('\n');
    expect(keysIn(YAML.parse(anchored).svc)).toEqual(['<<', 'env_file', 'environment', '<<', 'env_file']);
    expect(YAML.parse(anchored, { merge: true }).svc).toEqual({ env_file: 'x', environment: { env_file: 'x' } });
  });

  it("11. the image's last stage installs ttyd 1.7.7 with apk and runs it once", () => {
    const text = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').replace(/\\\r?\n/g, ' ');
    const lines = text.split(/\r?\n/);
    const lastFrom = lines.map((l) => /^FROM\s/i.test(l)).lastIndexOf(true);
    const stage = lines.slice(lastFrom + 1);
    const apk = stage.filter((l) => /^RUN\s/.test(l) && /\bapk add\b/.test(l) && /(^|\s)'?ttyd~1\.7\.7'?(\s|$)/.test(l));
    expect(lastFrom).toBeGreaterThan(0);
    expect(apk).toHaveLength(1);
    expect(stage.indexOf('RUN ttyd --version')).toBeGreaterThan(stage.indexOf(apk[0]));
  });
});
