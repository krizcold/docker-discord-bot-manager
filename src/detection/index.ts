/**
 * Bot Type Detection
 * Detects language, package manager, services, and env vars from repository contents
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';
import { BotType, DatabaseKind, DetectedConfigFile, DetectionResult, PackageManager, SystemDep } from '../types';
import { configFileFormat, extractConfigKeys, scanSourceForEnvVars } from '../env/manager';

/**
 * Detect bot type from repository path
 * Priority order: Dockerfile > docker-compose.yml > language detection
 */
export function detectBotType(repoPath: string): DetectionResult {
  const result: DetectionResult = {
    type: 'unknown',
    hasDockerfile: false,
    hasCompose: false,
    hasDatabase: false,
    databases: [],
    needsLavalink: false,
    hasMusic: false,
    hasWebDashboard: false,
    systemDeps: [],
    tokenVarName: 'DISCORD_TOKEN',
    isTypeScript: false,
    configFiles: [],
  };

  if (fs.existsSync(path.join(repoPath, 'Dockerfile'))) {
    result.hasDockerfile = true;
    result.type = 'dockerfile';
  }

  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  const composeDbKinds: DatabaseKind[] = [];
  for (const composeFile of composeFiles) {
    const composePath = path.join(repoPath, composeFile);
    if (fs.existsSync(composePath)) {
      result.hasCompose = true;
      result.type = 'compose';
      const content = fs.readFileSync(composePath, 'utf-8').toLowerCase();
      composeDbKinds.push(...detectDatabasesInCompose(content));
      break;
    }
  }

  // Language detection runs unless an existing compose already pins the build path
  if (result.type === 'unknown' || result.type === 'dockerfile') {
    const lang = detectLanguage(repoPath);
    if (result.type === 'unknown') {
      result.type = lang.type;
    }
    result.packageManager = lang.packageManager;
    result.entryPoint = lang.entryPoint;
    result.isTypeScript = lang.isTypeScript === true;
    result.packageName = lang.packageName;
    result.jarPattern = lang.jarPattern;
    result.prebuiltJar = lang.prebuiltJar;
  }

  const { deps, rawText } = readDependencies(repoPath);
  const caps = detectCapabilities(repoPath, deps, rawText);
  result.databases = [...new Set<DatabaseKind>([...composeDbKinds, ...caps.databases])];
  result.hasDatabase = result.databases.length > 0 || caps.hasOrmHint;
  result.hasMusic = caps.hasMusic;
  result.needsLavalink = caps.needsLavalink;
  result.hasWebDashboard = caps.hasWebDashboard;
  result.systemDeps = caps.systemDeps;

  result.tokenVarName = detectTokenVarName(repoPath);
  result.configFiles = detectConfigFiles(repoPath);
  result.interactiveSetup = detectInteractiveSetup(repoPath, deps, rawText);

  console.log(`[Detection] type=${result.type} pm=${result.packageManager || '-'} databases=[${result.databases.join(',')}] music=${result.hasMusic} lavalink=${result.needsLavalink} web=${result.hasWebDashboard} token=${result.tokenVarName} configFiles=[${result.configFiles.map(c => c.targetName).join(',')}]`);
  return result;
}

interface LanguageResult {
  type: BotType;
  packageManager?: PackageManager;
  entryPoint?: string;
  isTypeScript?: boolean;
  packageName?: string;
  jarPattern?: string;
  prebuiltJar?: boolean;
}

/**
 * Detect programming language and package manager (PLAN 3.3 cascade)
 */
