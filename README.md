# Codex-Ventures

Codex-Ventures es un laboratorio local para convertir una idea de Micro-SaaS en una tesis editable, ejecutar simulaciones reproducibles con usuarios sintéticos, derivar métricas desde eventos y revisar propuestas de mejora. Los datos de demo están marcados como sintéticos: no representan clientes ni investigación de mercado real.

## Requisitos

- Node.js 24 o compatible con Next.js 16.
- npm.
- Docker Desktop con el contexto `desktop-linux` para validar propuestas en el sandbox. El resto del flujo demo usa el store local.

## Instalar y ejecutar

```powershell
npm install
npm run dev
```

Abrí http://localhost:3000. El estado local se guarda en `.data/codex-ventures.json` y se crea automáticamente con el proyecto demo DevHabit. Usá **Reiniciar demo** para restaurar el seed desde la interfaz. Para validar:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm start
```

La carpeta `.data` contiene información local y no debe subirse al repositorio. La interfaz incluye **Reiniciar demo** y rechaza el reset mientras haya jobs activos.

## Backup y restauración

Detené el servidor antes de copiar o restaurar el archivo para evitar que una escritura posterior reemplace la copia:

```powershell
# Backup (elegí un nombre distinto para cada snapshot)
Copy-Item .data\codex-ventures.json .data\codex-ventures-backup.json

