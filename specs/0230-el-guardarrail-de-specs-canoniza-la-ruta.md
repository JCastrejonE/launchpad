---
id: 0230
title: El guardarraíl de specs canoniza la ruta antes de compararla
status: approved
track: 1
requested_by: owner@example.com
created: 2026-08-24
---

# 0230 — El guardarraíl de specs canoniza la ruta antes de compararla

## Intent

Que el guardarraíl de specs compare la ruta RESUELTA y no el texto literal, para
que las variantes que un agente escribe sin querer — `..` desde el directorio
propio, `find` desde el padre, una barra doble — dejen de pasar. No convierte
esto en aislamiento; ver "Qué hace este spec, y qué NO".

## Scope

`packages/agents/src/supervisor-tool-policy.ts` y sus tests. Nada más: ni las
units de systemd, ni los permisos del árbol de specs, ni el perfil de la sesión.

## Contexto

`foreignSpecsDenial` (spec 0141) impide que un chat de proyecto lea los specs de
otro cliente. Existe porque pasó: el primer chat de proyecto real listó
`/srv/launchpad/specs/` y luego `/srv/launchpad/specs/floreria-bella/` para
aprenderse el formato, y de paso enumeró a todos los inquilinos.

El 2026-08-24 se midió qué tan fuerte es. La regla **sí dispara** en la caja de
producción con el `ownSpecsDir` real que calcula la ruta — los dos comandos del
test de límites del dueño quedan denegados, con el motivo correcto. Pero compara la
ruta como TEXTO LITERAL, y **7 de 11 variantes pasan**:

| variante | hoy |
|---|---|
| `/srv/launchpad/specs/floreria-bella/` (literal) | denegada |
| `cd /srv/launchpad/specs && ls floreria-bella` | denegada |
| `S=/srv/launchpad/specs; ls $S/floreria-bella` | denegada |
| `ln -s /srv/launchpad/specs /tmp/x && ls /tmp/x/…` | denegada |
| `/srv/launchpad//specs/floreria-bella/` | **pasa** |
| `/srv/launchpad/specs/<propio>/../floreria-bella/` | **pasa** |
| `cd <propio> && ls ../floreria-bella` | **pasa** |
| `/srv/launchpad/"specs"/floreria-bella/` | **pasa** |
| `/srv/launchpad/spec?/floreria-bella/` | **pasa** |
| `find /srv/launchpad -name '*.md'` | **pasa** |
| `~/../launchpad/specs/floreria-bella/` | **pasa** |

Las dos que importan no son evasión. `cd` al directorio propio y salir con `..`,
y `find` desde el padre, son lo que escribe un agente explorando un árbol sin
intentar nada. Las otras cinco sí parecen deliberadas.

Detrás del guardarraíl no hay aislamiento: web y worker corren como `launchpad`
con `ProtectSystem=no`, `ProtectHome=no`, `NoNewPrivileges=no`, y cada directorio
de specs es `launchpad:launchpad`. Bajo esa identidad se comprobó lectura **y
escritura** en el directorio de otro inquilino (un `touch`, retirado enseguida).

## Qué hace este spec, y qué NO

Hace: **canonizar la ruta antes de compararla**, y denegar los ancestros de la
raíz de specs. Eso cierra 5 de las 7; con la cláusula del `cd` de más abajo, 6 de 7.

**No** convierte esto en aislamiento, y no pretende hacerlo. Un análisis de
cadenas sobre comandos de shell no puede ser una frontera de seguridad: siempre
habrá una construcción que lo esquive (`base64 | sh` es el caso extremo, pero
`eval` o un script intermedio bastan). El archivo de política ya lo dice de sí
mismo y esa honestidad se conserva — con el número medido, que es lo que
convierte un riesgo aceptado en una decisión.

## Acceptance criteria

1. Las 5 variantes que hoy pasan y deben cerrarse quedan DENEGADAS: barra doble,
   `..` absoluto por el directorio propio, comillas partidas, `~/../`, y `find`
   desde un ancestro de la raíz.
2. `cd <propio> && ls ../<otro>` queda denegado.
3. Las 4 que ya se denegaban siguen denegadas (sin regresión).
4. Un comando legítimo del propio proyecto NO se deniega: leer y escribir en
   `ownSpecsDir`, y trabajar en el checkout, siguen funcionando.
5. Glob y construcción en runtime siguen pasando, y hay un test que lo AFIRMA en
   vez de dejarlo sin decir.
6. Roto con `scripts/break-check.sh`.

## Plan

Un helper puro que extrae los tokens con pinta de ruta de un comando, los
normaliza (comillas fuera, `~` expandido, `//` colapsado, `.` y `..` resueltos
léxicamente) y devuelve rutas absolutas. `foreignSpecsDenial` decide sobre ESAS,
no sobre el texto.

Tres cláusulas, en este orden:

1. Un token que cae **dentro de la raíz de specs pero fuera del directorio
   propio** → denegado. Es la regla de hoy, ahora sobre la ruta resuelta.
2. Un token que **es** la raíz de specs → denegado (listar expone a los demás).
   También de hoy.