function detectLanguage(repoPath: string): LanguageResult {
  const has = (f: string) => fs.existsSync(path.join(repoPath, f));

  if (has('package.json')) {
    return detectNode(repoPath);
  }

  // Python: requirements.txt wins, then Pipfile, then pyproject variants, then setup.py
  if (has('requirements.txt')) {
    return { type: 'python', packageManager: 'pip', entryPoint: detectPythonEntryPoint(repoPath) };
  }
  if (has('Pipfile')) {
    return { type: 'python', packageManager: 'pipenv', entryPoint: detectPythonEntryPoint(repoPath) };
  }
  if (has('pyproject.toml')) {
    let pm: PackageManager = 'setuptools';
    if (has('uv.lock')) pm = 'uv';
    else if (has('poetry.lock')) pm = 'poetry';
    return { type: 'python', packageManager: pm, entryPoint: detectPythonEntryPoint(repoPath) };
  }
  if (has('setup.py')) {
    return { type: 'python', packageManager: 'setuptools', entryPoint: detectPythonEntryPoint(repoPath) };
  }

  if (has('go.mod')) {
    return { type: 'go', packageManager: 'go', entryPoint: detectGoEntryPoint(repoPath) };
  }

  if (has('Cargo.toml')) {
    return { type: 'rust', packageManager: 'cargo', packageName: detectRustPackageName(repoPath) };
  }

  if (has('pom.xml')) {
    const shade = /maven-shade-plugin/.test(readFileSafe(path.join(repoPath, 'pom.xml')));
    return { type: 'java', packageManager: 'maven', jarPattern: shade ? 'target/*-shaded.jar' : 'target/*.jar' };
  }
  if (has('build.gradle') || has('build.gradle.kts')) {
    const gradleText = readFileSafe(path.join(repoPath, 'build.gradle')) + readFileSafe(path.join(repoPath, 'build.gradle.kts'));
    const shadow = /shadow/i.test(gradleText);
    return { type: 'java', packageManager: 'gradle', jarPattern: shadow ? 'build/libs/*-all.jar' : 'build/libs/*.jar' };
  }
  if (findFirstFile(repoPath, /\.jar$/i)) {
    return { type: 'java', prebuiltJar: true, jarPattern: '*.jar' };
  }

  if (findFirstFile(repoPath, /\.csproj$/i) || findFirstFile(repoPath, /\.sln$/i)) {
    return { type: 'csharp', packageManager: 'dotnet', packageName: detectCsharpAssembly(repoPath) };
  }

  return { type: 'unknown' };
}

function detectNode(repoPath: string): LanguageResult {
  let pkg: any = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8'));
  } catch {
    return { type: 'nodejs', packageManager: 'npm' };
  }

  let packageManager: PackageManager = 'npm';
  if (fs.existsSync(path.join(repoPath, 'bun.lockb')) || fs.existsSync(path.join(repoPath, 'bun.lock'))) {
    packageManager = 'bun';
  } else if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) {
    packageManager = 'pnpm';
  } else if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) {
    packageManager = 'yarn';
  }

  const isTypeScript = fs.existsSync(path.join(repoPath, 'tsconfig.json'));
  return { type: 'nodejs', packageManager, entryPoint: detectNodeEntryPoint(repoPath, pkg, isTypeScript), isTypeScript };
}

function detectNodeEntryPoint(repoPath: string, pkg: any, isTypeScript: boolean): string | undefined {
  if (pkg?.scripts?.start) return undefined;   // Dockerfile uses `npm start`
  if (isTypeScript) return undefined;           // build output unknown; template defaults to dist/index.js
  if (typeof pkg?.main === 'string' && pkg.main.trim()) return pkg.main;
  for (const c of ['index.js', 'bot.js', 'app.js', 'main.js', 'src/index.js', 'src/bot.js']) {
    if (fs.existsSync(path.join(repoPath, c))) return c;
  }
  return undefined;
}

function detectPythonEntryPoint(repoPath: string): string | undefined {
  for (const c of ['bot.py', 'main.py', 'run.py', 'app.py', 'index.py', 'launcher.py', '__main__.py']) {
    if (fs.existsSync(path.join(repoPath, c))) return c;
  }
  return undefined;
}

