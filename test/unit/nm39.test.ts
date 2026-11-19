import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processComposeForCasaOS } from '../../src/templates/pcsProcessing';
import { substituteComposeNames } from '../../src/compose/nameSubstitution';
import { applyVariableSubstitution, substituteVariablesInNames } from '../../src/templates/variableSubstitution';

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['DATA_ROOT', 'APP_DOMAIN', 'APP_PUBLIC_IP_DASH'];
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DATA_ROOT = '/DATA';
  delete process.env.APP_DOMAIN;
  delete process.env.APP_PUBLIC_IP_DASH;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

type Mode = 'casaos' | 'docker';
const bot = (appName: string): any => ({ id: 'b1', displayName: 'Bot', sanitizedName: appName, envVars: {} });

// The build's order: name substitution when the compose has a top-level name, then processing with the names it scoped.
const render = (source: string, sourceName: string | null, appName: string, mode: Mode): string => {
  const sub: any = sourceName ? substituteComposeNames(source, sourceName, appName) : { content: source };
  const opts: any = { mode, hostBotDir: '/srv/b1', scopedContainerNames: sub.scopedContainerNames };
  return processComposeForCasaOS(sub.content, appName, bot(appName), opts).content;
};
// The git build's order with bot env vars: name substitution, variable substitution of the compose and of the scoped names, processing.
const builtWithEnv = (source: string, sourceName: string, appName: string, envVars: Record<string, string>, mode: Mode): any => {
  const b = { ...bot(appName), envVars };
  const sub = substituteComposeNames(source, sourceName, appName);
  const content = applyVariableSubstitution(sub.content, b);
  const scopedContainerNames = substituteVariablesInNames(sub.scopedContainerNames, b);
  return YAML.parse(processComposeForCasaOS(content, appName, b, { mode, hostBotDir: '/srv/b1', scopedContainerNames }).content);
};
const deployed = (source: string, sourceName: string | null, appName: string, mode: Mode): any =>
  YAML.parse(render(source, sourceName, appName, mode));

const ownShape = [
  'name: nbot',
  'services:',
  '  nbotapp:',
  '    image: example/bot:1',
  '    container_name: nbotapp',
  '  helper:',
  '    image: example/helper:1',
  '    network_mode: "container:nbotapp"',
  '    volumes_from: ["container:nbotapp:ro"]',
  '    ipc: "container:nbotapp"',
  '    pid: "container:redis"',
  '  cache:',
  '    image: redis:7',
  '    container_name: redis',
  '  probe:',
  '    image: example/probe:1',
  '    network_mode: "container:redis"',
  '    ipc: "container:redis"',
  '    pid: "container:nbotapp"',
  '  plain:',
  '    image: example/plain:1',
  '  beside:',
  '    image: example/beside:1',
  '    network_mode: "container:nbot-plain-1"',
  '',
].join('\n');

