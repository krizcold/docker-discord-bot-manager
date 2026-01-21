/**
 * Bot Type Detection
 * Detects the type of bot based on repository contents
 */

import * as fs from 'fs';
import * as path from 'path';
import { BotType, DetectionResult } from '../types';

/**
 * Detect bot type from repository path
 * Priority order: Dockerfile > docker-compose.yml > package.json > requirements.txt > go.mod > pom.xml
 */
export function detectBotType(repoPath: string): DetectionResult {
  const result: DetectionResult = {
    type: 'unknown',
    hasDockerfile: false,
    hasCompose: false,
    hasDatabase: false
  };

  // Check for Dockerfile
  const dockerfilePath = path.join(repoPath, 'Dockerfile');
  if (fs.existsSync(dockerfilePath)) {
    result.hasDockerfile = true;
    result.type = 'dockerfile';
  }

  // Check for docker-compose.yml
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const composeFile of composeFiles) {
    const composePath = path.join(repoPath, composeFile);
    if (fs.existsSync(composePath)) {
      result.hasCompose = true;
      result.type = 'compose';

      // Check if compose has database services
      const composeContent = fs.readFileSync(composePath, 'utf-8').toLowerCase();
      result.hasDatabase = detectDatabaseInCompose(composeContent);
      break;
    }
  }

  // If no Docker files, detect by language
  if (result.type === 'unknown' || result.type === 'dockerfile') {
    const languageResult = detectLanguage(repoPath);
    if (result.type === 'unknown') {
      result.type = languageResult.type;
    }
    result.packageManager = languageResult.packageManager;
    result.entryPoint = languageResult.entryPoint;
  }

  // Scan code for database usage patterns if not already detected
  if (!result.hasDatabase) {
    result.hasDatabase = scanForDatabasePatterns(repoPath);
  }

  console.log(`[Detection] Bot type: ${result.type}, hasDockerfile: ${result.hasDockerfile}, hasCompose: ${result.hasCompose}, hasDatabase: ${result.hasDatabase}`);
  return result;
}

/**
 * Detect programming language from repository
 */
function detectLanguage(repoPath: string): {
  type: BotType;
  packageManager?: DetectionResult['packageManager'];
  entryPoint?: string;
} {
  // Node.js detection
  const packageJsonPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      let packageManager: DetectionResult['packageManager'] = 'npm';

      // Detect package manager
      if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) {
        packageManager = 'pnpm';
      } else if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) {
        packageManager = 'yarn';
      }

      // Find entry point
      const entryPoint = pkg.main || pkg.scripts?.start ? undefined : 'index.js';

      return { type: 'nodejs', packageManager, entryPoint };
    } catch {
      return { type: 'nodejs', packageManager: 'npm' };
    }
  }

  // Python detection
  const pythonFiles = ['requirements.txt', 'Pipfile', 'pyproject.toml', 'setup.py'];
  for (const file of pythonFiles) {
    if (fs.existsSync(path.join(repoPath, file))) {
      const packageManager = file === 'Pipfile' || file === 'pyproject.toml' ? 'poetry' : 'pip';

      // Find entry point
      let entryPoint: string | undefined;
      const commonEntries = ['main.py', 'bot.py', 'app.py', 'run.py'];
      for (const entry of commonEntries) {
        if (fs.existsSync(path.join(repoPath, entry))) {
          entryPoint = entry;
          break;
        }
      }

      return { type: 'python', packageManager, entryPoint };
    }
  }

  // Go detection
  if (fs.existsSync(path.join(repoPath, 'go.mod'))) {
    return { type: 'go', packageManager: 'go' };
  }

  // Java detection
  if (fs.existsSync(path.join(repoPath, 'pom.xml'))) {
    return { type: 'java', packageManager: 'maven' };
  }
  if (fs.existsSync(path.join(repoPath, 'build.gradle')) || fs.existsSync(path.join(repoPath, 'build.gradle.kts'))) {
    return { type: 'java', packageManager: 'gradle' };
  }

  return { type: 'unknown' };
}

/**
 * Check if docker-compose content includes database services
 */
function detectDatabaseInCompose(content: string): boolean {
  const dbPatterns = [
    'postgres',
    'postgresql',
    'mysql',
    'mariadb',
    'mongodb',
    'mongo',
    'redis',
    'sqlite',
    'prisma'
  ];

  return dbPatterns.some(pattern => content.includes(pattern));
}

/**
 * Scan source code for database usage patterns
 */
function scanForDatabasePatterns(repoPath: string): boolean {
  const dbPatterns = [
    // Node.js
    'mongoose',
    'pg',
    'mysql2',
    'mysql',
    'sequelize',
    'prisma',
    'typeorm',
    'knex',
    'mongodb',
    'redis',
    'ioredis',
    'better-sqlite3',
    'sqlite3',
    // Python
    'sqlalchemy',
    'pymongo',
    'psycopg',
    'pymysql',
    'aioredis',
    'motor',
    'databases',
    'tortoise-orm'
  ];

  // Check package.json dependencies
  const packageJsonPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies
      };
      const depNames = Object.keys(allDeps || {}).map(d => d.toLowerCase());
      if (dbPatterns.some(pattern => depNames.some(d => d.includes(pattern)))) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check requirements.txt
  const requirementsPath = path.join(repoPath, 'requirements.txt');
  if (fs.existsSync(requirementsPath)) {
    try {
      const content = fs.readFileSync(requirementsPath, 'utf-8').toLowerCase();
      if (dbPatterns.some(pattern => content.includes(pattern))) {
        return true;
      }
    } catch {
      // Ignore read errors
    }
  }

  return false;
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
    dockerfile: 'Custom Dockerfile',
    compose: 'Docker Compose',
    unknown: 'Unknown'
  };
  return names[type];
}
