# Use Node.js 20 on Alpine Linux as the base image
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package definition files first to maximize Docker layer cache hits
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm install --production

# Copy the rest of the source code
COPY . .

# Ensure uploads directory exists inside the container and has Node permissions
RUN mkdir -p uploads && chown -R node:node /app

# Switch to non-root execution context for security
USER node

# Expose port 3000
EXPOSE 3000

# Set environment variable defaults
ENV PORT=3000
ENV NODE_ENV=production

# Start the application
CMD ["node", "server.js"]