# Restauración (reemplaza el estado activo)
Copy-Item .data\codex-ventures-backup.json .data\codex-ventures.json -Force
```

La variable opcional `CODEX_VENTURES_DATA_DIR` permite apuntar el store local a otro directorio; debe configurarse solo en el backend.

## Flujo funcional

1. En **Projects**, creá un proyecto con nombre e idea. El generador determinista arma una tesis editable conceptualmente y una especificación MVP inicial; los campos no provistos quedan como hipótesis.
2. En **Simulations**, configurá agentes, latencia, errores, onboarding y presión de precio. El motor de estados genera eventos con seed, persistidos en el store local.
3. El motor local encola el trabajo, persiste su estado y eventos, publica progreso por SSE y deriva métricas desde los eventos. Feedback repetido se agrupa por problema.
4. En **Improvements**, revisá el fixture determinista de demostración (no generado por IA), su diff, hash, versión base, archivos y criterios. La aprobación solo se habilita para un diff válido y encola una ejecución aislada de instalación, tests, typecheck y lint. El diff nunca se escribe en el repositorio original.

### Sandbox Docker local (opcional)

El ejecutor usa únicamente el Docker Engine local, sin aceptar endpoints `DOCKER_HOST` remotos. No descarga imágenes automáticamente. Con Docker Desktop iniciado, desde esta carpeta ejecutá `npm run sandbox:build` para construir la imagen local confiable `codex-ventures-sandbox:node24-1`; luego `npm test` corre el smoke y el flujo de propuesta Docker end-to-end (o marca esa integración como omitida si Docker/la imagen no están disponibles). El contenedor corre como UID 10001, sin red, con filesystem raíz de solo lectura, capacidades descartadas, `no-new-privileges`, límites de 1 CPU, 2 GiB de memoria, 1 GiB para el workspace y 128 procesos. No hay bind mounts: una copia filtrada se envía por stdin a un runner fijo y se descarta al final.

La propuesta tiene un diff fixture determinista y etiquetado como demo (no existe proveedor IA configurado). El runner solo admite `npm ci --offline --ignore-scripts`, test, typecheck y lint, en ese orden. Registra exit code, duración, stdout/stderr acotados y etapa; no aplica cambios al repositorio, no hace merge ni deploy. Para reproducir una propuesta exitosa: construir la imagen, reiniciar el demo, ir a **Improvements**, revisar el diff del fixture y aprobarlo; el job finaliza en `VALIDATED` si y solo si los cuatro comandos se ejecutaron y pasaron.

El botón **Nueva simulación** usa parámetros actuales, una seed nueva y hasta 250 agentes. La API acepta una seed fija para reproducibilidad.

## API local

| Método | Ruta | Uso |
| --- | --- | --- |
| GET | `/api/dashboard` | Proyecto(s), corridas, eventos, reportes, propuestas y actividad |
| POST | `/api/projects` | Crear proyecto y tesis/especificación simuladas |
| POST | `/api/simulations` | Encolar corrida determinista; responde `202` con el job. Acepta `Idempotency-Key` |
| GET | `/api/jobs?limit=25` | Listar hasta 100 jobs recientes |
| GET/PATCH/POST | `/api/jobs/{id}` | Consultar, cancelar en cola o reintentar un job fallido |
| GET | `/api/jobs/{id}/events` | Progreso y estado terminal mediante SSE; al reconectar envía el snapshot actual |
| PATCH | `/api/proposals/{id}` | Aprobar (encola implementación) o rechazar una propuesta `PROPOSED` |
| POST | `/api/demo/reset` | Restaurar el demo; responde `409` si hay jobs activos |

Las entradas pasan por esquemas Zod y las listas de agentes y parámetros tienen límites. La ruta de dashboard es para el workspace local y todavía no implementa autenticación, paginación ni SSE.

## Arquitectura y límites

- Next.js App Router, React, TypeScript estricto y Route Handlers.
- La lógica del motor y analítica vive en `src/lib/domain.ts`; persistencia está detrás de `src/lib/store.ts`.
- El adaptador actual es JSON de usuario único. Serializa escrituras dentro de un proceso y usa escritura atómica, pero no ofrece bloqueo multi-proceso, aislamiento de usuarios ni durabilidad de PostgreSQL.
- El worker local se inicia con `instrumentation.ts`, procesa un job a la vez, persiste progreso/errores, permite cancelar jobs aún en cola y reencola trabajos interrumpidos al reiniciar hasta agotar tres intentos. La cola no debe compartirse entre varios procesos o réplicas.
- Los eventos de agentes siguen una secuencia explícita: visita → registro → activación/tarea → premium opcional → retorno opcional → feedback.
- Latencia, errores, dificultad del onboarding y precio afectan probabilidades de conversión, y sus parámetros están visibles en la vista de simulación.
- Los gráficos son vistas del recuento de eventos y métricas guardadas; satisfacción e ingresos son estimaciones hipotéticas derivadas de reglas documentadas en `src/lib/domain.ts`.
- No hay proveedor de IA real. La tesis y las propuestas son reglas locales basadas en eventos. No se inventa una integración de Codex.
- `DockerSandboxExecutor` usa Dockerode contra el socket local, exige imagen exacta preexistente, valida el `inspect` efectivo y no monta el repositorio. Las propuestas demo llevan diff/base/hash/criterios y se aplican solo en el workspace tmpfs temporal.
- No hay migración Prisma/PostgreSQL activa. Docker y PostgreSQL no estaban instalados ni disponibles durante esta fase; por eso no se declara una persistencia relacional probada. La app usa el store JSON hasta que pueda ejecutarse y validarse la base de datos.
- SSE publica progreso durante el proceso actual. Tras reconectar se entrega el estado más reciente, no una repetición histórica completa. El workspace sigue siendo de usuario único y no implementa autorización para exponerlo en red.

## Próximas etapas para producción

Implementar y verificar el adaptador PostgreSQL/Prisma con migraciones e importación del JSON; aislamiento multiusuario; retries con backoff y coordinación multi-proceso; versionado de especificaciones y comparación experimental con incertidumbre; proveedor real compatible con API oficial y límites de gasto; un flujo de diffs revisables y ejecución de checks sobre una imagen de proyecto confiable; autenticación/autorización; y suite Playwright contra un entorno aislado. Antes de exponerlo en red, resolver las limitaciones de `SECURITY.md`.

Las variables opcionales futuras se documentan en `.env.example`. No guardar claves del lado cliente ni commitear credenciales.