function detectGoEntryPoint(repoPath: string): string {
  if (fs.existsSync(path.join(repoPath, 'main.go'))) return '.';
  const cmdDir = path.join(repoPath, 'cmd');
  if (fs.existsSync(cmdDir)) {
    try {
      for (const entry of fs.readdirSync(cmdDir, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(cmdDir, entry.name, 'main.go'))) {
          return `./cmd/${entry.name}`;
        }
      }
    } catch {
      // ignore
    }
  }
  return '.';
}

function detectRustPackageName(repoPath: string): string | undefined {
  const text = readFileSafe(path.join(repoPath, 'Cargo.toml'));
  const pkgSection = text.match(/\[package\]([\s\S]*?)(\n\[|$)/);
  const scope = pkgSection ? pkgSection[1] : text;
  const m = scope.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  return m ? m[1] : undefined;
}

function detectCsharpAssembly(repoPath: string): string | undefined {
  const csproj = findFirstFile(repoPath, /\.csproj$/i);
  if (!csproj) return undefined;
  const m = readFileSafe(csproj).match(/<AssemblyName>([^<]+)<\/AssemblyName>/i);
  if (m) return m[1].trim();
  return path.basename(csproj, path.extname(csproj));
}

interface CapabilityResult {
  databases: DatabaseKind[];
  hasMusic: boolean;
  needsLavalink: boolean;
  hasWebDashboard: boolean;
  systemDeps: SystemDep[];
  hasOrmHint: boolean;
}

function detectCapabilities(repoPath: string, deps: string[], rawText: string): CapabilityResult {
  const hay = deps.join(' ') + ' ' + rawText;
  const includesAny = (needles: string[]) => needles.some(n => deps.includes(n) || hay.includes(n));

  const databases = new Set<DatabaseKind>();
  if (includesAny(['pg', 'postgres', 'postgresql', 'asyncpg', 'psycopg', 'psycopg2'])) databases.add('postgres');
  if (includesAny(['mongoose', 'mongodb', 'pymongo', 'motor'])) databases.add('mongo');
  if (includesAny(['mariadb'])) databases.add('mariadb');
  if (includesAny(['mysql2', 'mysql', 'pymysql'])) databases.add('mysql');
  if (includesAny(['redis', 'ioredis', 'aioredis'])) databases.add('redis');
  if (includesAny(['better-sqlite3', 'sqlite3', 'aiosqlite'])) databases.add('sqlite');

  const hasOrmHint = includesAny(['prisma', 'sequelize', 'typeorm', 'knex', 'drizzle-orm', 'sqlalchemy', 'tortoise-orm', 'databases']);

  const lavalinkLibs = ['erela.js', 'shoukaku', 'lavalink-client', 'lavacord', '@lavaclient/queue', 'lavalink', 'wavelink', 'pomice'];
  const musicLibs = ['@discordjs/voice', '@discordjs/opus', 'discord-player', 'ffmpeg-static', 'pynacl', ...lavalinkLibs];
  const needsLavalink = includesAny(lavalinkLibs)
    || fs.existsSync(path.join(repoPath, 'application.yml'))
    || fs.existsSync(path.join(repoPath, 'application.yaml'));
  const hasMusic = needsLavalink || includesAny(musicLibs) || hay.includes('discord.py[voice]');

  const hasWebDashboard = includesAny(['express', 'fastify', 'koa', 'next', '@nestjs/core', 'flask', 'fastapi', 'django', 'aiohttp']);

  const systemDeps = new Set<SystemDep>();
  if (hasMusic) systemDeps.add('ffmpeg');
  if (hasMusic || includesAny(['pynacl', '@discordjs/opus'])) {
    systemDeps.add('libopus');
    systemDeps.add('libsodium');
  }
  if (includesAny(['canvas', 'better-sqlite3', 'bcrypt', 'node-gyp', 'sharp'])) systemDeps.add('build-essential');
  if (includesAny(['canvas'])) systemDeps.add('libcairo');

  return {
    databases: [...databases],
    hasMusic,
    needsLavalink,
    hasWebDashboard,
    systemDeps: [...systemDeps],
    hasOrmHint,
  };
}

function detectDatabasesInCompose(content: string): DatabaseKind[] {
  const kinds = new Set<DatabaseKind>();
  if (/postgres/.test(content)) kinds.add('postgres');
  if (/\bmongo/.test(content)) kinds.add('mongo');
  if (/mariadb/.test(content)) kinds.add('mariadb');
  if (/\bmysql/.test(content)) kinds.add('mysql');
  if (/\bredis/.test(content)) kinds.add('redis');
  return [...kinds];
}

/**
 * Detect the Discord token env var name (PLAN 3.5 scan order)
 */
function detectTokenVarName(repoPath: string): string {
  const TOKEN_RE = /^(DISCORD_)?(BOT_|CLIENT_)?TOKEN$/i;

  for (const f of ['.env.example', '.env.sample', 'example.env']) {
    const text = readFileSafe(path.join(repoPath, f));
    if (!text) continue;
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/i);
      if (m && TOKEN_RE.test(m[1])) return m[1];
    }
  }

  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const text = readFileSafe(path.join(repoPath, f));
    if (!text) continue;
    const m = text.match(/\b((?:DISCORD_)?(?:BOT_|CLIENT_)?TOKEN)\b/);
    if (m) return m[1];
    break;
  }

  for (const f of ['config.example.json', 'config.json.example']) {
    const text = readFileSafe(path.join(repoPath, f));
    if (!text) continue;
    try {
      const cfg = JSON.parse(text);
      const key = Object.keys(cfg).find(k => /token/i.test(k));
      if (key) return key;
    } catch {
      // ignore
    }
    break;
  }

  for (const key of scanSourceForEnvVars(repoPath)) {
    if (TOKEN_RE.test(key)) return key;
  }

  return 'DISCORD_TOKEN';
}

