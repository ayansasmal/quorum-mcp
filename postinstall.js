#!/usr/bin/env node
// Thin dispatcher for npm postinstall lifecycle.
// Redirects to dist/postinstall.js (bundled) if it exists, otherwise exits 0.
// This file stays at package root so it's available before build in dev.
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundled = join(__dirname, 'dist', 'postinstall.js')

if (!existsSync(bundled)) {
  // Pre-build dev install — nothing to do
  process.exit(0)
}

const result = spawnSync('node', [bundled], { stdio: 'inherit', env: process.env })
process.exit(result.status ?? 0)
