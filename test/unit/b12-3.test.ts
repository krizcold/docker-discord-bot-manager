import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWizardEnvList } from '../../src/env/envList';
import { applyVariableSubstitution } from '../../src/templates/variableSubstitution';

const COMPOSE = 'services:\n  gw:\n    image: example/gw\n    environment:\n      USER: ${WEBUI_USER}\n      PASSWORD: ${WEBUI_PASSWORD}\n';

describe('B12-3 gateway login rows describe what a blank does', () => {
  it('says a blank at install or rebuild leaves the login off, and keeps it on a later start', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b12-3-'));
    try {
      fs.writeFileSync(path.join(dir, 'docker-compose.yml'), COMPOSE);
      const { vars } = buildWizardEnvList(dir);
      const rows = vars.filter(v => v.key === 'WEBUI_USER' || v.key === 'WEBUI_PASSWORD');
      expect(rows.length).toBe(2);
      for (const r of rows) {
        expect(r.description).toMatch(/blank at install or rebuild leaves the login off/i);
        expect(r.description).toMatch(/blank on a later start keeps the current login/i);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('install and rebuild substitute a blank login as empty, so the gateway has no login', () => {
    const bot: any = { id: 'b123', envVars: { WEBUI_USER: '', WEBUI_PASSWORD: '' } };
    const out = applyVariableSubstitution(COMPOSE, bot);
    expect(out).toMatch(/USER: *(''|"")?\s*\n/);
    expect(out).toMatch(/PASSWORD: *(''|"")?\s*(\n|$)/);
    expect(out).not.toContain('${WEBUI_');
  });

  it('README limits the kept login to start and restart', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '../../README.md'), 'utf8');
    const line = readme.split('\n').find(l => l.includes('$WEBUI_USER') && l.includes('Env')) || '';
    expect(line).toMatch(/On a start or restart a blank keeps the current login/);
    expect(line).toMatch(/at install or rebuild a blank leaves the gateway without a login/);
  });
});
