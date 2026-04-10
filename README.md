# Mejora Escolar — Deploy en Vercel

## Estructura
```
mejora-escolar-vercel/
├── api/
│   └── consultar-ia.js   ← Proxy para API de Anthropic
├── public/
│   └── index.html        ← App completa
├── vercel.json           ← Configuración Vercel
└── README.md
```

## Pasos para publicar

### 1. Subir a GitHub
- Crea un repositorio nuevo en github.com (ej: `mejora-escolar`)
- Sube esta carpeta completa

### 2. Conectar con Vercel
- Ve a vercel.com → "New Project"
- Importa el repositorio de GitHub
- Click "Deploy" (sin cambiar nada)

### 3. Agregar API Key de Anthropic
- En Vercel → tu proyecto → Settings → Environment Variables
- Agrega:
  - Name: `ANTHROPIC_API_KEY`
  - Value: `sk-ant-...` (tu clave)
- Click "Save" → luego "Redeploy"

### 4. Listo
Tu app estará en: `https://mejora-escolar.vercel.app`
