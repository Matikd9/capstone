# Procedimiento: migraciones de esquema en producción (TiDB Cloud)

Este procedimiento se sigue **antes del primer despliegue que incluya `src/db/migrate.js`** y, después, en cada despliegue que agregue una migración.
No se debe suponer que el esquema de producción coincide con la base local: hay que comprobarlo.

Ninguna migración se ejecuta en producción sin la **autorización explícita** del responsable del proyecto (paso 5).

---

## 0. Preparación

- Revisar qué migraciones trae la versión a desplegar: `ls src/db/migrations/`.
- Confirmar que todas son **compatibles con la versión anterior de la aplicación** (solo agregan tablas, columnas o índices, o amplían un tipo). Mientras se migra, la revisión anterior de Cloud Run sigue atendiendo tráfico con el esquema nuevo.
- Recomendado: un usuario de BD **de solo lectura** para las consultas de diagnóstico, creado por el responsable en la consola de TiDB Cloud:
  ```sql
  CREATE USER 'nexxo_lectura'@'%' IDENTIFIED BY '<clave generada>';
  GRANT SELECT ON web_app.* TO 'nexxo_lectura'@'%';
  ```
  Con ese usuario, `--status` no puede modificar nada aunque hubiera un error en el código.
- Las credenciales se pasan como variables de entorno en la terminal de quien ejecuta, nunca se escriben en archivos del repositorio ni en tickets.

## 1. Respaldo verificable

1. En la consola de TiDB Cloud, anotar la fecha y hora de la última copia automática del clúster y confirmar que se puede restaurar.
2. Hacer además un volcado lógico propio, con fecha, desde una máquina controlada:
   ```bash
   # Dumpling (recomendado para TiDB) o mysqldump; ambos con TLS
   tiup dumpling -h <host> -P 4000 -u <usuario> -p '<clave>' --ca <ruta-ca> -B web_app -o respaldo-web_app-AAAAMMDD
   ```
3. **Verificar el respaldo restaurándolo** en un TiDB local desechable (el mismo tipo de contenedor que se usó en las pruebas, `pingcap/tidb:v8.5.0`, publicado solo en 127.0.0.1):
   - comparar la cantidad de filas por tabla entre producción y la copia (`SELECT COUNT(*)` por tabla);
   - ejecutar los pasos 2 a 4 contra la copia y luego `node src/db/migrate.js --run` **sobre la copia**: es el ensayo general de la migración.
4. El respaldo contiene datos personales de postulantes (Ley N° 19.628): guardarlo cifrado, con acceso restringido, y borrar la copia local una vez terminado el despliegue.

## 2. Estado del esquema de producción (solo lectura)

Con el usuario de solo lectura:

```bash
NODE_ENV=production DB_HOST=<host> DB_PORT=4000 DB_USER=nexxo_lectura DB_PASSWORD='<clave>' \
DB_NAME=web_app DB_SSL=true JWT_SECRET=$(openssl rand -hex 32) \
node src/db/migrate.js --status
```

(`JWT_SECRET` solo se exige para cargar los módulos; un valor aleatorio basta y no se usa.)
`--status` solo hace `SELECT` (a `information_schema`, `schema_migrations` y `schema_migration_runs`). Informa:

- qué migraciones están aplicadas, pendientes o **interrumpidas** (con su error y el estado real de cada sentencia);
- si alguna migración aplicada fue **modificada** después;
- si la BD aún no tiene registro de migraciones: la **comparación con el baseline** (`001_baseline.sql`).

El código de salida es 1 si hay diferencias críticas, migraciones modificadas o interrupciones que requieren intervención manual.

## 3. Comparación con el baseline

La primera vez, producción no tendrá `schema_migrations`, así que `--status` compara el esquema real con el baseline:
tablas, columnas, tipos y longitudes, nulabilidad, valores por defecto, AUTO_INCREMENT, clave primaria, índices únicos y no únicos, claves foráneas (con sus reglas ON DELETE / ON UPDATE), motor, restricciones CHECK y triggers adicionales, columnas y tablas sobrantes.

Las diferencias se informan en dos grupos:

| Grupo | Ejemplos | Efecto |
| :--- | :--- | :--- |
| **CRÍTICA** | falta una tabla o columna; tipo base distinto; columna NOT NULL sin default que el baseline declara NULL; falta AUTO_INCREMENT, la clave primaria, un índice único o una clave foránea; reglas ON DELETE distintas; motor distinto | El baseline **no** se registra y la aplicación **no arranca** |
| **revisar** | longitud distinta del mismo tipo; nulabilidad más permisiva; default distinto; índice no único ausente; índices, FK, CHECK, triggers, columnas o tablas adicionales | El baseline se registra; los avisos quedan en el log |

Guardar la salida completa de `--status` junto al registro del despliegue.

## 4. Si hay diferencias inesperadas

- **Nunca** se corrige el esquema de producción "para que coincida" de forma automática.
- **Diferencias críticas**: detener el despliegue. Analizar cada una y decidir, con el responsable:
  - si producción tiene la versión correcta, ajustar `001_baseline.sql` **antes de que se haya aplicado en producción** (después ya no se puede editar) y repetir los pasos 2 y 3;
  - si producción está mal, preparar un cambio manual revisado, ensayarlo en la copia del paso 1, y aplicarlo solo con autorización explícita y con el respaldo verificado.
- **Diferencias a revisar**: leerlas una por una. Atención especial a las **columnas sobrantes NOT NULL sin valor por defecto** (como `positions.audio_prompt` en la base local de desarrollo): hacen fallar las inserciones de la aplicación en esa tabla, incluidos los datos semilla obligatorios, y el arranque se detendría.
- **Migración interrumpida** (por un despliegue anterior): `--status` indica si se puede continuar (las sentencias aplicadas forman un prefijo y se omitirán) o si requiere intervención manual. En este último caso, dejar el esquema con las sentencias aplicadas en orden (completar las faltantes o revertir las posteriores), comprobar de nuevo con `--status`, y solo entonces continuar.

## 5. Autorización y ejecución

1. Presentar al responsable: la salida de `--status`, el resultado del ensayo sobre la copia, la referencia del respaldo y la lista de migraciones que se aplicarán.
2. Con su **autorización explícita y por escrito**, ejecutar las migraciones de forma controlada, antes de desplegar la nueva revisión y con un usuario con permisos DDL:
   ```bash
   NODE_ENV=production DB_HOST=<host> DB_PORT=4000 DB_USER=<usuario_ddl> DB_PASSWORD='<clave>' \
   DB_NAME=web_app DB_SSL=true JWT_SECRET=$(openssl rand -hex 32) \
   node src/db/migrate.js --run
   ```
3. Volver a ejecutar `--status`: todo debe figurar como `baseline` o `aplicada`, sin interrupciones.
4. Desplegar la nueva revisión en Cloud Run. Al arrancar, la aplicación vuelve a revisar el esquema (no habrá pendientes) y se detiene con código 1 si algo no cuadra; en ese caso Cloud Run mantiene la revisión anterior.

## 6. Si una migración falla en producción

- La aplicación y `--run` se detienen con un mensaje que indica la migración, la sentencia y el error. La migración no queda registrada; su avance queda en `schema_migration_runs`.
- El DDL no es transaccional: las sentencias anteriores a la que falló quedan aplicadas. Al reintentar, el ejecutor verifica el esquema real y **no repite** las sentencias ya aplicadas.
- No hay "deshacer" automático. Las opciones son: corregir la causa y reintentar (la migración no registrada puede corregirse), aplicar una migración correctiva nueva, o restaurar el respaldo del paso 1.
