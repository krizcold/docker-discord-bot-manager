# Discord Bot Manager Dockerfile
# Uses Docker-in-Docker to manage bot containers

FROM node:20-alpine

# Install Docker CLI (to communicate with host Docker)
RUN apk add --no-cache docker-cli docker-cli-compose git

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Copy static assets (HTML, CSS, JS) that tsc doesn't handle
RUN cp -r src/webui/public dist/webui/public

# Create data directory
RUN mkdir -p /data/data/bots

# Expose port
EXPOSE 8080

# Set environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/data/data
ENV PORT=8080

# Start the application
CMD ["npm", "start"]
