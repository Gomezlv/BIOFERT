# MetaGanado (DEMO para clase)

Demo fullstack **simple** (sin Docker) basada en `metaganado (1).html`.

- **Frontend**: Angular (carpeta `frontend/`)
- **Backend**: Node.js + Express (carpeta `backend/`)
- **Base de datos**: PostgreSQL (archivo `database.sql`)

## 0) Requisitos

- Node.js y npm
  - Verifica: `node -v` y `npm -v`
- PostgreSQL instalado y corriendo
  - Verifica: `sudo systemctl status postgresql`

## 1) Base de datos (PostgreSQL)

1. Entra a `psql` (usuario postgres):

```bash
sudo -u postgres psql
```

2. (Recomendado para clase) pon password simple:

```sql
ALTER USER postgres PASSWORD 'postgres';
```

3. Crea la base de datos y sal:

```sql
CREATE DATABASE metaganado;
\q
```

4. Carga el esquema + datos de ejemplo:

```bash
psql -h localhost -U postgres -d metaganado -f "database.sql"
```

## 2) Backend (Express)

1. Instala dependencias:

```bash
cd backend
npm install
```

2. Levanta el servidor:

```bash
npm run dev
```

3. Prueba rápido:

```bash
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/sensors | head
```

> Si tu Postgres usa otro usuario/password/puerto, puedes setear variables:
> `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`.

## 3) Frontend (Angular)

1. Instala dependencias:

```bash
cd ../frontend
npm install
```

2. Ejecuta Angular:

```bash
npm start
```

3. Abre en el navegador:
`http://localhost:4200`

## 4) Qué mostrar en la demo (orden recomendado)

1. **Inicio (Dashboard)**: enseña los contadores (sensores, alertas, recomendaciones, pendientes).
2. **Sensores**:
   - Muestra la lista (GET).
   - Crea un sensor nuevo (POST) y presiona “Refrescar” (o cambia de pestaña y vuelve).
3. **Recomendaciones**:
   - Muestra la lista (GET).
   - Crea una recomendación nueva (POST) y observa que aparece como **Pendiente**.

## 5) Guion para explicar la base de datos (rápido)

- **`farms`**: “una finca/predio, el contexto”.
- **`sensors`**: “sensores instalados en la finca (zona, batería, estado)”.
- **`sensor_readings`**: “lecturas históricas: cada medición con fecha”.
- **`recommendations`**: “catálogo de acciones para reducir CH₄”.
- **`farm_recommendations`**: “qué recomendación está asignada a la finca y su estado (pendiente/aplicada/descartada)”.

Relaciones:
- Una **finca** tiene muchos **sensores**.
- Un **sensor** tiene muchas **lecturas**.
- Una **finca** tiene muchas **recomendaciones asignadas** (con estado).

## 6) Simplificación (qué ignorar / trabajo futuro)

Puedes decir “trabajo futuro” para:
- Autenticación/usuarios
- Mapa real y geolocalización
- Cálculo real de CO₂eq/bonos y certificación
- Tiempo real (websockets) para lecturas IoT
- Validaciones avanzadas, paginación y roles