/**
 * Collect dependency names (lowercased) and raw manifest text for capability scanning
 */
function readDependencies(repoPath: string): { deps: string[]; rawText: string } {
  const deps = new Set<string>();
  let rawText = '';

  const pkgPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        deps.add(name.toLowerCase());
      }
    } catch {
      // ignore
    }
  }

  for (const f of ['Pipfile', 'pyproject.toml', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts']) {
    rawText += readFileSafe(path.join(repoPath, f)).toLowerCase() + '\n';
  }
  const csproj = findFirstFile(repoPath, /\.csproj$/i);
  if (csproj) rawText += readFileSafe(csproj).toLowerCase() + '\n';

  const reqText = readFileSafe(path.join(repoPath, 'requirements.txt'));
  for (const line of reqText.split('\n')) {
    const name = line.split(/[=<>!~ \[;]/)[0].trim().toLowerCase();
    if (name && !name.startsWith('#')) deps.add(name);
  }

  return { deps: [...deps], rawText };
}

function readFileSafe(p: string): string {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  } catch {
    return '';
  }
}

function findFirstFile(root: string, pattern: RegExp, maxDepth = 2): string | null {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && pattern.test(entry.name)) return full;
      if (entry.isDirectory() && depth < maxDepth && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return null;
}

/**
 * Strip an example/sample/dist/template marker from a template file name to get
 * the real config file name (config.json.example -> config.json,
 * config.example.json -> config.json, example.config.py -> config.py).
 */
function stripExampleMarker(name: string): string {
  return name
    .replace(/\.(example|sample|dist|template)$/i, '')
    .replace(/[._-](example|sample|dist|template)(\.[^.]+)$/i, '$2')
    .replace(/^(example|sample|dist|template)[._-]/i, '');
}

const CONFIG_TARGET_RE = /\.(json|ya?ml|toml|js|cjs|mjs|py|txt|conf|ini|properties|json5)$/i;
const CONFIG_NAME_RE = /^(config|configuration|creds|credentials|settings)/i;

/**
 * Best-effort in-container mount path for a config file: reuse a matching bind
 * from the repo's own compose, else default under /app.
 */