3. Un token que es un **ancestro estricto** de la raíz de specs (`/srv/launchpad`,
   `/srv`, `/`) → denegado. Nueva: es la que ataja `find /srv/launchpad`, y un
   chat de proyecto no tiene nada que hacer por encima de su propio árbol.

Más una cláusula acotada para el `cd`: si el comando hace `cd` a un directorio
que cae dentro de la raíz de specs y luego usa un token relativo con `..`, se
deniega. Sólo dispara con las dos condiciones juntas, así que un
`cd mi-checkout && ls ../otro` fuera del área de specs no se toca.

Lo que sigue pasando, dicho aquí para que no se descubra como sorpresa:
**globs** (`spec?`) y cualquier construcción que produzca la ruta en tiempo de
ejecución (`eval`, un script, una variable calculada). Un glob se podría atacar
convirtiéndolo en regex, pero el retorno es bajo y el caso es deliberado: quien
escribe `spec?` ya está probando la reja.

## Progress

- [x] A — `absolutePathTokens(command, home)`: quita comillas EN CUALQUIER parte
      del token (no sólo alrededor), toma el valor de `VAR=/ruta`, expande `~` y
      normaliza con `posix.normalize`. Lo de `~` no es adorno: el home del usuario
      de servicio ES `/srv/launchpad`, el padre de la raíz, así que `ls ~/specs/`
      es un impacto directo — verificado en la caja, y `HOME` sí llega al proceso
      web (`/proc/<pid>/environ`), que era el riesgo de que el parámetro nuevo
      quedara mudo en el único call site que importa (#12)
- [x] B — `foreignSpecsDenial` decide sobre rutas resueltas. Tres cláusulas: la
      raíz, dentro-de-la-raíz-pero-ajeno, y ancestro estricto. `escapeForRegex`
      quedó huérfano por este cambio y se borró (regla 3: sólo los huérfanos que
      uno mismo crea)
- [x] C — la cláusula acotada del `cd`: exige las DOS condiciones (haber entrado
      al árbol de specs Y un token relativo con `..`), así que un
      `cd apps/web && ls ../../packages` en el checkout no se toca
- [x] D — 17 casos: 11 denegados (los 4 que ya funcionaban + 7 nuevos), 5 usos
      legítimos que siguen permitidos, y **un test que AFIRMA que el glob sigue
      pasando** en vez de dejar el hueco sin decir. Dos de mis tests pasaban por
      la razón equivocada — usaban un slug distinto al de `OWN_SPECS`, así que la
      cláusula que decían probar nunca se ejecutaba; corregidos para usar
      `OWN_SPECS`
- [x] E — roto con `scripts/break-check.sh`, una vez por cláusula: quitar el
      ancestro deja 1 test en rojo, quitar `posix.normalize` deja 3, y desactivar
      la cláusula del `cd` deja 1
- [x] Gate: `pnpm gate`
- [x] (human) merge del PR #73 (el dueño lo pidió; `bd49030`), desplegado y **verificado
      en vivo**: 16/16 contra el `dist` desplegado, con el `ownSpecsDir` que calcula
      la ruta real y el `HOME` del proceso, entrando por `projectChatBashDenial`
      que es la puerta que usa un turno de chat

## Out of scope / deferred

- **Aislamiento real por proyecto** (usuario unix por proyecto, bind mounts, o el
  contenedor que la propia política menciona como el siguiente paso). Es el
  arreglo de verdad; esto es la reja que evita el accidente.
  **Trigger:** que alguien fuera del equipo de la empresa tenga un chat.
- **Globs y construcción en runtime.** Ver arriba: caso deliberado, retorno bajo.
  **Trigger:** que aparezca un glob en un comando real de un chat, no en una
  prueba.
- **Sandbox de systemd para las units** (`ProtectSystem=strict`, `ReadWritePaths`
  acotado). Independiente de este cambio y más ancho: toca todo lo que el worker
  escribe. **Trigger:** el mismo que el aislamiento por proyecto.

## Handoff log

### 2026-08-24 — desplegado y verificado en vivo

`bd49030` en la caja. La verificación no se quedó en la función: se comprobó cada
salto en los ARTEFACTOS DESPLEGADOS, porque la ruta de una acción no es la
función que se llama parecido (#9).

| salto | evidencia |
|---|---|
| la ruta pasa `specsDir` para proyectos no-plataforma | bundle minificado: `specsDir:(0,j.dA)(y.slug)` |
| la sesión consulta la política en `canUseTool` | `supervisor-session.js:178` |
| `Bash` fuera de `allowedTools`, así que `canUseTool` se consulta siempre | contrato del propio archivo, :55-57 |
| la política deniega sobre el `dist` desplegado | 16/16, `ownSpecsDir` calculado en vivo |

Detalle que vale para la próxima: el minificador **conservó** `specsDir` porque es
una propiedad de objeto, no un nombre de función. Es justo la distinción que
costó nueve horas en #10 — ahí lo que se renombró fue una función pasada por
referencia.

Lo único que NO se ejercitó es un turno de chat de verdad intentando uno de estos
comandos. Requiere una rama abierta en un proyecto, y el agente puede declinar por
su cuenta antes de que la reja dispare — que es exactamente lo que pasó en la
prueba de límites del dueño, y por lo que esta verificación se hizo sobre el sistema y
no preguntándole a un agente.