describe('NM39 a container name the name substitution scoped gets no app-name prefix', () => {
  for (const mode of ['casaos', 'docker'] as const) {
    it(`${mode} mode: the app container of a compose named after the app keeps its name`, () => {
      const doc = deployed(ownShape, 'nbot', 'nbot', mode);
      expect(doc.services.nbotapp.container_name).toBe('nbotapp');
      expect(doc.services.nbotapp.networks?.default?.aliases).toBeUndefined();
    });

    it(`${mode} mode: a second instance gets the substituted name with no prefix`, () => {
      const doc = deployed(ownShape, 'nbot', 'n2', mode);
      expect(doc.services.n2app.container_name).toBe('n2app');
      expect(doc.services.n2app.networks?.default?.aliases).toBeUndefined();
    });

    it(`${mode} mode: a container_name without the compose name is prefixed and keeps its alias`, () => {
      for (const appName of ['nbot', 'n2']) {
        const doc = deployed(ownShape, 'nbot', appName, mode);
        expect(doc.services.cache.container_name).toBe(`${appName}-redis`);
        expect(doc.services.cache.networks.default.aliases).toEqual(['redis']);
      }
    });

    it(`${mode} mode: a compose with no top-level name has every fixed container_name prefixed`, () => {
      const source = [
        'services:',
        '  worker:',
        '    image: w',
        '    container_name: mybot1db',
        '  side:',
        '    image: s',
        '    container_name: bot1app',
        '  joined:',
        '    image: j',
        '    network_mode: "container:bot1app"',
        '  scoped:',
        '    image: s',
        '    container_name: bot1-scoped',
        '',
      ].join('\n');
      const doc = deployed(source, null, 'bot1', mode);
      expect(doc.services.worker.container_name).toBe('bot1-mybot1db');
      expect(doc.services.worker.networks.default.aliases).toEqual(['mybot1db']);
      expect(doc.services.side.container_name).toBe('bot1-bot1app');
      expect(doc.services.side.networks.default.aliases).toEqual(['bot1app']);
      expect(doc.services.joined.network_mode).toBe('container:bot1-bot1app');
      expect(doc.services.scoped.container_name).toBe('bot1-scoped');
    });

    it(`${mode} mode: a container_name equal to the compose name, or starting with it and a hyphen, stays as substituted`, () => {
      const source = [
        'name: nbot',
        'services:',
        '  web:',
        '    image: w',
        '    container_name: nbot',
        '    ports: ["8080:80"]',
        '  side:',
        '    image: s',
        '    container_name: nbot-side',
        'x-casaos:',
        '  main: web',
        '',
      ].join('\n');
      for (const appName of ['nbot', 'n2']) {
        const doc = deployed(source, 'nbot', appName, mode);
        expect(doc.services.web.container_name).toBe(appName);
        expect(doc.services.side.container_name).toBe(`${appName}-side`);
        expect(doc.services.side.networks?.default?.aliases).toBeUndefined();
      }
    });

    it(`${mode} mode: two services that would end with one container name are refused`, () => {
      const source = [
        'name: nbot',
        'services:',
        '  web:',
        '    image: w',
        '    ports: ["8080:80"]',
        '  kept:',
        '    image: k',
        '    container_name: nbot-redis',
        '  cache:',
        '    image: redis:7',
        '    container_name: redis',
        '',
      ].join('\n');
      expect(() => render(source, 'nbot', 'nbot', mode)).toThrow(
        'Services "kept" and "cache" would both get the container name "nbot-redis"; give one of them another container_name in the compose file.');
      expect(() => render(source, 'nbot', 'n2', mode)).toThrow(
        'Services "kept" and "cache" would both get the container name "n2-redis"; give one of them another container_name in the compose file.');
    });

    it(`${mode} mode: a container reference follows the substitution or the prefix of the container it names`, () => {
      const first = deployed(ownShape, 'nbot', 'nbot', mode);
      expect(first.services.helper.network_mode).toBe('container:nbotapp');
      expect(first.services.helper.volumes_from).toEqual(['container:nbotapp:ro']);
      expect(first.services.helper.ipc).toBe('container:nbotapp');
      expect(first.services.helper.pid).toBe('container:nbot-redis');
      expect(first.services.probe.network_mode).toBe('container:nbot-redis');
      expect(first.services.probe.ipc).toBe('container:nbot-redis');
      expect(first.services.probe.pid).toBe('container:nbotapp');
      expect(first.services.beside.network_mode).toBe('container:nbot-plain-1');
      const second = deployed(ownShape, 'nbot', 'n2', mode);
      expect(second.services.helper.network_mode).toBe('container:n2app');
      expect(second.services.helper.volumes_from).toEqual(['container:n2app:ro']);
      expect(second.services.helper.ipc).toBe('container:n2app');
      expect(second.services.helper.pid).toBe('container:n2-redis');
      expect(second.services.probe.network_mode).toBe('container:n2-redis');
      expect(second.services.probe.ipc).toBe('container:n2-redis');
      expect(second.services.probe.pid).toBe('container:n2app');
      expect(second.services.beside.network_mode).toBe('container:n2-plain-1');
    });

    it(`${mode} mode: a container_name that holds the instance name but not the compose name is prefixed`, () => {
      const source = [
        'name: stack',
        'services:',
        '  stackapp:',
        '    image: a',
        '    container_name: stackapp',
        '  store:',
        '    image: d',
        '    container_name: maindb',
        '',
      ].join('\n');
      for (const appName of ['main', 'db']) {
        const doc = deployed(source, 'stack', appName, mode);
        expect(doc.services.store.container_name).toBe(`${appName}-maindb`);
        expect(doc.services.store.networks.default.aliases).toEqual(['maindb']);
        expect(doc.services[`${appName}app`].container_name).toBe(`${appName}app`);
      }
    });

    it(`${mode} mode: a named compose processed without the substitution's names has every fixed name prefixed`, () => {
      const source = 'name: nbot\nservices:\n  nbotapp:\n    image: a\n    container_name: nbotapp\n  side:\n    image: s\n    container_name: nbot-side\n';
      const doc = YAML.parse(processComposeForCasaOS(source, 'nbot', bot('nbot'), { mode, hostBotDir: '/srv/b1' }).content);
      expect(doc.services.nbotapp.container_name).toBe('nbot-nbotapp');
      expect(doc.services.side.container_name).toBe('nbot-side');
    });

    it(`${mode} mode: a container_name with a variable beside the compose name keeps the substituted name`, () => {
      const source = [
        'name: nbot',
        'services:',
        '  nbotapp:',
        '    image: a',
        '    container_name: nbot_${STAGE}',
        '  other:',
        '    image: o',
        '    container_name: ${STAGE}db',
        '',
      ].join('\n');
      for (const appName of ['nbot', 'n2']) {
        const doc = builtWithEnv(source, 'nbot', appName, { STAGE: 'prod' }, mode);
        expect(doc.services[`${appName}app`].container_name).toBe(`${appName}_prod`);
        expect(doc.services.other.container_name).toBe(`${appName}-proddb`);
      }
    });

    it(`${mode} mode: a reference to a container outside the compose keeps its name`, () => {
      const source = [
        'name: media',
        'services:',
        '  mediaapp:',
        '    image: a',
        '    container_name: mediaapp',
        '    network_mode: "container:media-vpn"',
        '    volumes_from: ["container:media-store:ro"]',
        '',
      ].join('\n');
      const doc = deployed(source, 'media', 'm2', mode);
      expect(doc.services.m2app.container_name).toBe('m2app');
      expect(doc.services.m2app.network_mode).toBe('container:media-vpn');
      expect(doc.services.m2app.volumes_from).toEqual(['container:media-store:ro']);
    });
  }
});