function findInContainerPath(repoPath: string, targetName: string): string | null {
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const text = readFileSafe(path.join(repoPath, f));
    if (!text) continue;
    try {
      const compose = parseDocument(text).toJSON() as Record<string, any>;
      const services = compose?.services as Record<string, any> | undefined;
      if (!services) return null;
      for (const service of Object.values(services)) {
        if (!Array.isArray(service?.volumes)) continue;
        for (const vol of service.volumes) {
          let target: string | null = null;
          if (typeof vol === 'string') {
            const parts = vol.split(':');
            if (parts.length >= 2) target = parts[1];
          } else if (vol && typeof vol === 'object' && typeof vol.target === 'string') {
            target = vol.target;
          }
          if (target && path.basename(target) === targetName) return target;
        }
      }
    } catch {
      // ignore malformed compose
    }
    return null;
  }
  return null;
}

/**
 * Detect config-file templates a repo ships (config.json.example etc.). Scans
 * the repo root and a top-level config/ dir for *.example / *.sample files that
 * resolve to a config-looking target name.
 */
function detectConfigFiles(repoPath: string): DetectedConfigFile[] {
  const out: DetectedConfigFile[] = [];
  const seen = new Set<string>();

  for (const sub of ['.', 'config']) {
    const dir = path.join(repoPath, sub);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!/[._-](example|sample|dist|template)([._-]|$)|^(example|sample|dist|template)[._-]/i.test(name)) continue;

      const targetName = stripExampleMarker(name);
      if (targetName === name) continue;                                   // no marker stripped
      if (/^\.env/i.test(targetName) || /compose/i.test(targetName) || /dockerfile/i.test(targetName)) continue;
      if (!CONFIG_TARGET_RE.test(targetName) && !CONFIG_NAME_RE.test(targetName)) continue;
      if (seen.has(targetName)) continue;

      const rawBody = readFileSafe(path.join(dir, name)).slice(0, 65536);
      if (!rawBody.trim()) continue;

      const format = configFileFormat(targetName);
      const relTarget = sub === '.' ? targetName : `${sub}/${targetName}`;
      seen.add(targetName);
      out.push({
        exampleName: sub === '.' ? name : `${sub}/${name}`,
        targetName,
        format,
        inContainerPath: findInContainerPath(repoPath, targetName) || `/app/${relTarget}`,
        keys: extractConfigKeys(rawBody, format),
        rawBody,
      });
    }
  }

  return out;
}

/**
 * Detect bots that require an interactive first-run step the manager cannot run
 * unattended. Returns guidance for the wizard, not a hard block.
 */
function detectInteractiveSetup(
  repoPath: string,
  deps: string[],
  rawText: string
): { reason: string; advice: string } | undefined {
  const hay = deps.join(' ') + ' ' + rawText.toLowerCase();

  if (deps.includes('red-discordbot') || /red-discordbot|\bredbot\b/.test(hay)) {
    return {
      reason: 'Red-DiscordBot uses an interactive redbot-setup step that cannot run unattended.',
      advice: 'Add this bot as a Docker image source instead (e.g. phasecorex/red-discordbot), which is fully configurable via environment variables.',
    };
  }

  if (fs.existsSync(path.join(repoPath, 'src', 'main', 'resources', 'reference.conf')) || /jmusicbot/.test(hay)) {
    return {
      reason: 'This bot prompts for input on first run if its config file is missing or incomplete.',
      advice: 'Paste a complete config file (e.g. config.txt) in the Config Files section below so it starts without prompting.',
    };
  }

  return undefined;
}

/**
 * Get display name for bot type
 */
export function getBotTypeDisplayName(type: BotType): string {
  const names: Record<BotType, string> = {
    nodejs: 'Node.js',
    python: 'Python',
    go: 'Go',
    java: 'Java',
    rust: 'Rust',
    csharp: 'C#',
    dockerfile: 'Custom Dockerfile',
    compose: 'Docker Compose',
    unknown: 'Unknown'
  };
  return names[type];
}
