# Use Node.js LTS as base image
FROM node:20

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy application code
COPY . .

# Expose port 8080 (Cloud Run expects the application to listen on $PORT, which defaults to 8080)
EXPOSE 8080

# Command to run the server
CMD ["node", "server.js"]
