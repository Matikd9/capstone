# Imagen base oficial de Node.js en Debian Bookworm (estable y actualizada)
FROM node:20-bookworm-slim

WORKDIR /app

# Copiar manifiestos e instalar dependencias de producción
COPY package*.json ./
RUN npm ci --only=production

# Copiar el código fuente y activos estáticos
COPY . .

# Crear los directorios de uploads en caso de no existir
RUN mkdir -p storage/uploads public/uploads

# Puerto e inicio para Google Cloud Run
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "src/server.js"]
