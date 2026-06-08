# Use Node.js 22 LTS on Alpine (lightweight Linux)
FROM node:22-alpine

# Install build tools required for better-sqlite3 native bindings
# better-sqlite3 compiles C++ code during npm install — needs these tools
RUN apk add --no-cache python3 make g++

# Set working directory inside the container
WORKDIR /app

# Copy package files first — Docker caches this layer
# so npm install only re-runs when dependencies change
COPY package*.json ./

# Install all dependencies including devDependencies
# (tsx and typescript are needed to run server.ts)
RUN npm ci

# Copy all project files into the container
COPY . .

# Build the React frontend
# This runs vite build and outputs to /app/dist
# The Express server serves this dist folder
RUN npm run build

# Expose port 3000 — matches docker-compose.yml
EXPOSE 3000

# Start the server using tsx (TypeScript executor)
CMD ["npx", "tsx", "server.ts"]