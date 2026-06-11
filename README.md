# Claude Gateway

Portal web para dar acceso a Claude a tu equipo, con control de consumo por usuario.

## ¿Qué incluye?

- **Login por trabajador** — cada uno con su cuenta
- **Límite diario y mensual** en USD por usuario (configurable)
- **Bloqueo automático** al alcanzar el límite
- **Panel admin** para crear usuarios, ver consumo y ajustar límites en tiempo real
- **Barras de progreso** de consumo visibles para cada trabajador
- **Historial de mensajes** por usuario

---

## Instalación rápida

### Requisitos
- Node.js 18+
- Una API key de Anthropic (https://console.anthropic.com)

### Pasos

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Edita .env y agrega tu ANTHROPIC_API_KEY

# 3. Arrancar el servidor
npm start
```

Abre http://localhost:3000 en tu navegador.

---

## Primer acceso (admin)

- **Email:** admin@empresa.com
- **Contraseña:** admin123

> ⚠️ Cambia la contraseña del admin desde el panel después de ingresar.

---

## Límites por defecto al crear un trabajador

| Límite | Valor | Equivale aprox. a |
|--------|-------|-------------------|
| Diario | $1.00 USD | ~1,200 mensajes cortos |
| Mensual | $10.00 USD | ~12,000 mensajes cortos |

Puedes cambiar estos valores por usuario en cualquier momento desde el panel admin.

---

## Modelo usado

Por defecto usa **Claude Haiku 4.5** (el más económico):
- Input: $0.80 por millón de tokens
- Output: $4.00 por millón de tokens

Para cambiar el modelo, edita `DEFAULT_MODEL` en `server.js`.

---

## Estructura del proyecto

```
gateway/
├── server.js          ← Backend (Express + SQLite)
├── public/
│   └── index.html     ← Frontend (React, sin build)
├── gateway.db         ← Base de datos (se crea automáticamente)
├── .env               ← Variables de entorno (tú lo creas)
├── .env.example       ← Plantilla
└── package.json
```

---

## Despliegue en producción

Opciones recomendadas:
- **Railway** (https://railway.app) — fácil, gratis para empezar
- **Render** (https://render.com)
- **VPS propio** con PM2: `npm install -g pm2 && pm2 start server.js`

> Para producción, reemplaza SQLite por PostgreSQL si esperas más de 20 usuarios simultáneos.
