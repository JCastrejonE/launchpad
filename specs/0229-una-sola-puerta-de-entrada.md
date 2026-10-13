---
id: 0229
title: Una sola puerta de entrada, y la compuerta es un modo de ella
tenant: launchpad
product: forge
status: completed
track: 1
requested_by: owner@example.com
found_on: 1.0.14
---

## Intent

Hay cuatro maneras de "correr el proyecto" y ninguna es obligatoria:

| hoy | qué hace | quién se acuerda |
|---|---|---|
| `scripts/preflight.sh` | servicios, `.env`, worker, web, `/api/health` | el operador |
| `scripts/gate.sh` | build, typecheck, test, specs, instrumentos, reglas | quien lo teclea |
| `runCi` | el subconjunto del coder, dentro de una corrida | el pipeline |
| `pnpm -r <algo>` | una pieza sola | cualquiera |

El 2026-08-19 construí cuatro validadores y los colgué de `gate.sh`, que **nada
dispara**: Actions está bloqueado por facturación y `runCi` deliberadamente no
llama a `gate.sh`. Es exactamente lo que el propio plan advertía en su primer
párrafo — *un lint sin dónde correr es una convención* — y lo hice igual. El dueño lo
detectó preguntando si algo de esto funcionaría.

El arreglo no es otro validador. Es que **validar sea una propiedad del único
camino que todo toma**. Es el mismo movimiento que un parámetro requerido
ganándole a una bandera opcional: la única técnica que funcionó ese día.

