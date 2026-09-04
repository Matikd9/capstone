# 🐳 Entorno de Desarrollo Dev Container (Web + MySQL)

Este proyecto está 100% configurado para ejecutarse dentro de un **Dev Container de Docker** con **Node.js 20 (Express)** y **MySQL 8.0**.

---

## 🚀 Pasos para empezar a programar dentro del contenedor

### 1. Requisitos
* Tener **Docker Desktop** abierto y corriendo en tu computadora.
* Usar **Antigravity IDE** o **VS Code** con la extensión **Dev Containers** (`ms-vscode-remote.remote-containers`) instalada.

---

### 2. Abrir el proyecto dentro del contenedor

1. Presiona la tecla `F1` (o `Ctrl + Shift + P` / `Cmd + Shift + P`).
2. Escribe y selecciona el comando:  
   👉 **`Dev Containers: Reopen in Container`**
3. El editor se conectará a Docker, creará la imagen, levantará el contenedor de Node.js y MySQL automáticamente.

---

### 3. Ejecutar la aplicación

Una vez dentro del contenedor (lo verás en la barra inferior izquierda del IDE indicando `Dev Container: Web App & MySQL Dev Container`):

1. Abre la terminal integrada (`Ctrl + ~` o ``Ctrl + ` ``).
2. Corre el comando de desarrollo:
   ```bash
   npm run dev
   ```
3. Abre tu navegador en **`http://localhost:3000`**.

---

## 📁 Estructura del Proyecto

* **`.devcontainer/`**: Configuración de Docker Compose y VS Code Dev Container.
* **`src/server.js`**: Servidor Web backend con Express y conexión a MySQL.
* **`public/`**: Frontend HTML5, CSS3 moderno y JS para probar la base de datos.
* **`.env`**: Credenciales de base de datos dentro del entorno aislado de Docker.

---

## 🗄️ Conexión a MySQL desde el IDE

Puedes conectar cualquier cliente de base de datos (o la extensión **Database Client** preinstalada) usando estas credenciales:

* **Host**: `db` (dentro del contenedor) o `localhost` (desde fuera)
* **Puerto**: `3306`
* **Usuario**: `root`
* **Contraseña**: `rootpassword`
* **Base de datos**: `web_app`
# capstone
