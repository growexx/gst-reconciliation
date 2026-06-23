FROM node:22-alpine

# Set the working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install

# Copy the server source code
COPY server/ ./server/

# Copy the .env file into the image root (where server.js expects it)
COPY server/.env ./.env

# Expose the backend port
EXPOSE 5000

# Start the server
CMD ["npm", "run", "start"]