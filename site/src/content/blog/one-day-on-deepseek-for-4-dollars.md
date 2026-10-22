---
title: "One full day on DeepSeek for $4.45"
description: What a day of real coding work cost with Nib on DeepSeek V4 Flash, and why a stable prompt prefix makes the provider's cache do most of the work.
date: 2026-10-22
---

On 2026-10-12 I used Nib for a normal day of work on DeepSeek V4 Flash. The bill came to **$4.45**, including a few hours at peak pricing.

## The numbers

- **1,834** requests in the day.
- **270M** input tokens.
- **98.1%** of those input tokens were served from the provider's cache.

## Why the cache hits

Agents resend the whole conversation on every request. Providers cache the longest prefix they have already seen, and charge far less for it, but only when the new request starts with exactly the same bytes.

Nib keeps that prefix byte-stable: the system prompt and tools stay fixed, and history is only ever appended. Nothing earlier in the request gets rewritten, so the cache keeps matching as a session grows.

## Check your own

Cached tokens are what the provider reports, and providers that do not report them show 0. Run `/usage` inside Nib to see yours.
