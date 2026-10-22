---
title: "Ein ganzer Tag mit DeepSeek für 4,45 $"
description: Was ein Tag echter Programmierarbeit mit Nib auf DeepSeek V4 Flash gekostet hat und warum ein stabiles Prompt-Präfix den Provider-Cache die meiste Arbeit erledigen lässt.
date: 2026-10-22
---

Am 12.10.2026 habe ich Nib einen normalen Arbeitstag lang mit DeepSeek V4 Flash benutzt. Die Rechnung lag bei **4,45 $**, inklusive einiger Stunden zum Spitzentarif.

## Die Zahlen

- **1.834** Anfragen an diesem Tag.
- **270 Mio.** Input-Tokens.
- **98,1 %** dieser Input-Tokens kamen aus dem Cache des Providers.

## Warum der Cache greift

Agenten senden bei jeder Anfrage die gesamte Unterhaltung erneut. Provider cachen das längste Präfix, das sie schon gesehen haben, und berechnen dafür deutlich weniger, aber nur, wenn die neue Anfrage mit exakt denselben Bytes beginnt.

Nib hält dieses Präfix byte-stabil: Systemprompt und Tools bleiben fest, und der Verlauf wird nur angehängt. Nichts Früheres in der Anfrage wird umgeschrieben, deshalb passt der Cache weiter, während eine Sitzung wächst.

## Prüf es selbst

Gecachte Tokens sind das, was der Provider meldet; Provider, die sie nicht melden, zeigen 0. Mit `/usage` in Nib siehst du deine Werte.
