/* E2E da janela Tauri real (WebDriverIO + provider embedded).
 * `npm run build:e2e` gera `src-tauri/target/debug/sightdeck` com o frontend
 * em `--mode e2e` (plugin WDIO no bundle); depois `npm run test:e2e`. */
export const config = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.e2e.mjs'],
  maxInstances: 1,
  capabilities: [{
    browserName: 'tauri',
    'tauri:options': { application: './src-tauri/target/debug/sightdeck' },
  }],
  services: [['@wdio/tauri-service', {
    appBinaryPath: './src-tauri/target/debug/sightdeck',
    // Servidor WebDriver embutido no app: sem tauri-driver/WebKitWebDriver externo.
    driverProvider: 'embedded',
    captureFrontendLogs: true,
    captureBackendLogs: true,
    backendLogLevel: 'info',
  }]],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120000 },
  waitforTimeout: 15000,
  connectionRetryCount: 0,
};
