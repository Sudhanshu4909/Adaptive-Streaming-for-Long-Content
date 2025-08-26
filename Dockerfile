# Use a lightweight Node.js Alpine image as the base
FROM node:20-alpine

# Install FFmpeg only
RUN apk add --no-cache ffmpeg

# Set up working directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application source code
COPY . .

# Ensure required directories exist
RUN mkdir -p /tmp/output

# Start the application
CMD ["node", "startup.js"]
