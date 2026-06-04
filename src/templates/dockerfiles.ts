/**
 * Dockerfile Templates
 * Generates Dockerfiles for different bot types
 */

import { DetectionResult } from '../types';

/**
 * Generate Dockerfile content based on detection result
 */
export function generateDockerfile(detection: DetectionResult): string {
  switch (detection.type) {
    case 'nodejs':
      return generateNodejsDockerfile(detection);
    case 'python':
      return generatePythonDockerfile(detection);
    case 'go':
      return generateGoDockerfile(detection);
    case 'java':
      return generateJavaDockerfile(detection);
    case 'rust':
      return generateRustDockerfile(detection);
    case 'csharp':
      return generateCsharpDockerfile(detection);
    default:
      // Default to Node.js as fallback
      return generateNodejsDockerfile(detection);
  }
}

// ─── System dependency helpers ───

const SYSTEM_DEP_APT: Record<string, string[]> = {
  ffmpeg: ['ffmpeg'],
  libopus: ['libopus-dev'],
  libsodium: ['libsodium-dev'],
  'build-essential': ['build-essential', 'python3'],
  libcairo: ['libcairo2-dev', 'libpango1.0-dev', 'libjpeg-dev', 'libgif-dev', 'librsvg2-dev'],
};

function aptPackagesFor(detection: DetectionResult, extra: string[] = []): string[] {
  const pkgs = new Set<string>(extra);
  for (const dep of detection.systemDeps || []) {
    for (const p of SYSTEM_DEP_APT[dep] || []) pkgs.add(p);
  }
  return [...pkgs];
}

function aptInstallBlock(packages: string[]): string {
  if (packages.length === 0) return '';
  return `RUN apt-get update && apt-get install -y --no-install-recommends \\
    ${packages.join(' ')} \\
    && rm -rf /var/lib/apt/lists/*

`;
}

// ─── Node.js ───

function generateNodejsDockerfile(detection: DetectionResult): string {
  const packageManager = detection.packageManager || 'npm';

  if (packageManager === 'bun') {
    return generateBunDockerfile(detection);
  }

  const needsNative = detection.hasMusic || (detection.systemDeps?.length ?? 0) > 0;
  const aptPkgs = needsNative
    ? aptPackagesFor(detection, detection.hasMusic ? ['ffmpeg', 'build-essential', 'python3'] : [])
    : [];

  if (detection.isTypeScript) {
    return generateNodejsTsDockerfile(detection, packageManager, needsNative, aptPkgs);
  }

  let installCmd = 'npm ci --only=production';
  let copyLock = 'COPY package*.json ./';
  if (packageManager === 'yarn') {
    installCmd = 'yarn install --production --frozen-lockfile';
    copyLock = 'COPY package.json yarn.lock ./';
  } else if (packageManager === 'pnpm') {
    installCmd = 'corepack enable && pnpm install --prod --frozen-lockfile';
    copyLock = 'COPY package.json pnpm-lock.yaml ./';
  }

  const base = needsNative ? 'node:20-slim' : 'node:20-alpine';
  const cmd = detection.entryPoint ? `CMD ["node", "${detection.entryPoint}"]` : 'CMD ["npm", "start"]';

  return `FROM ${base}

${aptInstallBlock(aptPkgs)}WORKDIR /app

${copyLock}
RUN ${installCmd}

COPY . .

RUN mkdir -p /app/data

${cmd}
`;
}

function generateNodejsTsDockerfile(
  detection: DetectionResult,
  packageManager: string,
  needsNative: boolean,
  aptPkgs: string[]
): string {
  const base = needsNative ? 'node:20-slim' : 'node:20-alpine';

  let copyLock = 'COPY package*.json ./';
  let installAll = 'npm ci';
  let installProd = 'npm ci --omit=dev';
  let buildCmd = 'npm run build';
  if (packageManager === 'yarn') {
    copyLock = 'COPY package.json yarn.lock ./';
    installAll = 'yarn install --frozen-lockfile';
    installProd = 'yarn install --production --frozen-lockfile';
    buildCmd = 'yarn build';
  } else if (packageManager === 'pnpm') {
    copyLock = 'COPY package.json pnpm-lock.yaml ./';
    installAll = 'corepack enable && pnpm install --frozen-lockfile';
    installProd = 'corepack enable && pnpm install --prod --frozen-lockfile';
    buildCmd = 'pnpm run build';
  }

  const entry = detection.entryPoint || 'dist/index.js';

  return `FROM ${base} AS builder

${aptInstallBlock(aptPkgs)}WORKDIR /app

${copyLock}
RUN ${installAll}

COPY . .
RUN ${buildCmd}

FROM ${base}

${aptInstallBlock(aptPkgs)}WORKDIR /app

${copyLock}
RUN ${installProd}

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data

CMD ["node", "${entry}"]
`;
}

function generateBunDockerfile(detection: DetectionResult): string {
  const needsNative = detection.hasMusic || (detection.systemDeps?.length ?? 0) > 0;
  const aptPkgs = needsNative
    ? aptPackagesFor(detection, detection.hasMusic ? ['ffmpeg', 'build-essential', 'python3'] : [])
    : [];
  const cmd = detection.entryPoint ? `CMD ["bun", "${detection.entryPoint}"]` : 'CMD ["bun", "run", "start"]';

  return `FROM oven/bun:1

${aptInstallBlock(aptPkgs)}WORKDIR /app

COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile --production

COPY . .

RUN mkdir -p /app/data

${cmd}
`;
}

