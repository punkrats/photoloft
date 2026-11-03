import { defineConfig } from '@playwright/test'

// Runs the built app in system Chromium, served by Photoloft's own
// server (which also exports videos). WebGL goes through SwiftShader,
// Chromium's software renderer, so tests never touch the GPU and behave
// the same on every machine.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 2,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1400, height: 900 },
    launchOptions: {
      executablePath: '/usr/bin/chromium',
      args: [
        '--disable-gpu',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    }
  },
  webServer: {
    command: 'python3 scripts/serve.py 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false
  }
})
