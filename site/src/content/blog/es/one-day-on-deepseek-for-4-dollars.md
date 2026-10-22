---
title: "Un día entero con DeepSeek por 4,45 $"
description: Lo que costó un día de trabajo real con Nib en DeepSeek V4 Flash, y por qué un prefijo de prompt estable hace que la caché del proveedor haga casi todo el trabajo.
date: 2026-10-22
---

El 12-10-2026 usé Nib durante un día normal de trabajo con DeepSeek V4 Flash. La factura fue de **4,45 $**, incluidas unas horas a precio de hora punta.

## Las cifras

- **1.834** peticiones en el día.
- **270 M** de tokens de entrada.
- **98,1 %** de esos tokens de entrada se sirvieron desde la caché del proveedor.

## Por qué acierta la caché

Los agentes reenvían toda la conversación en cada petición. Los proveedores cachean el prefijo más largo que ya han visto y cobran mucho menos por él, pero solo cuando la nueva petición empieza exactamente con los mismos bytes.

Nib mantiene ese prefijo estable a nivel de bytes: el prompt del sistema y las herramientas no cambian, y el historial solo se va añadiendo. Nada anterior en la petición se reescribe, así que la caché sigue acertando a medida que crece la sesión.

## Compruébalo con lo tuyo

Los tokens en caché son los que informa el proveedor; los proveedores que no los informan muestran 0. Ejecuta `/usage` dentro de Nib para ver los tuyos.