Y hay una segunda cosa que sólo una puerta única puede hacer: **afirmar que el
árbol que corre es el árbol que se validó.** Esa noche dije "shipped" mientras la
caja iba 17 commits atrás con tres prompts de agente sin entregar
(`docs/VERIFICATION.md` #6). La compuerta verde no dijo nada de la entrega,
porque nadie se lo preguntó.

## Scope

1. **`scripts/lp`, un despachador delgado.** NO reescribe nada:
   `preflight.sh` son 736 líneas ganadas a pulso (specs 0007/0008) y funciona.
   `lp` delega y hace que exista una sola puerta.

   | modo | qué corre | necesita servicios |
   |---|---|---|
   | `lp start` | `preflight.sh` — servicios, `.env`, worker, web | **sí** |
   | `lp gate` | `gate.sh` — la definición de verde | **no** |
   | `lp check` | el subconjunto rápido del coder | no |
   | `lp deployed <ref>` | ¿la caja corre lo que se validó? | no (sólo lee) |

2. **`lp gate` es hermético, y se prueba.** Corre con un entorno deliberadamente
   vacío — sin `DATABASE_URL`, sin `AUTH_SECRET`, sin `GITHUB_TOKEN` — y tiene que
   pasar igual. Medido el 2026-08-19: `next build` corre limpio sin variables. Si
   algún día un check necesita un servicio, esto lo detecta el día que se
   introduce, no el día que CI corre en un contenedor sin nada.
   **Es la única forma de que el aislamiento de 0227 C siga siendo cierto.**

3. **`lp check` es un SUBCONJUNTO declarado, no un atajo.** Su salida dice que es
   parcial. Un verde de `lp check` nunca se reporta como "verde" sin calificar:
   eso es la familia de la fila 1 del registro — un check que promete más de lo
   que prueba.

4. **`lp deployed <ref>`** compara `BUILD_COMMIT` y el HEAD de la caja contra un
   ref, y falla si el árbol servido no lo contiene. Convierte VERIFICATION #6 de
   una regla que olvidé en un comando.

5. **Que sea la única puerta.** `package.json` apunta a `lp`; `CLAUDE.md` nombra
   `lp gate` donde hoy nombra `gate.sh`; los scripts viejos siguen existiendo y
   `lp` los llama, pero la documentación deja de mencionarlos.

## Acceptance criteria

- `lp gate` pasa con `env -i` (entorno vacío) más lo mínimo para que corra el
  shell. Se prueba **quitándole la herméticidad**: se añade un check que lea
  `DATABASE_URL` y `lp gate` tiene que ponerse rojo.
- `lp check` es un subconjunto estricto de `lp gate`: existe un test que lo
  afirma comparando las dos listas de pasos, no la memoria de quien lo escribió.
- `lp deployed <ref>` falla contra la caja tal como está hoy (17 commits atrás) y
  pasa después de desplegar. Ese es el caso real, no uno inventado.
- `lp` sin argumentos imprime los modos y sale **2** — no elige uno por omisión.
  Un default aquí es cómo alguien corre `start` creyendo que corrió `gate`.
- `pnpm gate` sigue funcionando (es lo que CLAUDE.md pide hoy) y delega en `lp`.
- Cada modo roto una vez con `scripts/break-check.sh` donde aplique.

## Plan

**A — `scripts/lp` con los cuatro modos, delegando.** Sin lógica propia salvo el
despacho y el mensaje de uso. Termina cuando `lp gate` y `pnpm gate` dan lo mismo.

**B — la prueba de herméticidad.** `lp gate` corre con entorno vacío. Se prueba
rompiéndola: un check que lea una variable tiene que enrojecer.

**C — `lp check` y su test de subconjunto.** La lista de pasos se declara en un
solo lugar y el test compara; si alguien añade un paso a `check` que no está en
`gate`, el test falla.

**D — `lp deployed`.** Lee `BUILD_COMMIT` y el HEAD de la caja por SSH, compara
ancestría con el ref dado.

**E — dejar de documentar las otras puertas.** `package.json`, `CLAUDE.md`.

## Progress

- [x] A — `scripts/lp` con los cuatro modos, delegando. Sin argumentos sale **2** con el uso; un modo desconocido también
- [x] B — `lp gate` corre con `DATABASE_URL`/`AUTH_SECRET`/`GITHUB_TOKEN`/`TEMPORAL_ADDRESS`/
      `LAUNCHPAD_*`/tokens **quitados del entorno**. Probado quitándole la herméticidad, que es la
      única prueba que vale: con un paso que exige `DATABASE_URL` y la variable puesta en el shell,
      `gate.sh` pasa (exit 0) y `lp gate` **enrojece** (`GATE RED: needs-db`, exit 1). El scrub
      carga peso, no decora
- [x] C — `lp check` es `gate --no-web`: subconjunto estricto **por construcción**, un flag que
      omite un paso, así que no hay dos listas que puedan divergir y el test que las comparara
      sobra. Imprime que es parcial y que su verde no es "verde"
- [x] D — `lp deployed <ref>` compara el ref contra `BUILD_COMMIT`, no contra el HEAD de la caja,
      porque el 2026-08-19 divergieron. Las dos mitades observadas: a mitad del despliegue dijo
      `NO BUILD_COMMIT — cannot tell what is served` (HEAD ya movido, nada servido), y después
      `DEPLOYED`. Cerró el hueco real: `initializer.md` y `fixer.md` ya tienen la regla de idioma
      en la caja
- [x] E — `pnpm gate` es `lp gate`, y se añadieron `pnpm check` y `pnpm start`. Importa que
      `pnpm gate` pase por `lp`: si llamara a `gate.sh` directo, el camino documentado saltaría el
      scrub y la herméticidad sería opcional
- [x] Gate: `lp gate` verde (corriendo sobre sí mismo)
- [ ] (human) confirmar que el modo por omisión ausente no estorba en el uso diario

## Out of scope / deferred

- **Hacer que `runCi` llame a `lp`.** `runCi` corre en worktrees AJENOS y su
  cuerpo de plataforma es deliberadamente distinto (build sólo de `packages/*`,
  `TEMPORAL_TEST=1` con la prueba del harness de 0010). La cabecera de `gate.sh`
  ya explica por qué no se debe "unificar". **Trigger:** que el repo de la
  plataforma quiera correr su compuerta completa dentro de una corrida.
- **Ejecución de comandos entre fases** ("que el harness commitee, no el agente").
  Es el siguiente spec y es más grande: tiene que ser una transacción — correr la
  compuerta, commitear **sólo si verde**, empujar, y negarse en voz alta. Las
  filas 12 y 13 fueron el harness commiteando y no empujando, que es peor que no
  commitear. **Trigger:** este spec cerrado.
- **Contratos de formato de handoff.** Validar lo que un agente PRODUCE es como
  `specStructureViolations`. Validar lo que RECIBE implica que el harness dueñe el
  armado del prompt y se niegue a arrancar una fase con entradas malformadas —
  un cambio más grande a cómo se construyen las sesiones. **Trigger:** el spec de
  fases, que ya necesita ese control.
- **CI incremental por mapa de dependencias.** `pnpm --filter ...^...` ya da el
  grafo, así que no hace falta maquinaria nueva cuando llegue. **Trigger:** que
  `lp gate` tarde lo suficiente para que alguien lo evite.

## Handoff log

- 2026-08-19 — Escrito después de que el dueño replanteara el problema: no más
  validadores, sino que la validación sea propiedad del único camino. El orden del
  Plan pone la herméticidad segunda porque es la propiedad que mantiene vivo el
  aislamiento de 0227 C, y si se pierde se pierde en silencio.

- 2026-08-24 — el rescate de commits de spec ahora vive también en deploy-control-plane.sh,
  no sólo en deploy-here.sh. Se probó creando esta divergencia a propósito desde la caja.