// ─── Python ───

function generatePythonDockerfile(detection: DetectionResult): string {
  const entryPoint = detection.entryPoint || 'bot.py';
  const packageManager = detection.packageManager || 'pip';
  const needsVoice = detection.hasMusic || (detection.systemDeps?.length ?? 0) > 0;
  const aptPkgs = needsVoice
    ? aptPackagesFor(detection, ['ffmpeg', 'libopus-dev', 'libsodium-dev', 'libffi-dev', 'git'])
    : [];
  const apt = aptInstallBlock(aptPkgs);
  const runCmd = entryPoint.endsWith('.py') ? `CMD ["python", "${entryPoint}"]` : `CMD ["${entryPoint}"]`;

  if (packageManager === 'poetry') {
    return `FROM python:3.12-slim

${apt}WORKDIR /app

RUN pip install --no-cache-dir poetry

COPY pyproject.toml poetry.lock* ./
RUN poetry config virtualenvs.create false && poetry install --no-root --without dev

COPY . .

RUN mkdir -p /app/data

${runCmd}
`;
  }

  if (packageManager === 'uv') {
    return `FROM python:3.12-slim

${apt}COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY . .

RUN mkdir -p /app/data

CMD ["uv", "run", "python", "${entryPoint}"]
`;
  }

  if (packageManager === 'pipenv') {
    return `FROM python:3.12-slim

${apt}WORKDIR /app

RUN pip install --no-cache-dir pipenv

COPY Pipfile Pipfile.lock* ./
RUN pipenv install --deploy --system

COPY . .

RUN mkdir -p /app/data

${runCmd}
`;
  }

  if (packageManager === 'setuptools') {
    return `FROM python:3.12-slim

${apt}WORKDIR /app

COPY . .
RUN pip install --no-cache-dir .

RUN mkdir -p /app/data

${runCmd}
`;
  }

  // pip (default)
  return `FROM python:3.12-slim

${apt}WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/data

${runCmd}
`;
}

// ─── Go ───

function generateGoDockerfile(detection: DetectionResult): string {
  const entry = detection.entryPoint || '.';
  return `FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /bot ${entry}

FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /app

COPY --from=builder /bot .

RUN mkdir -p /app/data

CMD ["./bot"]
`;
}

// ─── Java ───

function generateJavaDockerfile(detection: DetectionResult): string {
  const jarPattern = detection.jarPattern || '*.jar';

  if (detection.prebuiltJar) {
    return `FROM eclipse-temurin:17-jre-alpine

WORKDIR /app

COPY ${jarPattern} app.jar

RUN mkdir -p /app/data

CMD ["java", "-jar", "app.jar"]
`;
  }

  if (detection.packageManager === 'gradle') {
    const buildCmd = jarPattern.includes('-all') ? 'gradle shadowJar --no-daemon' : 'gradle build --no-daemon -x test';
    return `FROM gradle:8-jdk17 AS builder

WORKDIR /app

COPY . .
RUN ${buildCmd}
${SELECT_JAR_BLOCK('build/libs')}
FROM eclipse-temurin:17-jre-alpine

WORKDIR /app

COPY --from=builder /app/app.jar app.jar

RUN mkdir -p /app/data

CMD ["java", "-jar", "app.jar"]
`;
  }

  // Maven
  return `FROM maven:3.9-eclipse-temurin-17 AS builder

WORKDIR /app

COPY pom.xml .
RUN mvn dependency:go-offline

COPY src ./src
RUN mvn package -DskipTests
${SELECT_JAR_BLOCK('target')}
FROM eclipse-temurin:17-jre-alpine

WORKDIR /app

COPY --from=builder /app/app.jar app.jar

RUN mkdir -p /app/data

CMD ["java", "-jar", "app.jar"]
`;
}

// Select the runnable fat/shaded jar robustly: the largest jar in the build
// output, excluding the non-runnable originals (original-*, *-plain, sources,
// javadoc). Handles maven-shade classifier jars (e.g. *-All.jar) and gradle-shadow
// output without guessing the exact filename.
function SELECT_JAR_BLOCK(dir: string): string {
  return `RUN set -eu; jar=$(ls -S ${dir}/*.jar 2>/dev/null | grep -vE 'original-|-sources|-javadoc|-plain' | head -n1); \\
    test -n "$jar"; cp "$jar" /app/app.jar
`;
}

// ─── Rust ───

function generateRustDockerfile(detection: DetectionResult): string {
  const name = detection.packageName || 'bot';
  return `FROM rust:1.77-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

COPY . .
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/${name} .

RUN mkdir -p /app/data

CMD ["./${name}"]
`;
}

// ─── C# (.NET) ───

function generateCsharpDockerfile(detection: DetectionResult): string {
  const assembly = detection.packageName;
  const runCmd = assembly
    ? `CMD ["dotnet", "${assembly}.dll"]`
    : `CMD ["sh", "-c", "dotnet $(ls *.dll | head -n1)"]`;
  return `FROM mcr.microsoft.com/dotnet/sdk:8.0 AS builder

WORKDIR /app

COPY . .
RUN dotnet restore
RUN dotnet publish -c Release -o /out

FROM mcr.microsoft.com/dotnet/runtime:8.0

WORKDIR /app

COPY --from=builder /out .

RUN mkdir -p /app/data

${runCmd}
`;
}

/**
 * Get Dockerfile path based on bot type
 */
export function getDockerfileName(_detection: DetectionResult): string {
  // Always use 'Dockerfile' as the name
  return 'Dockerfile';
}
