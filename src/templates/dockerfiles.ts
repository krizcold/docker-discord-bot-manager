/**
 * Dockerfile Templates
 * Generates Dockerfiles for different bot types
 */

import { BotType, DetectionResult } from '../types';

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
      return generateGoDockerfile();
    case 'java':
      return generateJavaDockerfile(detection);
    default:
      // Default to Node.js as fallback
      return generateNodejsDockerfile(detection);
  }
}

/**
 * Node.js Dockerfile template
 */
function generateNodejsDockerfile(detection: DetectionResult): string {
  const packageManager = detection.packageManager || 'npm';

  let installCmd = 'npm ci --only=production';
  let copyLock = 'COPY package*.json ./';

  if (packageManager === 'yarn') {
    installCmd = 'yarn install --production --frozen-lockfile';
    copyLock = 'COPY package.json yarn.lock ./';
  } else if (packageManager === 'pnpm') {
    installCmd = 'pnpm install --prod --frozen-lockfile';
    copyLock = 'COPY package.json pnpm-lock.yaml ./';
  }

  return `FROM node:20-alpine

WORKDIR /app

${copyLock}
RUN ${installCmd}

COPY . .

# Create data directory for persistence
RUN mkdir -p /app/data

CMD ["npm", "start"]
`;
}

/**
 * Python Dockerfile template
 */
function generatePythonDockerfile(detection: DetectionResult): string {
  const entryPoint = detection.entryPoint || 'main.py';
  const packageManager = detection.packageManager || 'pip';

  if (packageManager === 'poetry') {
    return `FROM python:3.11-slim

WORKDIR /app

# Install poetry
RUN pip install poetry

# Copy dependency files
COPY pyproject.toml poetry.lock* ./

# Install dependencies
RUN poetry config virtualenvs.create false && poetry install --no-dev --no-interaction --no-ansi

COPY . .

# Create data directory for persistence
RUN mkdir -p /app/data

CMD ["python", "${entryPoint}"]
`;
  }

  return `FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create data directory for persistence
RUN mkdir -p /app/data

CMD ["python", "${entryPoint}"]
`;
}

/**
 * Go Dockerfile template
 */
function generateGoDockerfile(): string {
  return `FROM golang:1.21-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /bot .

FROM alpine:latest

WORKDIR /app

COPY --from=builder /bot .

# Create data directory for persistence
RUN mkdir -p /app/data

CMD ["./bot"]
`;
}

/**
 * Java Dockerfile template
 */
function generateJavaDockerfile(detection: DetectionResult): string {
  if (detection.packageManager === 'gradle') {
    return `FROM gradle:8-jdk17 AS builder

WORKDIR /app

COPY . .
RUN gradle build --no-daemon -x test

FROM eclipse-temurin:17-jre-alpine

WORKDIR /app

COPY --from=builder /app/build/libs/*.jar app.jar

# Create data directory for persistence
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

FROM eclipse-temurin:17-jre-alpine

WORKDIR /app

COPY --from=builder /app/target/*.jar app.jar

# Create data directory for persistence
RUN mkdir -p /app/data

CMD ["java", "-jar", "app.jar"]
`;
}

/**
 * Get Dockerfile path based on bot type
 */
export function getDockerfileName(detection: DetectionResult): string {
  // Always use 'Dockerfile' as the name
  return 'Dockerfile';
}
