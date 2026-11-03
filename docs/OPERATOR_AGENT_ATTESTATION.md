# Atestación experimental del Hosted Agent (sin despliegue)

Estado: **propuesta experimental, optativa, deshabilitada por defecto.** Este cambio se desarrolla exclusivamente en una rama y PR de revisión. No se habilita LIVE en `thunderbolt-bots`, no se activan inferencias ni se establecen credenciales reales.

## Objetivo y alcance

Comprobar que la **instancia de backend que atiende el chat** tiene cargado el hash SHA-256 del `AGENT_SYSTEM_PROMPT` del operador esperado, sin devolver el texto de las instrucciones ni confiar en un archivo de Git como prueba del proceso. Thunderbolt también añade reglas de idioma, hora y, cuando existen, instrucciones suministradas por la persona usuaria: la prueba **no certifica el prompt final completo** ni su contenido semántico.

El firmante se crea al construir `createHostedAgentRoutes` usando exactamente su objeto `settings` capturado, compartido por `POST /v1/agent/chat` y la ruta adicional `GET /v1/agent/identity`. Genera un `boot_id` aleatorio por instancia de rutas; para las solicitudes de chat que incluyan autorización de operador, adjunta `x-agent-attestation-boot-id` a la respuesta de streaming. Sin configuración experimental, la ruta nueva no existe y el chat funciona como antes.

## Seguridad y protocolo

El endpoint `GET /v1/agent/identity?nonce=<32 hex minúsculas>` exige **dos permisos**: autenticación existente del backend (sesión/PAT, ya requerida por el Hosted Agent) y un token operador distinto, enviado en `x-agent-attestation-token`. La clave de Fireworks no se utiliza ni transmite. El GET no invoca el modelo ni reserva presupuesto de inferencia. La ruta responde con `cache-control: no-store`.

El servidor firma con Ed25519 el JSON canónico de esquema 1, coincidente con el verificador en `carlosmirandar/thunderbolt-bots/src/compare/runtime-attestation.ts`: `nonce`, `audience`, `origin`, marcas de tiempo (15 segundos), `backend_commit` declarado, `deployment_id`, `boot_id`, `agent_id`, `agent_name`, `model`, `max_steps=1`, `mcp_servers=0` y `prompt_sha256`. La firma se codifica en base64url. La clave pública ha de **fijarse en el verificador fuera de banda**; nunca se obtiene del endpoint cuya autenticidad se quiere demostrar. La clave privada y el token permanecen en el gestor de secretos del backend. Las respuestas no incluyen el prompt, la clave ni el token.

Para verificar una llamada: generar un desafío aleatorio de 16 bytes y comprobar la firma, vigencia, nonce de un solo uso, origen exacto, despliegue, modelo y hash esperado; emitir el chat con el token de operador y verificar que el `x-agent-attestation-boot-id` corresponde al de la atestación. **Si hay varias réplicas sin enrutamiento fijado a la instancia, la verificación previa no impide enviar una solicitud a otra instancia**; el encabezado permite detectar después el desajuste, pero no evitar el coste de esa solicitud. Por eso LIVE sigue prohibido hasta resolver y probar ese caso.

## Variables exclusivas del backend (NO fijarlas en este PR)

| Variable | Uso |
|---|---|
| `AGENT_ATTESTATION_ENABLED` | `false` por defecto; `true` solo en despliegue controlado y autorizado |
| `AGENT_ATTESTATION_PRIVATE_KEY_PEM_BASE64` | Clave Ed25519 privada codificada en base64; solo gestor de secretos |
| `AGENT_ATTESTATION_OPERATOR_TOKEN` | Token de alta entropía independiente de PAT y Fireworks (mínimo 32 caracteres) |
| `AGENT_ATTESTATION_DEPLOYMENT_ID` | Identificador del despliegue (1–128 caracteres seguros) |
| `AGENT_ATTESTATION_BACKEND_COMMIT` | Commit de backend declarado por operación; NO se prueba contra el binario con esta firma |
| `AGENT_ATTESTATION_ORIGIN` | Origen HTTPS exacto, configurado en backend y no derivado de cabeceras externas |

El firmante rechaza el arranque experimental si falta alguna variable o la clave no es Ed25519, si `AGENT_MAX_STEPS` no vale 1 o si hay MCP. No exponer las variables por los endpoints de configuración o descubrimiento y no insertar material secreto en Git, pruebas, logs o conversaciones. Los tests usan claves efímeras inventadas localmente.

## Qué queda sin demostrar

- Que `AGENT_ATTESTATION_BACKEND_COMMIT` refleja el binario desplegado: **es una declaración operativa**, no una medición criptográfica del binario.
- Que el chat llega a la misma réplica en un despliegue real; se requiere afinidad y pruebas de infraestructura antes de cualquier inferencia.
- Que `prompt_sha256` identifica las instrucciones dinámicas/idioma/fecha agregadas en `buildAgentSystemPrompt`: identifica solamente el prompt fijo de operador.
- Que los reintentos internos y el límite de tokens producen un gasto máximo controlado. No se cambian aquí.
- Que el endpoint y su autenticación funcionan end-to-end en una instalación real. Requiere pruebas posteriores del backend con un modelo falso local y CI habilitada en un contexto aprobado.

## Plan de verificación y decisión

1. Revisar código del PR y ejecutar `bun test backend/src/hosted-agent/attestation.test.ts backend/src/hosted-agent/routes.test.ts` y typecheck del backend en un entorno con dependencias instaladas; el workflow del fork público permanece desactivado.
2. Probar con un backend de desarrollo y un `MockLanguageModelV3`, usando una clave Ed25519 temporal generada localmente. Nunca conectar a Fireworks.
3. Comprobar que la clave pública independiente valida exactamente el mismo JSON canónico del verificador de `thunderbolt-bots` PR #8 y que el `boot_id` del chat coincide.
4. Revisar autorización/rate limiting del GET, concurrencia y comportamiento en múltiples réplicas.
5. Recién después solicitar autorización separada para fusionar, desplegar o cambiar los candados LIVE. Este PR no contempla ninguna de esas acciones.
